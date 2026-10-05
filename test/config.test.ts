import { expect, test } from "vitest";
import { resolveOptions, type SlicetestOptions } from "../src/config.js";

const valid: SlicetestOptions = { app: { command: "node app.js" } };

test("fills in defaults", () => {
  expect(resolveOptions(valid, "/root")).toMatchObject({
    root: "/root",
    app: { command: "node app.js", ready: { path: "/" } },
    db: { image: "postgres:17-alpine", schemas: ["public"], keep: [] },
    stubs: [],
  });
});

test.each([
  [{ app: { command: " " } }, "app.command is required"],
  [{ app: { command: "x", ready: {} } }, "app.ready must be { path } or { log }"],
  [{ app: { command: "x", ready: { path: "health" } } }, 'must start with "/"'],
  [{ app: { command: "x", build: "" } }, 'app.build must be a command, e.g. "npm run build"'],
  [{ ...valid, services: { worker: { command: "x", build: ["make"] } } }, "services.worker.build must be a command"],
  [{ ...valid, db: { migrate: { sql: "a.sql", command: "make migrate" } } }, "exactly one of atlas / sql / command, got sql, command"],
  [{ ...valid, stubs: ["slack.hook"] }, 'stub name "slack.hook"'],
  [{ ...valid, stubs: ["a", "a"] }, 'stub "a" is declared twice'],
  [{ ...valid, stubs: [{ name: "mail", autoReply: true }] }, 'stub "mail": autoReply needs an openapi spec'],
  [{ ...valid, stubs: [{ name: "gh", hosts: "api.github.com" }] }, 'stub "gh": hosts must be a list'],
  [{ ...valid, offline: "yes" }, 'offline must be true or false, got "yes"'],
  [{ ...valid, stubs: [{ name: "gh", hosts: ["https://api.github.com"] }] }, 'no scheme, port or path; got "https://api.github.com"'],
  [{ ...valid, stubs: [{ name: "gh", hosts: ["localhost"] }] }, "localhost can't be intercepted; point the app at {{stub.gh}} instead"],
  [{ ...valid, stubs: [{ name: "a", hosts: ["x.test"] }, { name: "b", hosts: ["X.test"] }] }, 'host X.test is intercepted by both stub "a" and stub "b"'],
  [{ ...valid, containers: { cache: { port: 6379 } } }, "containers.cache.image is required"],
  [{ ...valid, containers: { cache: { image: "redis", port: "6379" } } }, "containers.cache.port must be the port"],
  [{ ...valid, containers: { cache: { image: "redis", port: 6379, reset: "redis-cli FLUSHALL" } } }, "containers.cache.reset must be a list of strings"],
  [{ ...valid, containers: { "a.b": { image: "redis", port: 6379 } } }, 'container name "a.b"'],
  [{ ...valid, auth: { issuer: "x" } }, "unknown key auth.issuer (expected audience, claims)"],
  [{ ...valid, auth: { claims: ["admin"] } }, "auth.claims must be a mapping"],
  [{ ...valid, db: { engine: "sqlite", queries: true } }, "db.queries needs a database server"],
  [{ ...valid, db: { engine: "oracle" } }, 'db.engine must be "postgres", "mysql" or "sqlite", got "oracle"'],
  [{ ...valid, stub: ["slack"] }, 'unknown key stub; did you mean "stubs"?'],
  [{ ...valid, strictstubs: true }, 'unknown key strictstubs; did you mean "strictStubs"?'],
  [{ ...valid, servers: {} }, 'unknown key servers; did you mean "services"?'],
  [{ ...valid, database: {} }, "unknown key database (expected app, db, stubs, openapi, http, services, containers, mail, offline, strictStubs, workers, auth, include)"],
  [{ app: { command: "x", readytimeout: 5 } }, 'unknown key app.readytimeout; did you mean "readyTimeout"?'],
  [{ ...valid, db: { migrations: { sql: "a.sql" } } }, 'unknown key db.migrations; did you mean "migrate"?'],
  [{ ...valid, stubs: [{ name: "gh", host: ["api.github.com"] }] }, 'unknown key stubs.gh.host; did you mean "hosts"?'],
  [{ ...valid, services: { worker: { command: "x", enviroment: {} } } }, "unknown key services.worker.enviroment"],
  [{ ...valid, containers: { cache: { image: "redis", port: 6379, ports: [1] } } }, 'unknown key containers.cache.ports; did you mean "port"?'],
  [{ app: { command: "x", readyTimeout: "30s" } }, 'app.readyTimeout must be a positive number of milliseconds, got "30s"'],
  [{ ...valid, services: { worker: { command: "x", readyTimeout: 0 } } }, "services.worker.readyTimeout must be a positive number of milliseconds, got 0"],
  [{ ...valid, http: { timeout: "5s" } }, 'http.timeout must be a positive number of milliseconds, got "5s"'],
  [{ ...valid, http: { headers: { accept: 1 } } }, "http.headers maps header names to strings"],
  [{ ...valid, http: { follow: "yes" } }, 'http.follow must be true or false, got "yes"'],
  [{ ...valid, http: { timout: 5 } }, 'unknown key http.timout; did you mean "timeout"?'],
])("rejects %j", (opts, message) => {
  expect(() => resolveOptions(opts as SlicetestOptions, "/")).toThrow(message);
});

test("reuses the container by default, except in CI or with an existing server", () => {
  const saved = { CI: process.env.CI, SLICETEST_DATABASE_URL: process.env.SLICETEST_DATABASE_URL };
  try {
    delete process.env.CI;
    delete process.env.SLICETEST_DATABASE_URL;
    expect(resolveOptions(valid, "/").db.reuse).toBe(true);
    expect(resolveOptions({ ...valid, db: { url: "postgres://x/y" } }, "/").db.reuse).toBe(false);
    expect(resolveOptions({ ...valid, db: { reuse: false } }, "/").db.reuse).toBe(false);
    process.env.CI = "true";
    expect(resolveOptions(valid, "/").db.reuse).toBe(false);
    expect(resolveOptions({ ...valid, db: { reuse: true } }, "/").db.reuse).toBe(true);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("picks the engine from db.engine or the URL, and only uses SLICETEST_DATABASE_URL for the same engine", () => {
  const saved = process.env.SLICETEST_DATABASE_URL;
  try {
    delete process.env.SLICETEST_DATABASE_URL;
    expect(resolveOptions(valid, "/").db).toMatchObject({ engine: "postgres", image: "postgres:17-alpine" });
    expect(resolveOptions({ ...valid, db: { engine: "mysql" } }, "/").db).toMatchObject({ engine: "mysql", image: "mysql:8.4" });
    expect(resolveOptions({ ...valid, db: { url: "mysql://root:x@h/db" } }, "/").db.engine).toBe("mysql");

    process.env.SLICETEST_DATABASE_URL = "postgres://ci/postgres";
    expect(resolveOptions(valid, "/").db.url).toBe("postgres://ci/postgres");
    expect(resolveOptions({ ...valid, db: { engine: "mysql" } }, "/").db.url).toBeUndefined();

    process.env.SLICETEST_DATABASE_URL = "mysql://root:x@ci/mysql";
    expect(resolveOptions(valid, "/").db).toMatchObject({ engine: "mysql", url: "mysql://root:x@ci/mysql" });
    expect(resolveOptions({ ...valid, db: { engine: "postgres" } }, "/").db.url).toBeUndefined();
  } finally {
    if (saved === undefined) delete process.env.SLICETEST_DATABASE_URL;
    else process.env.SLICETEST_DATABASE_URL = saved;
  }
});

test("intercepted hosts are mapped to their stub, in lower case", () => {
  expect(resolveOptions({ ...valid, stubs: ["slack", { name: "github", hosts: ["api.github.com", "GitHub.com"] }] }, "/").intercept).toEqual({
    "api.github.com": "github",
    "github.com": "github",
  });
});

test("app.scope and workers are validated", () => {
  expect(() => resolveOptions({ app: { command: "x", scope: "run" as never } }, "/")).toThrow('app.scope must be "file" or "worker", got "run"');
  expect(() => resolveOptions({ ...valid, workers: 0 }, "/")).toThrow("workers must be a positive whole number, got 0");
  expect(resolveOptions({ app: { command: "x", scope: "worker" }, workers: 2 }, "/")).toMatchObject({ app: { scope: "worker" }, workers: 2 });
});

test("db.ignoreChanges is a list of columns or tables", () => {
  expect(resolveOptions({ ...valid, db: { ignoreChanges: ["updated_at", "sessions.*"] } }, "/").db.ignoreChanges).toEqual(["updated_at", "sessions.*"]);
  expect(() => resolveOptions({ ...valid, db: { ignoreChanges: "updated_at" as never } }, "/")).toThrow("db.ignoreChanges must be a list of columns or tables");
});

test("app.restart, app.reset and app.idle are validated, for the app and for services", () => {
  const ok = resolveOptions({ app: { command: "x", restart: "scenario", reset: { path: "/__test/reset" }, idle: { path: "/__test/idle", timeout: 2000 } }, services: { worker: { command: "y", restart: "scenario" } } }, "/");
  expect(ok.app).toMatchObject({ restart: "scenario", reset: { path: "/__test/reset" }, idle: { path: "/__test/idle", timeout: 2000 } });
  expect(ok.services.worker).toMatchObject({ restart: "scenario" });
  expect(() => resolveOptions({ app: { command: "x", restart: "always" as never } }, "/")).toThrow('app.restart must be "never" or "scenario", got "always"');
  expect(() => resolveOptions({ app: { command: "x", reset: "/reset" as never } }, "/")).toThrow("app.reset must be { path }");
  expect(() => resolveOptions({ app: { command: "x", idle: { path: "idle" } } }, "/")).toThrow('app.idle.path must be a path on the app starting with "/"');
  expect(() => resolveOptions({ app: { command: "x", idle: { path: "/idle", timeout: 0 } } }, "/")).toThrow("app.idle.timeout must be between 1 and 600000 milliseconds, got 0");
  expect(() => resolveOptions({ app: { command: "x", reset: { path: "/r", verb: "POST" } as never } }, "/")).toThrow('unknown key app.reset.verb');
  expect(() => resolveOptions({ app: { command: "x" }, services: { w: { command: "y", idle: { path: "x" } } } }, "/")).toThrow('services.w.idle.path must be a path on the app starting with "/"');
  // These resolve to another host with new URL(path, base).
  for (const path of ["//evil.example/x", "/\\evil.example", "/ /evil", "/\t/evil.example"]) {
    expect(() => resolveOptions({ app: { command: "x", reset: { path } } }, "/"), path).toThrow("must be a path on the app");
  }
  expect(() => resolveOptions({ app: { command: "x", idle: { path: "/idle", timeout: 1e12 } } }, "/")).toThrow("between 1 and 600000");
  expect(() => resolveOptions({ app: { command: "x", reset: { path: "/r", method: "TRACE" } } }, "/")).toThrow("method must be GET, POST, PUT, PATCH, DELETE or HEAD");
  expect(resolveOptions({ app: { command: "x", reset: { path: "/r/a?b=c", method: "put" } } }, "/").app.reset).toEqual({ path: "/r/a?b=c", method: "put" });
});

test("env values written as YAML numbers or booleans become the strings a process sees", () => {
  const out = resolveOptions(
    {
      app: { command: "x", env: { PORT: "{{app.port}}", DEBUG: true, WORKERS: 2 as never } as never },
      services: { worker: { command: "y", env: { CONCURRENCY: 4 } as never } },
      containers: { cache: { image: "redis", port: 6379, env: { MAXMEMORY: 0 } as never } },
      db: { migrate: { command: "make migrate", env: { VERBOSE: false } as never } },
    },
    "/",
  );
  expect(out.app.env).toEqual({ PORT: "{{app.port}}", DEBUG: "true", WORKERS: "2" });
  expect(out.services.worker!.env).toEqual({ CONCURRENCY: "4" });
  expect(out.containers.cache!.env).toEqual({ MAXMEMORY: "0" });
  expect((out.db.migrate as { env?: unknown }).env).toEqual({ VERBOSE: "false" });
  expect(() => resolveOptions({ app: { command: "x", env: { DEBUG: null } as never } }, "/")).toThrow("app.env.DEBUG must be a string, a number or true/false, got null");
  expect(() => resolveOptions({ app: { command: "x", env: { A: { b: 1 } } as never } }, "/")).toThrow('app.env.A must be a string, a number or true/false, got {"b":1}');
  expect(() => resolveOptions({ app: { command: "x", env: ["PORT=1"] as never } }, "/")).toThrow("app.env maps variable names to values");
  expect(() => resolveOptions({ ...valid, containers: { cache: { image: "redis", port: 6379, env: { A: [] } as never } } }, "/")).toThrow("containers.cache.env.A must be");
});
