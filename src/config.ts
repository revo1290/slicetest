import type { RequestOptions } from "./http.js";

export interface SlicetestOptions {
  app: AppOptions;
  db?: DbOptions;
  /** Names of outbound HTTP services to stub. Each gets its own server, referenced as `{{stub.<name>}}` in `app.env`. */
  stubs?: string[];
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
}

export type MigrateOptions =
  | { atlas: { dir: string } }
  | { sql: string }
  | { command: string };

/** Normalized shape passed from the plugin to globalSetup and workers. Must stay JSON-serializable. */
export interface ResolvedOptions {
  root: string;
  app: Omit<AppOptions, "ready"> & { ready: { path: string } | { log: string; flags: string } };
  db: Required<Pick<DbOptions, "image" | "schemas" | "keep">> & Omit<DbOptions, "image" | "schemas" | "keep">;
  stubs: string[];
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
    db: {
      image: "postgres:17-alpine",
      schemas: ["public"],
      keep: [],
      ...opts.db,
      url: opts.db?.url ?? (process.env.SLICETEST_DATABASE_URL || undefined),
    },
    stubs: opts.stubs ?? [],
    http: opts.http,
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
  const stubs = opts.stubs ?? [];
  for (const name of stubs) {
    if (!/^[\w-]+$/.test(name)) fail(`stub name "${name}" may only contain letters, digits, "_" and "-"`);
  }
  const dup = stubs.find((n, i) => stubs.indexOf(n) !== i);
  if (dup) fail(`stub "${dup}" is declared twice`);
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
