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
