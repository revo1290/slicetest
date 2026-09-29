import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { App } from "./app.js";
import type { ResolvedOptions } from "./config.js";
import { Db, formatChanges, withDatabase } from "./db.js";
import { formatHistory, HttpClient, type HttpResponse } from "./http.js";
import { OpenApiSpec } from "./openapi.js";
import { Stub, type RecordedCall } from "./stub.js";

export interface ScenarioContext {
  http: HttpClient;
  db: Db;
  stub: (name: string) => Stub;
  app: App;
  /** A process from the `services` option: its `url`, `logs()` and `waitForLog()`. */
  service: (name: string) => App;
}

/** Everything one test file needs: its own database, stub servers and app process. */
export class Runtime {
  #http: HttpClient;
  /** Responses from the app that don't match its OpenAPI spec, this scenario. */
  #contract: string[] = [];
  /** Documented responses seen in this file, for the run's coverage report. */
  #covered = new Set<string>();

  private constructor(
    public app: App,
    readonly services: Map<string, App>,
    readonly db: Db,
    readonly stubs: Map<string, Stub>,
    private readonly opts: ResolvedOptions,
    private readonly vars: Record<string, string>,
    private readonly specs: { app?: OpenApiSpec; stubs: Map<string, OpenApiSpec> },
    private readonly coverageDir?: string,
  ) {
    this.#http = this.#client();
  }

  #client() {
    const http = new HttpClient(this.app.url, this.opts.http);
    const spec = this.specs.app;
    if (spec) {
      http.onResponse((res) => {
        try {
          const path = res.url.split("?")[0]!;
          const key = spec.responseKey(res.method, path, res.status);
          if (key) this.#covered.add(key);
          this.#contract.push(...spec.checkResponse(res.method, path, message(res)));
        } catch (e) {
          this.#contract.push(`${res.method} ${res.url}: couldn't check against ${spec.file}: ${(e as Error).message}`);
        }
      });
    }
    return http;
  }

  get http() {
    return this.#http;
  }

  static async start(opts: ResolvedOptions, shared: { adminUrl: string; template: string; prefix: string; coverageDir?: string }) {
    const url = await ensureWorkerDatabase(shared.adminUrl, shared.template, shared.prefix);
    const stubs = new Map<string, Stub>();
    const services = new Map<string, App>();
    let db: Db | undefined;
    try {
      // Loaded first: a broken spec should fail before anything is started.
      const specs = {
        app: opts.openapi.app ? await OpenApiSpec.load(path.resolve(opts.root, opts.openapi.app), opts.openapi.app) : undefined,
        stubs: new Map<string, OpenApiSpec>(),
      };
      for (const [name, file] of Object.entries(opts.openapi.stubs)) specs.stubs.set(name, await OpenApiSpec.load(path.resolve(opts.root, file), file));
      for (const name of opts.stubs) stubs.set(name, await Stub.start(name));
      for (const name of opts.openapi.autoReply) {
        const spec = specs.stubs.get(name)!;
        stubs.get(name)!.fallback((call) => spec.exampleResponse(call.method, call.path));
      }
      db = await Db.connect(url, {
        schemas: opts.db.schemas,
        keep: opts.db.keep,
        seedFile: opts.db.seed && path.resolve(opts.root, opts.db.seed),
      });
      const vars: Record<string, string> = { "db.url": url };
      for (const [name, stub] of stubs) vars[`stub.${name}`] = stub.url;
      for (const [name, service] of Object.entries(opts.services)) {
        const started = await App.start(service, opts.root, vars, `service.${name}`);
        services.set(name, started);
        vars[`service.${name}`] = started.url;
        vars[`service.${name}.port`] = String(started.port);
      }
      const app = await App.start(opts.app, opts.root, vars);
      return new Runtime(app, services, db, stubs, opts, vars, specs, shared.coverageDir);
    } catch (e) {
      await Promise.all([...services.values()].map((s) => s.stop()));
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
      service: (name) => {
        const service = this.services.get(name);
        if (!service) {
          throw new Error(`slicetest: unknown service "${name}". Declared services: ${[...this.services.keys()].join(", ") || "(none)"}`);
        }
        return service;
      },
    };
  }

  /** The app and every service, for checks that apply to all of them. */
  #processes() {
    return [this.app, ...this.services.values()];
  }

  async beforeScenario() {
    // A crash already failed the scenario that caused it; give the next one a fresh process.
    for (const [name, service] of this.services) {
      if (!service.exited) continue;
      await service.stop();
      this.services.set(name, await App.start(this.opts.services[name]!, this.opts.root, this.vars, `service.${name}`, service.port));
    }
    if (this.app.exited) {
      await this.app.stop();
      this.app = await App.start(this.opts.app, this.opts.root, this.vars);
      this.#http = this.#client();
    }
    this.#contract = [];
    await this.db.reset();
    for (const stub of this.stubs.values()) stub.reset();
    this.http.reset();
    for (const p of this.#processes()) p.beginScenario();
  }

  /** Failures that the scenario body can't see on its own. */
  async afterScenario() {
    await Promise.all(this.#processes().map((p) => p.settle()));
    this.#assertAlive();
    const unmatched = this.#unmatched();
    if (unmatched.length > 0) {
      throw new Error(`slicetest: the app called stubbed services with no matching route:\n${unmatched.join("\n")}`);
    }
    const contract = this.#contractViolations();
    if (contract.length > 0) {
      throw new Error(`slicetest: traffic doesn't match the OpenAPI spec:\n${contract.map((c) => `  ${c}`).join("\n")}`);
    }
  }

  /** The app's responses against its spec, and its calls to stubs (and the stubs' replies) against theirs. */
  #contractViolations() {
    const out = this.#contract.map((c) => `app: ${c}`);
    for (const [name, spec] of this.specs.stubs) {
      for (const call of this.stubs.get(name)!.calls()) {
        try {
          out.push(...this.#checkStubCall(name, spec, call));
        } catch (e) {
          out.push(`app → ${name}: ${call.method} ${call.path}: couldn't check against ${spec.file}: ${(e as Error).message}`);
        }
      }
    }
    return [...new Set(out)];
  }

  #checkStubCall(name: string, spec: OpenApiSpec, call: RecordedCall) {
    if (!call.matched) return []; // already reported as an unmatched call
    const req = { contentType: header(call.headers["content-type"]), body: call.json ?? call.body, query: call.query };
    const out = spec.checkRequest(call.method, call.path, req).map((c) => `app → ${name}: ${c}`);
    const res = call.response;
    if (res) {
      const body = res.body ? (parseJson(res.body) ?? res.body) : "";
      const problems = spec.checkResponse(call.method, call.path, { status: res.status, contentType: res.headers["content-type"], body });
      out.push(...problems.map((c) => `stub ${name} reply (the real service wouldn't answer this way): ${c}`));
    }
    return out;
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
    for (const p of this.#processes()) {
      const exit = p.exited;
      if (exit) sections.push(`the ${p.label} exited (code ${exit.code}, signal ${exit.signal}); it will be restarted for the next scenario`);
    }
    const unmatched = this.#unmatched();
    if (unmatched.length > 0) sections.push(`stub calls with no matching route:\n${unmatched.join("\n")}`);
    const contract = this.#contractViolations();
    if (contract.length > 0) sections.push(`OpenAPI mismatches:\n${contract.map((c) => `  ${c}`).join("\n")}`);
    if (this.http.history.length > 0) sections.push(`requests to the app:\n${formatHistory(this.http.history)}`);
    try {
      const changes = formatChanges(await this.db.changesSinceStart());
      sections.push(changes ? `database changes during this scenario:\n${changes}` : "database changes during this scenario: (none)");
    } catch (e) {
      sections.push(`database changes during this scenario: unavailable (${(e as Error).message})`);
    }
    const logs = this.app.scenarioLogs();
    sections.push(logs ? `app output during this scenario:\n${logs}` : "app output during this scenario: (none)");
    for (const [name, service] of this.services) {
      const out = service.scenarioLogs();
      sections.push(out ? `service ${name} output during this scenario:\n${out}` : `service ${name} output during this scenario: (none)`);
    }
    return sections.join("\n\n");
  }

  async stop() {
    if (this.coverageDir && this.#covered.size > 0) {
      await writeFile(path.join(this.coverageDir, `${process.pid}-${randomUUID()}.json`), JSON.stringify([...this.#covered])).catch(() => {});
    }
    const results = await Promise.allSettled([
      this.app.stop(),
      ...[...this.services.values()].map((s) => s.stop()),
      this.db.close(),
      ...[...this.stubs.values()].map((s) => s.close()),
    ]);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  }

  #assertAlive() {
    for (const p of this.#processes()) {
      const exit = p.exited;
      if (exit) throw new Error(`slicetest: ${p.label} process exited (code ${exit.code}, signal ${exit.signal})\n${p.logs()}`);
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

function message(res: HttpResponse) {
  return { status: res.status, contentType: res.headers.get("content-type") ?? undefined, body: res.json ?? res.text };
}

function header(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
