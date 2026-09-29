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
