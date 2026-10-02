import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { App } from "./app.js";
import { Issuer } from "./auth.js";
import type { ResolvedOptions } from "./config.js";
import { Dependency } from "./containers.js";
import { connectionVars } from "./connection.js";
import { Db, formatChanges, noDatabase } from "./db.js";
import { diagramPage, failureDiagram, sequenceDiagram } from "./diagram.js";
import { appendSummary } from "./ci.js";
import { engineFor, type Engine } from "./drivers/index.js";
import { formatHistory, HttpClient, type HttpResponse } from "./http.js";
import { Interceptor } from "./intercept.js";
import { Mailbox } from "./mail.js";
import { NEON_DOMAIN, NeonEndpoint, neonUrl } from "./neon.js";
import { appSpecFile, OpenApiSpec } from "./openapi.js";
import { QueryLog } from "./query-log.js";
import { Recorder } from "./recording.js";
import { Stub, type RecordedCall } from "./stub.js";
import { buildTrace, mask, type MaskOptions, type Trace } from "./trace.js";

export interface ScenarioContext {
  http: HttpClient;
  db: Db;
  stub: (name: string) => Stub;
  app: App;
  /** A process from the `services` option: its `url`, `logs()` and `waitForLog()`. */
  service: (name: string) => App;
  /** A container from the `containers` option: its `host`, `port`, `address` and `exec()`. */
  container: (name: string) => Dependency;
  /**
   * What the scenario did so far: requests to the app, calls to stubs and database changes,
   * with timestamps and UUIDs masked. `expect(await trace()).toMatchSnapshot()`.
   */
  trace: (opts?: MaskOptions) => Promise<Trace>;
  /** The scenario so far as a Mermaid sequence diagram: requests, stub calls, mail and changed tables. */
  diagram: () => Promise<string>;
  /** Mail the app sent during the scenario. Needs `mail: true` in the config. */
  mail: Mailbox;
  /** The OpenID Connect issuer the app trusts: `auth.token(claims)`. Needs `auth` in the config. */
  auth: Issuer;
}

/** Everything one test file needs: its own database, stub servers and app process. */
export class Runtime {
  #http: HttpClient;
  /** Responses from the app that don't match its OpenAPI spec, this scenario. */
  #contract: string[] = [];
  /** Documented responses seen in this file, for the run's coverage report. */
  #covered = new Set<string>();
  /** Operations of stubbed providers (with an `openapi` spec) the app called, per stub, for the usage report. */
  #used = new Map<string, Set<string>>();

  private constructor(
    public app: App,
    readonly services: Map<string, App>,
    readonly db: Db,
    readonly stubs: Map<string, Stub>,
    private readonly opts: ResolvedOptions,
    private readonly vars: Record<string, string>,
    private readonly specs: { app?: OpenApiSpec; stubs: Map<string, OpenApiSpec> },
    private readonly coverageDir?: string,
    private readonly recorders = new Map<string, Recorder>(),
    private readonly recordDir?: string,
    readonly containers = new Map<string, Dependency>(),
    readonly mailbox?: Mailbox,
    readonly issuer?: Issuer,
    readonly queryLog?: QueryLog,
    readonly interceptor?: Interceptor,
    readonly neon?: NeonEndpoint,
  ) {
    this.#http = this.#client();
  }

  #client() {
    const http = new HttpClient(this.app.url, this.opts.http);
    for (const [host, name] of Object.entries(this.opts.intercept)) http.intercept(host, this.stubs.get(name)!.url);
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

  static async start(opts: ResolvedOptions, shared: { adminUrl: string; template: string; prefix: string; coverageDir?: string; recordDir?: string; usageDir?: string }) {
    const engine = opts.db.none ? undefined : await engineFor(opts);
    const url = engine ? await ensureWorkerDatabase(engine, shared.adminUrl, shared.template, shared.prefix) : "";
    const stubs = new Map<string, Stub>();
    const recorders = new Map<string, Recorder>();
    const containers = new Map<string, Dependency>();
    const services = new Map<string, App>();
    let db: Db | undefined;
    let mailbox: Mailbox | undefined;
    let issuer: Issuer | undefined;
    let queryLog: QueryLog | undefined;
    let interceptor: Interceptor | undefined;
    let neon: NeonEndpoint | undefined;
    try {
      // Loaded first: a broken spec should fail before anything is started.
      const specs = {
        app: opts.openapi.app ? await OpenApiSpec.load(path.resolve(opts.root, opts.openapi.app), opts.openapi.app) : undefined,
        stubs: new Map<string, OpenApiSpec>(),
      };
      for (const [name, file] of Object.entries(opts.openapi.stubs)) specs.stubs.set(name, await OpenApiSpec.load(path.resolve(opts.root, file), file));
      for (const name of opts.stubs) stubs.set(name, await Stub.start(name));
      for (const [name, r] of Object.entries(opts.recordings)) recorders.set(name, await Recorder.load(name, path.resolve(opts.root, r.file), r.upstream, r.record));
      // A registered route wins, then a recording of the real service, then an answer made up from its spec.
      for (const [name, stub] of stubs) {
        const recorder = recorders.get(name);
        const spec = opts.openapi.autoReply.includes(name) ? specs.stubs.get(name) : undefined;
        if (!recorder && !spec) continue;
        stub.fallback(async (call) => (await recorder?.answer(call)) ?? spec?.exampleResponse(call.method, call.path), recorder?.hint());
      }
      db = engine
        ? await Db.connect(await engine.driver(url), url, {
            schemas: opts.db.schemas,
            keep: opts.db.keep,
            seedFile: opts.db.seed && path.resolve(opts.root, opts.db.seed),
          })
        : noDatabase();
      const started = await Promise.allSettled(Object.entries(opts.containers).map(async ([name, c]) => containers.set(name, await Dependency.start(name, c))));
      const failed = started.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
      const vars: Record<string, string> = engine ? { "db.url": url } : {};
      if (engine && opts.db.queries && engine.name !== "sqlite") {
        const u = new URL(url);
        queryLog = await QueryLog.start(engine.name as "postgres" | "mysql", { host: u.hostname, port: Number(u.port || (engine.name === "mysql" ? 3306 : 5432)) });
        vars["db.url"] = queryLog.proxyUrl(url);
        db.attachQueryLog(queryLog);
      }
      if (engine?.name === "sqlite") vars["db.path"] = (await import("./drivers/sqlite.js")).sqlitePath(url);
      if (engine) Object.assign(vars, connectionVars(engine.name, vars["db.url"]!, vars["db.path"]));
      if (opts.db.neon) {
        // Queries the app sends to Neon's HTTP API run on the worker database (through the db.queries proxy, if on).
        neon = await NeonEndpoint.start(vars["db.url"]!);
        vars["db.url"] = neonUrl(url);
      }
      if (opts.mail) {
        mailbox = await Mailbox.start();
        Object.assign(vars, { "mail.host": mailbox.host, "mail.port": String(mailbox.port), "mail.url": mailbox.url });
      }
      if (opts.auth) {
        issuer = await Issuer.start(opts.auth);
        Object.assign(vars, { "auth.issuer": issuer.url, "auth.jwks": issuer.jwksUrl, "auth.audience": issuer.audience, "auth.publicKey": issuer.publicKeyPem });
      }
      for (const [name, c] of containers) {
        vars[`container.${name}`] = c.address;
        vars[`container.${name}.host`] = c.host;
        vars[`container.${name}.port`] = String(c.port);
      }
      for (const [name, stub] of stubs) vars[`stub.${name}`] = stub.url;
      if (Object.keys(opts.intercept).length > 0 || opts.offline || neon) {
        const routes = new Map(Object.entries(opts.intercept).map(([host, name]) => {
          const stub = stubs.get(name)!;
          return [host, { attach: (s: import("node:net").Socket) => stub.attach(s), port: stub.port }];
        }));
        if (neon) {
          const endpoint = neon;
          routes.set(`*.${NEON_DOMAIN}`, { attach: (s) => endpoint.attach(s), port: endpoint.port });
        }
        interceptor = await Interceptor.start(routes);
        interceptor.offline = opts.offline;
        Object.assign(vars, { "proxy.url": interceptor.url, "proxy.ca": interceptor.files.ca, "proxy.bundle": interceptor.files.bundle, "proxy.truststore": interceptor.files.trustStore });
        // Every process gets the proxy settings; a key in its own `env` still wins.
        const baseEnv = interceptor.env();
        opts = { ...opts, app: { ...opts.app, baseEnv }, services: Object.fromEntries(Object.entries(opts.services).map(([n, s]) => [n, { ...s, baseEnv }])) };
      }
      for (const [name, service] of Object.entries(opts.services)) {
        const started = await App.start(service, opts.root, vars, `service.${name}`);
        services.set(name, started);
        vars[`service.${name}`] = started.url;
        vars[`service.${name}.port`] = String(started.port);
      }
      const app = await App.start(opts.app, opts.root, vars);
      if (opts.openapi.fromApp) specs.app = await fetchAppSpec(app.url, opts.openapi.fromApp, shared.coverageDir);
      const runtime = new Runtime(app, services, db, stubs, opts, vars, specs, shared.coverageDir, recorders, shared.recordDir, containers, mailbox, issuer, queryLog, interceptor, neon);
      runtime.#usageDir = shared.usageDir;
      return runtime;
    } catch (e) {
      await Promise.all([...services.values()].map((s) => s.stop()));
      await db?.close();
      await Promise.all([...stubs.values()].map((s) => s.close()));
      await Promise.allSettled([...containers.values()].map((c) => c.stop()));
      await mailbox?.close();
      await issuer?.close();
      await queryLog?.close();
      if (interceptor?.blocked.size && e instanceof Error) e.message += `\n${blockedHint([...interceptor.blocked])}`;
      await interceptor?.close();
      await neon?.close();
      throw e;
    }
  }

  context(): ScenarioContext {
    const mailbox = this.mailbox;
    const issuer = this.issuer;
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
      container: (name) => {
        const c = this.containers.get(name);
        if (!c) throw new Error(`slicetest: unknown container "${name}". Declared containers: ${[...this.containers.keys()].join(", ") || "(none)"}`);
        return c;
      },
      trace: async (opts) => mask(buildTrace(this.http.history, this.stubs.values(), await this.db.changesSinceStart(), this.mailbox), opts),
      diagram: () => this.diagram(),
      get mail(): Mailbox {
        if (!mailbox) throw new Error("slicetest: mail is off. Add `mail: true` to the config and point the app's SMTP settings at {{mail.host}} / {{mail.port}}.");
        return mailbox;
      },
      get auth(): Issuer {
        if (!issuer) throw new Error("slicetest: auth is off. Add `auth: true` to the config and point the app's JWT settings at {{auth.issuer}} / {{auth.jwks}}.");
        return issuer;
      },
    };
  }

  /** The app and every service, for checks that apply to all of them. */
  #processes() {
    return [this.app, ...this.services.values()];
  }

  #usageDir?: string;

  /** Note which provider operations the stubs were called for, before their calls are cleared. */
  #collectUsage() {
    for (const [name, spec] of this.specs.stubs) {
      const used = this.#used.get(name) ?? new Set<string>();
      for (const call of this.stubs.get(name)!.calls()) {
        const op = spec.operationOf(call.method, call.path);
        if (op) used.add(op.key);
      }
      if (used.size) this.#used.set(name, used);
    }
  }

  async beforeScenario() {
    this.#collectUsage();
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
    for (const recorder of this.recorders.values()) recorder.reset();
    this.mailbox?.reset();
    this.issuer?.reset();
    this.queryLog?.reset();
    this.interceptor?.passedThrough.clear();
    this.interceptor?.blocked.clear();
    await Promise.all([...this.containers.values()].map((c) => c.reset()));
    this.http.reset();
    for (const p of this.#processes()) p.beginScenario();
  }

  /** Failures that the scenario body can't see on its own. */
  async afterScenario() {
    await Promise.all(this.#processes().map((p) => p.settle()));
    this.#assertAlive();
    if (this.interceptor?.blocked.size) throw new Error(blockedHint([...this.interceptor.blocked]));
    const unmatched = this.#unmatched();
    if (unmatched.length > 0) {
      throw new Error(`slicetest: the app called stubbed services with no matching route:\n${unmatched.join("\n")}`);
    }
    const contract = this.#contractViolations();
    if (contract.length > 0) {
      throw new Error(`slicetest: traffic doesn't match the OpenAPI spec:\n${contract.map((c) => `  ${c}`).join("\n")}`);
    }
    const unused = this.#unusedRoutes();
    if (this.opts.strictStubs && unused.length > 0) {
      throw new Error(
        `slicetest: stub routes the app never called (strictStubs):\n${unused.join("\n")}\n` +
          "Remove them, check that the scenario reaches the code that calls them, or mark them .optional() (YAML: optional: true).",
      );
    }
  }

  #unusedRoutes() {
    return [...this.stubs.values()].flatMap((s) => s.unusedRoutes().map((r) => `  ${s.name}: ${r}`));
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
        ...calls.flatMap((c) => {
          const why = s.explain(c);
          return [`  ${s.name}: ${c.method} ${c.path}${c.query.size ? `?${c.query}` : ""}`, ...(why ? [`    ${why}`] : [])];
        }),
        `    registered on ${s.name}: ${routes.length ? routes.join(", ") : "(none)"}`,
        ...(this.recorders.has(s.name) ? [`    ${this.recorders.get(s.name)!.hint()}`] : []),
      ];
    });
  }

  /** The current scenario as a Mermaid sequence diagram. */
  async diagram() {
    const changes = this.opts.db.none ? undefined : await this.db.changesSinceStart().catch(() => undefined);
    return sequenceDiagram(this.http.history, this.stubs.values(), changes, this.mailbox);
  }

  /**
   * After a scenario: its diagram goes to the `SLICETEST_DIAGRAMS` directory (one Markdown page
   * per test file) and, when it failed on GitHub Actions, to the job summary.
   */
  async reportDiagram(file: string, scenario: string, failed: boolean, env = process.env) {
    const dir = env.SLICETEST_DIAGRAMS;
    const summary = failed && env.GITHUB_STEP_SUMMARY;
    if (!dir && !summary) return;
    let diagram: string;
    try {
      diagram = await this.diagram();
    } catch {
      return;
    }
    const rel = path.relative(this.opts.root, file).replace(/\\/g, "/");
    if (summary) await appendSummary(failureDiagram(rel, scenario, diagram), env);
    if (dir) {
      const out = path.resolve(this.opts.root, dir, `${rel.replace(/^(\.\.\/)+/, "")}.md`);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, diagramPage(out, rel, scenario, diagram, failed)).catch(() => {});
    }
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
    const unused = this.#unusedRoutes();
    if (unused.length > 0) sections.push(`stub routes the app never called:\n${unused.join("\n")}`);
    const chaos = [...this.stubs.values()].map((s) => s.describeChaos()).filter((c) => c !== undefined);
    if (chaos.length > 0) sections.push(chaos.join("\n"));
    const contract = this.#contractViolations();
    if (contract.length > 0) sections.push(`OpenAPI mismatches:\n${contract.map((c) => `  ${c}`).join("\n")}`);
    if (this.http.history.length > 0) sections.push(`requests to the app:\n${formatHistory(this.http.history)}`);
    if (!this.opts.db.none) try {
      const changes = formatChanges(await this.db.changesSinceStart());
      sections.push(changes ? `database changes during this scenario:\n${changes}` : "database changes during this scenario: (none)");
    } catch (e) {
      sections.push(`database changes during this scenario: unavailable (${(e as Error).message})`);
    }
    if (this.mailbox) sections.push(this.mailbox.describe());
    if (this.interceptor?.passedThrough.size) {
      sections.push(`outbound calls to hosts no stub intercepts (sent to the real host; add them to a stub's \`hosts\` to answer them):\n${[...this.interceptor.passedThrough].map((h) => `  ${h}`).join("\n")}`);
    }
    if (this.queryLog) {
      const q = this.queryLog.queries();
      const top = q.shapes().slice(0, 5).map((s) => `  ${s.count > 1 ? `×${s.count} ` : ""}${s.sql.length > 160 ? `${s.sql.slice(0, 157)}...` : s.sql}`);
      sections.push(q.length ? `SQL the app ran during this scenario (${q.length} statements, most frequent first):\n${top.join("\n")}` : "SQL the app ran during this scenario: (none)");
    }
    const logs = this.app.scenarioLogs();
    sections.push(logs ? `app output during this scenario:\n${logs}` : "app output during this scenario: (none)");
    for (const [name, service] of this.services) {
      const out = service.scenarioLogs();
      sections.push(out ? `service ${name} output during this scenario:\n${out}` : `service ${name} output during this scenario: (none)`);
    }
    return sections.join("\n\n");
  }

  /** Hand the coverage and recordings gathered so far to the run (merged when it ends). */
  async flush() {
    this.#collectUsage();
    if (this.#usageDir && this.#used.size > 0) {
      const data = Object.fromEntries([...this.#used].map(([k, v]) => [k, [...v]]));
      await writeFile(path.join(this.#usageDir, `${process.pid}-${randomUUID()}.json`), JSON.stringify(data)).catch(() => {});
      this.#used.clear();
    }
    if (this.coverageDir && this.#covered.size > 0) {
      await writeFile(path.join(this.coverageDir, `${process.pid}-${randomUUID()}.json`), JSON.stringify([...this.#covered])).catch(() => {});
      this.#covered.clear();
    }
    for (const [name, recorder] of this.recorders) {
      const added = recorder.added().splice(0);
      if (this.recordDir && added.length > 0) {
        await writeFile(path.join(this.recordDir, `${name}.${process.pid}-${randomUUID()}.json`), JSON.stringify(added)).catch(() => {});
      }
    }
  }

  async stop() {
    await this.flush();
    const results = await Promise.allSettled([
      this.app.stop(),
      ...[...this.services.values()].map((s) => s.stop()),
      this.db.close(),
      ...[...this.stubs.values()].map((s) => s.close()),
      ...[...this.containers.values()].map((c) => c.stop()),
      this.mailbox?.close(),
      this.issuer?.close(),
      this.queryLog?.close(),
      this.interceptor?.close(),
      this.neon?.close(),
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
async function ensureWorkerDatabase(engine: Engine, adminUrl: string, template: string, prefix: string) {
  const name = `${prefix}_w${process.env.VITEST_POOL_ID ?? process.pid}`;
  const admin = await engine.admin(adminUrl);
  try {
    if (!(await admin.databases(name)).includes(name)) await admin.clone(template, name);
    return admin.urlFor(name);
  } finally {
    await admin.close();
  }
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

/** The app's own spec, served at `route` (springdoc's /v3/api-docs, FastAPI's /openapi.json, …). */
async function fetchAppSpec(appUrl: string, route: string, coverageDir?: string) {
  let text: string;
  try {
    const res = await fetch(new URL(route, appUrl));
    if (!res.ok) throw new Error(`it answered ${res.status}`);
    text = await res.text();
  } catch (e) {
    throw new Error(`slicetest: openapi.fromApp: couldn't get the spec from GET ${route}: ${(e as Error).message}`);
  }
  const file = coverageDir ? appSpecFile(coverageDir) : path.join(os.tmpdir(), `slicetest-spec-${process.pid}.json`);
  await writeFile(file, text);
  return OpenApiSpec.load(file, `GET ${route}`);
}

/** Hosts package managers download from: a build tool fetching dependencies while it starts the app. */
const REGISTRIES = /(^|\.)(maven\.apache\.org|repo1\.maven\.org|plugins\.gradle\.org|services\.gradle\.org|registry\.npmjs\.org|registry\.yarnpkg\.com|proxy\.golang\.org|sum\.golang\.org|pypi\.org|files\.pythonhosted\.org|crates\.io|rubygems\.org)$/;

export function blockedHint(hosts: string[]) {
  const message = `slicetest: offline: the app tried to reach ${hosts.join(", ")}, which no stub answers. Add ${hosts.length > 1 ? "them" : "it"} to a stub's \`hosts\` (or remove \`offline\`).`;
  const registries = hosts.filter((h) => REGISTRIES.test(h));
  if (registries.length === 0) return message;
  return `${message}\n${registries.join(", ")} ${registries.length > 1 ? "are package registries" : "is a package registry"}: the command that starts the app (gradle bootRun, mvn spring-boot:run, go run, …) is downloading dependencies, through slicetest's proxy. Download them in \`app.build\` (./gradlew bootJar, mvn package), or start a built artifact (java -jar).`;
}

export { connectionVars };
