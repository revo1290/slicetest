import type { RequestOptions } from "./http.js";

export interface SlicetestOptions {
  app: AppOptions;
  db?: DbOptions;
  /**
   * Outbound HTTP services to stub. Each gets its own server, referenced as `{{stub.<name>}}` in `app.env`.
   * With `{ name, openapi }`, the app's calls to it and the stub's replies are checked against that service's spec.
   */
  stubs?: (string | { name: string; openapi?: string })[];
  /**
   * The app's own OpenAPI 3 spec (YAML or JSON, relative to the root). Every
   * response the app gives during a scenario must be documented and match its
   * schema, or the scenario fails.
   */
  openapi?: string;
  /** Defaults for every request made with `http`, e.g. `{ headers: { accept: "application/json" } }`. */
  http?: RequestOptions;
}

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
  /** Postgres image used when no `url` is given. Default `postgres:17-alpine`. */
  image?: string;
  /**
   * Use an existing Postgres server instead of starting a container. Must point at a superuser-capable database.
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
  app: Omit<AppOptions, "ready"> & { ready: { path: string } | { log: string; flags: string } };
  db: Required<Pick<DbOptions, "image" | "schemas" | "keep" | "reuse">> & Omit<DbOptions, "image" | "schemas" | "keep" | "reuse">;
  stubs: string[];
  /** Spec files, resolved against the root: the app's, and per stub name. */
  openapi: { app?: string; stubs: Record<string, string> };
  http?: RequestOptions;
}

export function resolveOptions(opts: SlicetestOptions, root: string): ResolvedOptions {
  validate(opts);
  const ready = opts.app.ready ?? { path: "/" };
  return {
    root,
    app: {
      ...opts.app,
      ready:
        "log" in ready
          ? typeof ready.log === "string"
            ? { log: escapeRegExp(ready.log), flags: "" }
            : { log: ready.log.source, flags: ready.log.flags }
          : ready,
    },
    db: resolveDb(opts.db ?? {}),
    stubs: (opts.stubs ?? []).map(stubName),
    openapi: {
      app: opts.openapi,
      stubs: Object.fromEntries((opts.stubs ?? []).flatMap((s) => (typeof s === "object" && s.openapi ? [[s.name, s.openapi]] : []))),
    },
    http: opts.http,
  };
}

function resolveDb(db: DbOptions): ResolvedOptions["db"] {
  const url = db.url ?? (process.env.SLICETEST_DATABASE_URL || undefined);
  return {
    image: "postgres:17-alpine",
    schemas: ["public"],
    keep: [],
    ...db,
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
  const ready = opts.app.ready;
  if (ready !== undefined && !("path" in ready) && !("log" in ready)) fail("app.ready must be { path } or { log }");
  if (ready && "path" in ready && !ready.path.startsWith("/")) fail(`app.ready.path must start with "/", got "${ready.path}"`);
  const migrate = opts.db?.migrate;
  if (migrate) {
    const keys = Object.keys(migrate).filter((k) => ["atlas", "sql", "command"].includes(k));
    if (keys.length !== 1) fail(`db.migrate takes exactly one of atlas / sql / command, got ${keys.join(", ") || "none"}`);
  }
  if (opts.openapi !== undefined && (typeof opts.openapi !== "string" || !opts.openapi)) fail("openapi must be the path of an OpenAPI file");
  for (const s of opts.stubs ?? []) {
    if (typeof s !== "string" && (!s || typeof s.name !== "string")) fail(`each stub must be a name or { name, openapi }, got ${JSON.stringify(s)}`);
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
