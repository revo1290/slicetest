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
  [{ ...valid, db: { migrate: { sql: "a.sql", command: "make migrate" } } }, "exactly one of atlas / sql / command, got sql, command"],
  [{ ...valid, stubs: ["slack.hook"] }, 'stub name "slack.hook"'],
  [{ ...valid, stubs: ["a", "a"] }, 'stub "a" is declared twice'],
  [{ ...valid, stubs: [{ name: "mail", autoReply: true }] }, 'stub "mail": autoReply needs an openapi spec'],
  [{ ...valid, containers: { cache: { port: 6379 } } }, "containers.cache.image is required"],
  [{ ...valid, containers: { cache: { image: "redis", port: "6379" } } }, "containers.cache.port must be the port"],
  [{ ...valid, containers: { cache: { image: "redis", port: 6379, reset: "redis-cli FLUSHALL" } } }, "containers.cache.reset must be a list of strings"],
  [{ ...valid, containers: { "a.b": { image: "redis", port: 6379 } } }, 'container name "a.b"'],
  [{ ...valid, auth: { issuer: "x" } }, "unknown key auth.issuer (expected audience, claims)"],
  [{ ...valid, auth: { claims: ["admin"] } }, "auth.claims must be a mapping"],
  [{ ...valid, db: { engine: "sqlite", queries: true } }, "db.queries needs a database server"],
  [{ ...valid, db: { engine: "oracle" } }, 'db.engine must be "postgres", "mysql" or "sqlite", got "oracle"'],
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
