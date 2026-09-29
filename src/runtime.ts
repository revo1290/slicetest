import path from "node:path";
import pg from "pg";
import { App } from "./app.js";
import type { ResolvedOptions } from "./config.js";
import { Db, formatChanges, withDatabase } from "./db.js";
import { formatHistory, HttpClient } from "./http.js";
import { Stub } from "./stub.js";

export interface ScenarioContext {
  http: HttpClient;
  db: Db;
  stub: (name: string) => Stub;
  app: App;
}

/** Everything one test file needs: its own database, stub servers and app process. */
export class Runtime {
  #logMark = 0;
  #http: HttpClient;

  private constructor(
    public app: App,
    readonly db: Db,
    readonly stubs: Map<string, Stub>,
    private readonly opts: ResolvedOptions,
    private readonly vars: Record<string, string>,
  ) {
    this.#http = new HttpClient(app.url, opts.http);
  }

  get http() {
    return this.#http;
  }

  static async start(opts: ResolvedOptions, shared: { adminUrl: string; template: string; prefix: string }) {
    const url = await ensureWorkerDatabase(shared.adminUrl, shared.template, shared.prefix);
    const stubs = new Map<string, Stub>();
    let db: Db | undefined;
    try {
      for (const name of opts.stubs) stubs.set(name, await Stub.start(name));
      db = await Db.connect(url, {
        schemas: opts.db.schemas,
        keep: opts.db.keep,
        seedFile: opts.db.seed && path.resolve(opts.root, opts.db.seed),
      });
      const vars: Record<string, string> = { "db.url": url };
      for (const [name, stub] of stubs) vars[`stub.${name}`] = stub.url;
      const app = await App.start(opts.app, opts.root, vars);
      return new Runtime(app, db, stubs, opts, vars);
    } catch (e) {
      await db?.close();
      await Promise.all([...stubs.values()].map((s) => s.close()));
      throw e;
    }
  }

  context(): ScenarioContext {
    return {
      http: this.http,
      db: this.db,
      app: this.app,
      stub: (name) => {
        const stub = this.stubs.get(name);
        if (!stub) {
          throw new Error(`slicetest: unknown stub "${name}". Declared stubs: ${[...this.stubs.keys()].join(", ") || "(none)"}`);
        }
        return stub;
      },
    };
  }

  async beforeScenario() {
    // A crash already failed the scenario that caused it; give the next one a fresh app.
    if (this.app.exited) {
      await this.app.stop();
      this.app = await App.start(this.opts.app, this.opts.root, this.vars);
      this.#http = new HttpClient(this.app.url, this.opts.http);
    }
    await this.db.reset();
    for (const stub of this.stubs.values()) stub.reset();
    this.http.reset();
    this.#logMark = this.app.mark();
  }

  /** Failures that the scenario body can't see on its own. */
  async afterScenario() {
    await this.app.settle();
    this.#assertAlive();
    const unmatched = this.#unmatched();
    if (unmatched.length > 0) {
      throw new Error(`slicetest: the app called stubbed services with no matching route:\n${unmatched.join("\n")}`);
    }
  }

  #unmatched() {
    return [...this.stubs.values()].flatMap((s) => {
      const calls = s.unmatched();
      if (calls.length === 0) return [];
      const routes = s.describeRoutes();
      return [
        ...calls.map((c) => `  ${s.name}: ${c.method} ${c.path}${c.query.size ? `?${c.query}` : ""}`),
        `    registered on ${s.name}: ${routes.length ? routes.join(", ") : "(none)"}`,
      ];
    });
  }

  /** What happened during the current scenario, printed when it fails. */
  async diagnostics() {
    const sections: string[] = [];
    const exit = this.app.exited;
    if (exit) sections.push(`the app exited (code ${exit.code}, signal ${exit.signal}); it will be restarted for the next scenario`);
    const unmatched = this.#unmatched();
    if (unmatched.length > 0) sections.push(`stub calls with no matching route:\n${unmatched.join("\n")}`);
    if (this.http.history.length > 0) sections.push(`requests to the app:\n${formatHistory(this.http.history)}`);
    try {
      const changes = formatChanges(await this.db.changesSinceStart());
      sections.push(changes ? `database changes during this scenario:\n${changes}` : "database changes during this scenario: (none)");
    } catch (e) {
      sections.push(`database changes during this scenario: unavailable (${(e as Error).message})`);
    }
    const logs = this.app.logs(this.#logMark);
    sections.push(logs ? `app output during this scenario:\n${logs}` : "app output during this scenario: (none)");
    return sections.join("\n\n");
  }

  async stop() {
    const results = await Promise.allSettled([
      this.app.stop(),
      this.db.close(),
      ...[...this.stubs.values()].map((s) => s.close()),
    ]);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  }

  #assertAlive() {
    const exit = this.app.exited;
    if (exit) {
      throw new Error(`slicetest: app process exited (code ${exit.code}, signal ${exit.signal})\n${this.app.logs()}`);
    }
  }
}

/** One database per vitest worker, cloned from the migrated template and reused across its test files. */
async function ensureWorkerDatabase(adminUrl: string, template: string, prefix: string) {
  const name = `${prefix}_w${process.env.VITEST_POOL_ID ?? process.pid}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!rowCount) await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  } finally {
    await admin.end();
  }
  return withDatabase(adminUrl, name);
}
