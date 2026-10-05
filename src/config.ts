import type { AuthOptions } from "./auth.js";
import type { RequestOptions } from "./http.js";

export interface SlicetestOptions {
  app: AppOptions;
  /** The database, or `false` for an app without one: no container, no resets, no `{{db.*}}`. */
  db?: DbOptions | false;
  /**
   * Outbound HTTP services to stub. Each gets its own server, referenced as `{{stub.<name>}}` in `app.env`.
   * With `{ name, openapi }`, the app's calls to it and the stub's replies are checked against that service's spec.
   * With `autoReply: true` as well, calls no route matches are answered from the spec (its examples, or values
   * built from its schemas) instead of failing, so you only register the routes a scenario cares about.
   */
  stubs?: (string | StubOptions)[];
  /**
   * The app's own OpenAPI 3 spec (YAML or JSON, relative to the root). Every
   * response the app gives during a scenario must be documented and match its
   * schema, or the scenario fails. At the end of the run, slicetest prints which
   * documented responses the scenarios produced; with `minCoverage` (percent),
   * a lower coverage fails the run.
   */
  openapi?: string | { spec?: string; fromApp?: string; minCoverage?: number };
  /** Defaults for every request made with `http`, e.g. `{ headers: { accept: "application/json" } }`. */
  http?: RequestOptions;
  /**
   * Other processes the app needs: a queue worker, another microservice, a
   * mock written in another language. They start before the app, in order, and
   * are watched like the app: a crash fails the scenario and they're restarted.
   * Their URL is `{{service.<name>}}` and their port `{{service.<name>.port}}`,
   * usable in `app.env` and in the env of services declared after them.
   */
  services?: Record<string, ServiceOptions>;
  /**
   * Containers the app depends on besides the database: Redis, Elasticsearch,
   * MinIO, LocalStack. Each test file gets its own, reachable at
   * `{{container.<name>}}` (`host:port`), `{{container.<name>.host}}` and
   * `{{container.<name>.port}}`. `reset` runs inside it before every scenario.
   */
  containers?: Record<string, ContainerOptions>;
  /**
   * Catch the mail the app sends. An SMTP server (no TLS, any credentials)
   * listens at `{{mail.host}}` / `{{mail.port}}` (`{{mail.url}}` is `smtp://host:port`);
   * scenarios read what arrived with `mail.messages()` / `mail.waitFor()`.
   */
  mail?: boolean;
  /**
   * Keep the app off the network: its HTTP(S) calls may only reach localhost and the
   * hosts of stubs with `hosts`. A call anywhere else is refused and fails the
   * scenario, naming the host, so a forgotten stub can't reach a real service.
   */
  offline?: boolean;
  /**
   * Fail a scenario that registered a stub route the app never called: the test may not be
   * exercising what it set up. Routes marked `.optional()` (YAML `optional: true`) are exempt.
   */
  strictStubs?: boolean;
  /**
   * Most Vitest workers to run test files in (Vitest's `maxWorkers`). Each worker has
   * its own app and database; with `app.scope: "worker"`, fewer workers means fewer app
   * starts, which is what makes a slow-starting app fast to test.
   */
  workers?: number;
  /**
   * An OpenID Connect issuer for apps that verify JWTs. The app gets
   * `{{auth.issuer}}`, `{{auth.jwks}}` and `{{auth.audience}}`; scenarios mint
   * tokens with `auth.token({ sub, roles })`. `true`, or `{ audience, claims }`.
   */
  auth?: boolean | AuthOptions;
}

export interface ContainerOptions {
  image: string;
  /** The port the service listens on inside the container. */
  port: number;
  env?: Record<string, string>;
  command?: string[];
  /** Wait for this log line instead of the port accepting connections. */
  ready?: { log: string };
  /** Command run inside the container before each scenario, e.g. `["redis-cli", "FLUSHALL"]`. */
  reset?: string[];
}

export interface StubOptions {
  name: string;
  /** The provider's OpenAPI spec: the app's calls and the stub's replies are checked against it. */
  openapi?: string;
  /** Answer calls no route matches from the spec's examples or schemas. Needs `openapi`. */
  autoReply?: boolean;
  /**
   * The real service's base URL, e.g. `https://api.github.com`. Calls no route
   * matches are answered from `recordings`; run with `SLICETEST_RECORD=<name>`
   * (or `=1` for every stub) to forward the ones without a recording to this
   * URL and record the answers.
   */
  upstream?: string;
  /** Recordings file, relative to the root. Default `recordings/<name>.yaml`. */
  recordings?: string;
  /**
   * Hosts the app calls directly, e.g. `["api.github.com"]`: their HTTP and HTTPS
   * traffic is answered by this stub, for apps whose URLs can't be set from the
   * environment. The app is started with proxy variables and a test CA it trusts.
   */
  hosts?: string[];
}

export interface ServiceOptions extends Omit<AppOptions, "ready"> {
  /** Default: no wait (for workers that don't listen). `{ path }` polls the service's own port. */
  ready?: AppOptions["ready"];
}

type ResolvedReady = { path: string } | { log: string; flags: string };

/** A process to start, with `ready` made JSON-serializable. The app always has `ready`; services may not. */
export type ResolvedProcess = Omit<AppOptions, "ready" | "scope"> & {
  ready?: ResolvedReady;
  /** Set by slicetest (proxy variables for intercepted hosts); `env` overrides it. */
  baseEnv?: Record<string, string>;
};

export interface AppOptions {
  /** Command that starts the app, run through the shell. */
  command: string;
  /**
   * Command run once per run, before any worker starts the process, e.g.
   * `npm run build` for an app started with `next start`. Runs in `cwd` while
   * the database starts. Not repeated on re-runs in watch mode.
   */
  build?: string;
  cwd?: string;
  /**
   * Environment passed to the app. Values may reference
   * `{{app.port}}`, `{{db.url}}` and `{{stub.<name>}}`.
   * Defaults to `{ PORT: "{{app.port}}", DATABASE_URL: "{{db.url}}" }`.
   */
  env?: Record<string, string>;
  /** How to tell the app is up. Defaults to polling `GET /` until it answers. */
  ready?: { path: string } | { log: string | RegExp };
  /** Milliseconds to wait for readiness. Default 30000. */
  readyTimeout?: number;
  /**
   * `"file"` (default) starts the app, stubs and services for each test file.
   * `"worker"` starts them once per Vitest worker and keeps them for every file that
   * worker runs, for apps that take seconds to start (a JVM, a large framework). It
   * turns off Vitest's per-file module isolation (`isolate: false`).
   */
  scope?: "file" | "worker";
  /**
   * `"scenario"`: stop before the reset, start after. Not a cure for other processes, containers without `reset`
   * or files. Default `"never"`: the process, and its caches and timers, outlive the scenario. Also on `services`.
   */
  restart?: "never" | "scenario";
  /**
   * Endpoint that drops in-process state, called after the reset. Not for work already in flight: it can still
   * write before the call, so use `idle` or `restart`. A status of 400+ fails the scenario.
   */
  reset?: HookOptions;
  /**
   * 2xx once no background work is left. Not a fixed sleep: slicetest can't know when a job is done.
   * Still busy after `timeout`: the scenario fails and the process is restarted.
   */
  idle?: HookOptions;
}

/** Sent by slicetest itself; not the scenario's `http` client. */
export interface HookOptions {
  path: string;
  /** Default `POST` for `reset`, `GET` for `idle`. */
  method?: string;
  /** Milliseconds: how long `idle` is polled, or a `reset` request may take. Default 5000. */
  timeout?: number;
}

export interface DbOptions {
  /**
   * `postgres` (default), `mysql` or `sqlite`. Inferred from `url` when it starts with `mysql://`.
   * MySQL needs the `mysql2` package, and `@testcontainers/mysql` unless `url` is given.
   * SQLite needs Node.js 22.5+ and nothing else: no server, no container. The app gets
   * `{{db.url}}` as `sqlite:///path/to/file.db` and `{{db.path}}` as the file path.
   */
  engine?: "postgres" | "mysql" | "sqlite";
  /** Image used when no `url` is given. Default `postgres:17-alpine`, or `mysql:8.4` for MySQL. */
  image?: string;
  /**
   * Use an existing server instead of starting a container. Must point at a superuser (root) connection.
   * Defaults to the `SLICETEST_DATABASE_URL` environment variable, which is handy in CI.
   */
  url?: string;
  migrate?: MigrateOptions;
  /** SQL file (relative to the vitest root) run after every reset. */
  seed?: string | string[];
  /** Schemas whose tables are reset between scenarios. Default `["public"]`. */
  schemas?: string[];
  /** Extra tables kept across resets, in addition to known migration bookkeeping tables. */
  keep?: string[];
  /**
   * Columns and tables `db.changes()`, YAML `changes` steps, `trace()` and the failure output leave out:
   * `updated_at` (that column in every table), `orders.synced_at`, `sessions.*` (a whole table).
   * For values the app sets on every write, so they don't fail a `toEqual` or a snapshot.
   */
  ignoreChanges?: string[];
  /**
   * Keep the Postgres container running between runs and cache the migrated
   * template by the contents of the migrations, so a run with unchanged
   * migrations skips both container start-up and migrating.
   * Default: on, except when `CI` is set or `url` is given.
   */
  reuse?: boolean;
  /**
   * Record the SQL the app runs: `{{db.url}}` points the app at a proxy that
   * reads the wire protocol (Postgres and MySQL), so `db.queries()` lists every
   * statement, whatever the app's language or driver. Off by default.
   */
  queries?: boolean;
  /**
   * For apps on Neon's serverless driver over HTTP (`neon()` from @neondatabase/serverless,
   * drizzle-orm/neon-http): `{{db.url}}` becomes a Neon-style connection string, and
   * slicetest answers the driver's HTTP queries from the test database. Postgres only.
   */
  neon?: boolean;
}

export type MigrateOptions =
  | { atlas: { dir: string } }
  | { sql: string }
  | {
      command: string;
      /**
       * Files or directories the command reads (e.g. `["prisma/migrations"]`).
       * With `reuse`, the migrated template is cached until one of them changes;
       * without `inputs`, the command runs on every run.
       */
      inputs?: string[];
      /**
       * Extra environment for the command, for tools that don't read `DATABASE_URL`
       * (Laravel's `DB_HOST`, EF Core's connection string): `{ DB_HOST: "{{db.host}}" }`.
       * The command itself may use the same `{{db.*}}` placeholders.
       */
      env?: Record<string, string>;
    };

/** Normalized shape passed from the plugin to globalSetup and workers. Must stay JSON-serializable. */
export interface ResolvedOptions {
  root: string;
  app: ResolvedProcess & { ready: ResolvedReady; scope?: "file" | "worker" };
  services: Record<string, ResolvedProcess>;
  containers: Record<string, ContainerOptions>;
  mail: boolean;
  offline: boolean;
  strictStubs: boolean;
  workers?: number;
  auth: AuthOptions | false;
  db: Required<Pick<DbOptions, "engine" | "image" | "schemas" | "keep" | "reuse">> & Omit<DbOptions, "engine" | "image" | "schemas" | "keep" | "reuse"> & {
    /** `db: false`: the app has no database. */
    none?: boolean;
  };
  stubs: string[];
  /** Spec files, resolved against the root: the app's, and per stub name. */
  /** `fromApp`: a path the running app serves its own spec at (springdoc, FastAPI, NestJS). */
  openapi: { app?: string; fromApp?: string; minCoverage?: number; stubs: Record<string, string>; autoReply: string[] };
  /** Stubs backed by recordings of a real service; `record` when SLICETEST_RECORD selects them. */
  recordings: Record<string, { file: string; upstream: string; record: boolean }>;
  /** Intercepted host (lower case) → the stub that answers it. */
  intercept: Record<string, string>;
  http?: RequestOptions;
}

/** The config files `npx slicetest` (and `slicetest()` without options) look for, in order. */
export const CONFIG_NAMES = ["slicetest.config.yaml", "slicetest.config.yml", "slicetest.config.json"];

export function resolveOptions(opts: SlicetestOptions, root: string): ResolvedOptions {
  validate(opts);
  opts = withStringEnv(opts);
  return {
    root,
    app: { ...opts.app, ready: resolveReady(opts.app.ready ?? { path: "/" }) },
    services: Object.fromEntries(
      Object.entries(opts.services ?? {}).map(([name, s]) => [name, { ...s, ready: s.ready && resolveReady(s.ready) }]),
    ),
    containers: opts.containers ?? {},
    mail: opts.mail ?? false,
    offline: opts.offline ?? false,
    strictStubs: opts.strictStubs ?? false,
    workers: opts.workers,
    auth: opts.auth === true ? {} : (opts.auth ?? false),
    db: opts.db === false ? { ...resolveDb({}), none: true } : resolveDb(opts.db ?? {}),
    stubs: (opts.stubs ?? []).map(stubName),
    openapi: {
      app: typeof opts.openapi === "object" ? opts.openapi.spec : opts.openapi,
      fromApp: typeof opts.openapi === "object" ? opts.openapi.fromApp : undefined,
      minCoverage: typeof opts.openapi === "object" ? opts.openapi.minCoverage : undefined,
      stubs: Object.fromEntries((opts.stubs ?? []).flatMap((s) => (typeof s === "object" && s.openapi ? [[s.name, s.openapi]] : []))),
      autoReply: (opts.stubs ?? []).flatMap((s) => (typeof s === "object" && s.autoReply ? [s.name] : [])),
    },
    recordings: resolveRecordings(opts.stubs ?? []),
    intercept: Object.fromEntries((opts.stubs ?? []).flatMap((s) => (typeof s === "object" ? (s.hosts ?? []).map((h) => [h.toLowerCase(), s.name]) : []))),
    http: opts.http,
  };
}

/** YAML reads `DEBUG: true` and `WORKERS: 2` as a boolean and a number; a process only takes strings. */
function withStringEnv(opts: SlicetestOptions): SlicetestOptions {
  const str = <T extends { env?: Record<string, string> }>(p: T): T => (p.env ? { ...p, env: Object.fromEntries(Object.entries(p.env).map(([k, v]) => [k, String(v)])) } : p);
  const db = opts.db && opts.db.migrate && "command" in opts.db.migrate ? { ...opts.db, migrate: str(opts.db.migrate) } : opts.db;
  return {
    ...opts,
    app: str(opts.app),
    ...(opts.services ? { services: Object.fromEntries(Object.entries(opts.services).map(([n, s]) => [n, str(s)])) } : {}),
    ...(opts.containers ? { containers: Object.fromEntries(Object.entries(opts.containers).map(([n, c]) => [n, str(c)])) } : {}),
    ...(db !== undefined ? { db } : {}),
  };
}

function resolveRecordings(stubs: (string | StubOptions)[]): ResolvedOptions["recordings"] {
  const withUpstream = stubs.filter((s): s is StubOptions & { upstream: string } => typeof s === "object" && !!s.upstream);
  const env = (process.env.SLICETEST_RECORD ?? "").trim();
  const all = ["1", "true", "all", "*"].includes(env.toLowerCase());
  const names = all || !env ? [] : env.split(",").map((n) => n.trim()).filter(Boolean);
  for (const n of names) {
    if (!withUpstream.some((s) => s.name === n)) {
      throw new Error(`slicetest: SLICETEST_RECORD names "${n}", but no stub of that name has an upstream. Stubs with one: ${withUpstream.map((s) => s.name).join(", ") || "(none)"}`);
    }
  }
  return Object.fromEntries(
    withUpstream.map((s) => [s.name, { file: s.recordings ?? `recordings/${s.name}.yaml`, upstream: s.upstream, record: all || names.includes(s.name) }]),
  );
}

function resolveReady(ready: NonNullable<AppOptions["ready"]>): ResolvedReady {
  if (!("log" in ready)) return ready;
  return typeof ready.log === "string" ? { log: escapeRegExp(ready.log), flags: "" } : { log: ready.log.source, flags: ready.log.flags };
}

function resolveDb(db: DbOptions): ResolvedOptions["db"] {
  const isMysql = (u: string) => /^mysql:/i.test(u);
  const env = process.env.SLICETEST_DATABASE_URL || undefined;
  const engine = db.engine ?? (isMysql(db.url ?? env ?? "") ? "mysql" : "postgres");
  // The environment variable names one server for the whole CI job; a project on the other engine starts its own.
  const url = engine === "sqlite" ? undefined : (db.url ?? (env && isMysql(env) === (engine === "mysql") ? env : undefined));
  return {
    image: engine === "mysql" ? "mysql:8.4" : engine === "sqlite" ? "" : "postgres:17-alpine",
    schemas: ["public"],
    keep: [],
    ...db,
    engine,
    url,
    reuse: db.reuse ?? (!url && !process.env.CI),
  };
}

export const TOP_LEVEL_KEYS = ["app", "db", "stubs", "openapi", "http", "services", "containers", "mail", "offline", "strictStubs", "workers", "auth", "include"] as const satisfies readonly (keyof SlicetestOptions | "include")[];
export const APP_KEYS = ["command", "build", "cwd", "env", "ready", "readyTimeout", "scope", "restart", "reset", "idle", "baseEnv"] as const;
export const STUB_KEYS = ["name", "openapi", "autoReply", "upstream", "recordings", "hosts"] as const satisfies readonly (keyof StubOptions)[];
export const CONTAINER_KEYS = ["image", "port", "env", "command", "ready", "reset"] as const satisfies readonly (keyof ContainerOptions)[];
export const DB_KEYS = ["engine", "image", "url", "migrate", "seed", "schemas", "keep", "ignoreChanges", "reuse", "queries", "neon"] as const satisfies readonly (keyof DbOptions)[];

export function editDistance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

function validate(opts: SlicetestOptions) {
  const fail = (msg: string) => {
    throw new Error(`slicetest: invalid config: ${msg}`);
  };
  // A misspelt key (`stub:`, `strictstubs:`) would otherwise be ignored without a word; YAML configs have no type checker.
  const checkKeys = (value: unknown, allowed: readonly string[], where: string) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
      if (allowed.includes(key) || key === "$schema") continue;
      // Close in spelling, or sharing the first four letters (`servers` / `services`, `migrations` / `migrate`).
      const near = allowed
        .map((k) => ({ k, d: editDistance(k.toLowerCase(), key.toLowerCase()) }))
        .filter(({ k, d }) => d <= Math.max(2, Math.floor(key.length / 3)) || (key.length >= 4 && k.toLowerCase().startsWith(key.slice(0, 4).toLowerCase())))
        .sort((a, b) => a.d - b.d)[0];
      const hint = near ? `; did you mean "${near.k}"?` : ` (expected ${allowed.join(", ")})`;
      fail(`unknown key ${where}${key}${hint}`);
    }
  };
  checkKeys(opts, TOP_LEVEL_KEYS, "");
  checkKeys(opts?.app, APP_KEYS, "app.");
  if (opts?.db) checkKeys(opts.db, DB_KEYS, "db.");
  for (const stub of opts?.stubs ?? []) if (typeof stub === "object" && stub) checkKeys(stub, STUB_KEYS, `stubs.${stub.name ?? "?"}.`);
  for (const [name, service] of Object.entries(opts?.services ?? {})) checkKeys(service, APP_KEYS, `services.${name}.`);
  for (const [name, container] of Object.entries(opts?.containers ?? {})) checkKeys(container, CONTAINER_KEYS, `containers.${name}.`);
  if (!opts?.app || typeof opts.app.command !== "string" || !opts.app.command.trim()) {
    fail("app.command is required, e.g. { app: { command: \"node server.js\" } }");
  }
  const checkReady = (ready: AppOptions["ready"], where: string) => {
    if (ready !== undefined && !("path" in ready) && !("log" in ready)) fail(`${where}.ready must be { path } or { log }`);
    if (ready && "path" in ready && !ready.path.startsWith("/")) fail(`${where}.ready.path must start with "/", got "${ready.path}"`);
  };
  const checkEnv = (env: unknown, where: string) => {
    if (env === undefined) return;
    if (!env || typeof env !== "object" || Array.isArray(env)) fail(`${where} maps variable names to values, e.g. { NODE_ENV: test }, got ${JSON.stringify(env)}`);
    for (const [k, v] of Object.entries(env as object)) {
      if (!["string", "number", "boolean"].includes(typeof v)) fail(`${where}.${k} must be a string, a number or true/false, got ${JSON.stringify(v)}`);
    }
  };
  checkEnv(opts.app.env, "app.env");
  for (const [name, s] of Object.entries(opts.services ?? {})) checkEnv(s?.env, `services.${name}.env`);
  for (const [name, c] of Object.entries(opts.containers ?? {})) checkEnv(c?.env, `containers.${name}.env`);
  checkReady(opts.app.ready, "app");
  const checkTimeout = (v: unknown, where: string) => {
    if (v !== undefined && !(typeof v === "number" && v > 0)) fail(`${where} must be a positive number of milliseconds, got ${JSON.stringify(v)}`);
  };
  checkTimeout(opts.app.readyTimeout, "app.readyTimeout");
  if (opts.http !== undefined) {
    if (!opts.http || typeof opts.http !== "object" || Array.isArray(opts.http)) fail(`http must be { headers, timeout, follow }, got ${JSON.stringify(opts.http)}`);
    checkKeys(opts.http, ["headers", "query", "follow", "timeout"], "http.");
    checkTimeout(opts.http.timeout, "http.timeout");
    if (opts.http.follow !== undefined && typeof opts.http.follow !== "boolean") fail(`http.follow must be true or false, got ${JSON.stringify(opts.http.follow)}`);
    const headers = opts.http.headers;
    if (headers !== undefined && (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.values(headers).some((v) => typeof v !== "string"))) {
      fail('http.headers maps header names to strings, e.g. { accept: "application/json" }');
    }
  }
  if (opts.app.scope !== undefined && opts.app.scope !== "file" && opts.app.scope !== "worker") fail(`app.scope must be "file" or "worker", got ${JSON.stringify(opts.app.scope)}`);
  const checkBuild = (build: unknown, where: string) => {
    if (build !== undefined && (typeof build !== "string" || !build.trim())) fail(`${where}.build must be a command, e.g. "npm run build"`);
  };
  checkBuild(opts.app.build, "app");
  const checkLifecycle = (p: Partial<AppOptions>, where: string) => {
    if (p.restart !== undefined && p.restart !== "never" && p.restart !== "scenario") fail(`${where}.restart must be "never" or "scenario", got ${JSON.stringify(p.restart)}`);
    for (const key of ["reset", "idle"] as const) {
      const hook = p[key];
      if (hook === undefined) continue;
      if (!hook || typeof hook !== "object" || Array.isArray(hook)) fail(`${where}.${key} must be { path }, e.g. { path: "/__test/${key}" }`);
      checkKeys(hook, ["path", "method", "timeout"], `${where}.${key}.`);
      // Not just startsWith("/"): "//host/x" and "/\\host" resolve to another host.
      if (typeof hook.path !== "string" || !/^\/(?![/\\])[^\s\\]*$/.test(hook.path)) fail(`${where}.${key}.path must be a path on the app starting with "/" (no "//", backslash or spaces), got ${JSON.stringify(hook.path)}`);
      if (hook.method !== undefined && !(typeof hook.method === "string" && ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(hook.method.toUpperCase()))) fail(`${where}.${key}.method must be GET, POST, PUT, PATCH, DELETE or HEAD, got ${JSON.stringify(hook.method)}`);
      if (hook.timeout !== undefined && !(Number.isInteger(hook.timeout) && hook.timeout >= 1 && hook.timeout <= 600_000)) fail(`${where}.${key}.timeout must be between 1 and 600000 milliseconds, got ${JSON.stringify(hook.timeout)}`);
    }
  };
  checkLifecycle(opts.app, "app");
  for (const [name, s] of Object.entries(opts.services ?? {})) {
    if (!/^[\w-]+$/.test(name)) fail(`service name "${name}" may only contain letters, digits, "_" and "-"`);
    if (!s || typeof s.command !== "string" || !s.command.trim()) fail(`services.${name}.command is required`);
    checkReady(s.ready, `services.${name}`);
    checkTimeout(s.readyTimeout, `services.${name}.readyTimeout`);
    checkBuild(s.build, `services.${name}`);
    checkLifecycle(s, `services.${name}`);
  }
  for (const [name, c] of Object.entries(opts.containers ?? {})) {
    if (!/^[\w-]+$/.test(name)) fail(`container name "${name}" may only contain letters, digits, "_" and "-"`);
    if (!c || typeof c.image !== "string" || !c.image) fail(`containers.${name}.image is required, e.g. "redis:7-alpine"`);
    if (!Number.isInteger(c.port) || c.port <= 0) fail(`containers.${name}.port must be the port the service listens on inside the container, e.g. 6379`);
    for (const key of ["command", "reset"] as const) {
      const v = c[key];
      if (v !== undefined && !(Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string"))) fail(`containers.${name}.${key} must be a list of strings, e.g. ["redis-cli", "FLUSHALL"]`);
    }
  }
  if (opts.workers !== undefined && !(Number.isInteger(opts.workers) && opts.workers >= 1)) fail(`workers must be a positive whole number, got ${JSON.stringify(opts.workers)}`);
  if (opts.offline !== undefined && typeof opts.offline !== "boolean") fail(`offline must be true or false, got ${JSON.stringify(opts.offline)}`);
  if (opts.strictStubs !== undefined && typeof opts.strictStubs !== "boolean") fail(`strictStubs must be true or false, got ${JSON.stringify(opts.strictStubs)}`);
  if (opts.mail !== undefined && typeof opts.mail !== "boolean") fail(`mail must be true or false, got ${JSON.stringify(opts.mail)}`);
  if (opts.auth !== undefined && typeof opts.auth !== "boolean") {
    if (!opts.auth || typeof opts.auth !== "object" || Array.isArray(opts.auth)) fail(`auth must be true or { audience, claims }, got ${JSON.stringify(opts.auth)}`);
    for (const key of Object.keys(opts.auth)) if (key !== "audience" && key !== "claims") fail(`unknown key auth.${key} (expected audience, claims)`);
    if (opts.auth.audience !== undefined && typeof opts.auth.audience !== "string") fail("auth.audience must be a string");
    if (opts.auth.claims !== undefined && (!opts.auth.claims || typeof opts.auth.claims !== "object" || Array.isArray(opts.auth.claims))) fail("auth.claims must be a mapping of claim names to values");
  }
  const dbOpts = opts.db === false ? undefined : opts.db;
  const engine = dbOpts?.engine;
  if (engine !== undefined && engine !== "postgres" && engine !== "mysql" && engine !== "sqlite") fail(`db.engine must be "postgres", "mysql" or "sqlite", got ${JSON.stringify(engine)}`);
  if (dbOpts?.ignoreChanges !== undefined && !(Array.isArray(dbOpts.ignoreChanges) && dbOpts.ignoreChanges.every((c) => typeof c === "string" && c && !c.startsWith(".")))) {
    fail(`db.ignoreChanges must be a list of columns or tables, e.g. [updated_at, orders.synced_at, sessions.*], got ${JSON.stringify(dbOpts.ignoreChanges)}`);
  }
  if (dbOpts?.queries !== undefined && typeof dbOpts!.queries !== "boolean") fail(`db.queries must be true or false, got ${JSON.stringify(dbOpts!.queries)}`);
  if (dbOpts?.neon !== undefined && typeof dbOpts.neon !== "boolean") fail(`db.neon must be true or false, got ${JSON.stringify(dbOpts.neon)}`);
  if (dbOpts?.neon && (engine === "mysql" || engine === "sqlite")) fail("db.neon is Neon's protocol for Postgres; it doesn't apply to " + engine);
  if (engine === "sqlite" && dbOpts?.queries) fail("db.queries needs a database server (postgres or mysql): an SQLite app opens the file directly, so there is no connection to read");
  if (engine === "sqlite" && dbOpts?.url) fail("db.url doesn't apply to sqlite: slicetest creates the database files itself and passes them to the app as {{db.url}} / {{db.path}}");
  const seed = dbOpts?.seed;
  if (seed !== undefined && !(typeof seed === "string" ? seed : Array.isArray(seed) && seed.length > 0 && seed.every((f) => typeof f === "string" && f))) {
    fail(`db.seed must be a SQL file or a list of them, e.g. seed.sql, got ${JSON.stringify(seed)}`);
  }
  const migrate = dbOpts?.migrate;
  if (migrate) {
    const keys = Object.keys(migrate).filter((k) => ["atlas", "sql", "command"].includes(k));
    if (keys.length !== 1) fail(`db.migrate takes exactly one of atlas / sql / command, got ${keys.join(", ") || "none"}`);
    const menv = (migrate as { env?: unknown }).env;
    if (menv !== undefined) {
      if (!("command" in migrate)) fail("db.migrate.env is for a migration `command`; atlas and sql get the database URL themselves");
      checkEnv(menv, "db.migrate.env");
    }
  }
  const oas = opts.openapi;
  if (oas !== undefined) {
    const spec = typeof oas === "object" && oas ? oas.spec : oas;
    const fromApp = typeof oas === "object" && oas ? oas.fromApp : undefined;
    if (fromApp !== undefined) {
      if (spec !== undefined) fail("openapi takes either spec (a file) or fromApp (a path the app serves its spec at), not both");
      if (typeof fromApp !== "string" || !fromApp.startsWith("/")) fail(`openapi.fromApp must be a path on the app such as "/v3/api-docs", got ${JSON.stringify(fromApp)}`);
    } else if (typeof spec !== "string" || !spec) fail('openapi must be the path of an OpenAPI file, or { spec, minCoverage }, or { fromApp: "/v3/api-docs" }');
    const min = typeof oas === "object" ? oas.minCoverage : undefined;
    if (min !== undefined && !(typeof min === "number" && min >= 0 && min <= 100)) fail("openapi.minCoverage must be a percentage between 0 and 100");
  }
  for (const s of opts.stubs ?? []) {
    if (typeof s !== "string" && (!s || typeof s.name !== "string")) fail(`each stub must be a name or { name, openapi }, got ${JSON.stringify(s)}`);
    if (typeof s === "object" && s.autoReply && !s.openapi) fail(`stub "${s.name}": autoReply needs an openapi spec to answer from`);
    if (typeof s === "object" && s.upstream !== undefined && !/^https?:\/\/[^/]/.test(s.upstream)) fail(`stub "${s.name}": upstream must be an http(s) URL, got ${JSON.stringify(s.upstream)}`);
    if (typeof s === "object" && s.recordings !== undefined && !s.upstream) fail(`stub "${s.name}": recordings needs an upstream to record from`);
    if (typeof s === "object" && s.hosts !== undefined) {
      if (!Array.isArray(s.hosts) || s.hosts.length === 0) fail(`stub "${s.name}": hosts must be a list of host names, e.g. ["api.github.com"]`);
      for (const h of s.hosts) {
        if (typeof h !== "string" || !/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$|^[a-z0-9-]+$/i.test(h)) {
          fail(`stub "${s.name}": hosts takes host names (or *.domain for every subdomain), no scheme, port or path; got ${JSON.stringify(h)}`);
        }
        if (["localhost", "127.0.0.1"].includes(h.toLowerCase())) fail(`stub "${s.name}": ${h} can't be intercepted; point the app at {{stub.${s.name}}} instead`);
      }
    }
  }
  const seen = new Map<string, string>();
  for (const s of opts.stubs ?? []) {
    if (typeof s !== "object") continue;
    for (const h of s.hosts ?? []) {
      const other = seen.get(h.toLowerCase());
      if (other) fail(`host ${h} is intercepted by both stub "${other}" and stub "${s.name}"`);
      seen.set(h.toLowerCase(), s.name);
    }
  }
  const stubs = (opts.stubs ?? []).map(stubName);
  for (const name of stubs) {
    if (!/^[\w-]+$/.test(name)) fail(`stub name "${name}" may only contain letters, digits, "_" and "-"`);
  }
  const dup = stubs.find((n, i) => stubs.indexOf(n) !== i);
  if (dup) fail(`stub "${dup}" is declared twice`);
}

function stubName(s: string | { name: string }) {
  return typeof s === "string" ? s : s.name;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `db.seed` as a list of files, in the order they run. */
export function seedFiles(seed: string | string[] | undefined) {
  return seed === undefined ? [] : Array.isArray(seed) ? seed : [seed];
}
