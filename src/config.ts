import type { RequestOptions } from "./http.js";

export interface SlicetestOptions {
  app: AppOptions;
  db?: DbOptions;
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
  openapi?: string | { spec: string; minCoverage?: number };
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
}

export interface ServiceOptions extends Omit<AppOptions, "ready"> {
  /** Default: no wait (for workers that don't listen). `{ path }` polls the service's own port. */
  ready?: AppOptions["ready"];
}

type ResolvedReady = { path: string } | { log: string; flags: string };

/** A process to start, with `ready` made JSON-serializable. The app always has `ready`; services may not. */
export type ResolvedProcess = Omit<AppOptions, "ready"> & { ready?: ResolvedReady };

export interface AppOptions {
  /** Command that starts the app, run through the shell. */
  command: string;
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
  seed?: string;
  /** Schemas whose tables are reset between scenarios. Default `["public"]`. */
  schemas?: string[];
  /** Extra tables kept across resets, in addition to known migration bookkeeping tables. */
  keep?: string[];
  /**
   * Keep the Postgres container running between runs and cache the migrated
   * template by the contents of the migrations, so a run with unchanged
   * migrations skips both container start-up and migrating.
   * Default: on, except when `CI` is set or `url` is given.
   */
  reuse?: boolean;
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
    };

/** Normalized shape passed from the plugin to globalSetup and workers. Must stay JSON-serializable. */
export interface ResolvedOptions {
  root: string;
  app: Omit<AppOptions, "ready"> & { ready: ResolvedReady };
  services: Record<string, ResolvedProcess>;
  containers: Record<string, ContainerOptions>;
  mail: boolean;
  db: Required<Pick<DbOptions, "engine" | "image" | "schemas" | "keep" | "reuse">> & Omit<DbOptions, "engine" | "image" | "schemas" | "keep" | "reuse">;
  stubs: string[];
  /** Spec files, resolved against the root: the app's, and per stub name. */
  openapi: { app?: string; minCoverage?: number; stubs: Record<string, string>; autoReply: string[] };
  /** Stubs backed by recordings of a real service; `record` when SLICETEST_RECORD selects them. */
  recordings: Record<string, { file: string; upstream: string; record: boolean }>;
  http?: RequestOptions;
}

export function resolveOptions(opts: SlicetestOptions, root: string): ResolvedOptions {
  validate(opts);
  return {
    root,
    app: { ...opts.app, ready: resolveReady(opts.app.ready ?? { path: "/" }) },
    services: Object.fromEntries(
      Object.entries(opts.services ?? {}).map(([name, s]) => [name, { ...s, ready: s.ready && resolveReady(s.ready) }]),
    ),
    containers: opts.containers ?? {},
    mail: opts.mail ?? false,
    db: resolveDb(opts.db ?? {}),
    stubs: (opts.stubs ?? []).map(stubName),
    openapi: {
      app: typeof opts.openapi === "object" ? opts.openapi.spec : opts.openapi,
      minCoverage: typeof opts.openapi === "object" ? opts.openapi.minCoverage : undefined,
      stubs: Object.fromEntries((opts.stubs ?? []).flatMap((s) => (typeof s === "object" && s.openapi ? [[s.name, s.openapi]] : []))),
      autoReply: (opts.stubs ?? []).flatMap((s) => (typeof s === "object" && s.autoReply ? [s.name] : [])),
    },
    recordings: resolveRecordings(opts.stubs ?? []),
    http: opts.http,
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

function validate(opts: SlicetestOptions) {
  const fail = (msg: string) => {
    throw new Error(`slicetest: invalid config: ${msg}`);
  };
  if (!opts?.app || typeof opts.app.command !== "string" || !opts.app.command.trim()) {
    fail("app.command is required, e.g. { app: { command: \"node server.js\" } }");
  }
  const checkReady = (ready: AppOptions["ready"], where: string) => {
    if (ready !== undefined && !("path" in ready) && !("log" in ready)) fail(`${where}.ready must be { path } or { log }`);
    if (ready && "path" in ready && !ready.path.startsWith("/")) fail(`${where}.ready.path must start with "/", got "${ready.path}"`);
  };
  checkReady(opts.app.ready, "app");
  for (const [name, s] of Object.entries(opts.services ?? {})) {
    if (!/^[\w-]+$/.test(name)) fail(`service name "${name}" may only contain letters, digits, "_" and "-"`);
    if (!s || typeof s.command !== "string" || !s.command.trim()) fail(`services.${name}.command is required`);
    checkReady(s.ready, `services.${name}`);
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
  if (opts.mail !== undefined && typeof opts.mail !== "boolean") fail(`mail must be true or false, got ${JSON.stringify(opts.mail)}`);
  const engine = opts.db?.engine;
  if (engine !== undefined && engine !== "postgres" && engine !== "mysql" && engine !== "sqlite") fail(`db.engine must be "postgres", "mysql" or "sqlite", got ${JSON.stringify(engine)}`);
  if (engine === "sqlite" && opts.db?.url) fail("db.url doesn't apply to sqlite: slicetest creates the database files itself and passes them to the app as {{db.url}} / {{db.path}}");
  const migrate = opts.db?.migrate;
  if (migrate) {
    const keys = Object.keys(migrate).filter((k) => ["atlas", "sql", "command"].includes(k));
    if (keys.length !== 1) fail(`db.migrate takes exactly one of atlas / sql / command, got ${keys.join(", ") || "none"}`);
  }
  const oas = opts.openapi;
  if (oas !== undefined) {
    const spec = typeof oas === "object" && oas ? oas.spec : oas;
    if (typeof spec !== "string" || !spec) fail('openapi must be the path of an OpenAPI file, or { spec, minCoverage }');
    const min = typeof oas === "object" ? oas.minCoverage : undefined;
    if (min !== undefined && !(typeof min === "number" && min >= 0 && min <= 100)) fail("openapi.minCoverage must be a percentage between 0 and 100");
  }
  for (const s of opts.stubs ?? []) {
    if (typeof s !== "string" && (!s || typeof s.name !== "string")) fail(`each stub must be a name or { name, openapi }, got ${JSON.stringify(s)}`);
    if (typeof s === "object" && s.autoReply && !s.openapi) fail(`stub "${s.name}": autoReply needs an openapi spec to answer from`);
    if (typeof s === "object" && s.upstream !== undefined && !/^https?:\/\/[^/]/.test(s.upstream)) fail(`stub "${s.name}": upstream must be an http(s) URL, got ${JSON.stringify(s.upstream)}`);
    if (typeof s === "object" && s.recordings !== undefined && !s.upstream) fail(`stub "${s.name}": recordings needs an upstream to record from`);
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
