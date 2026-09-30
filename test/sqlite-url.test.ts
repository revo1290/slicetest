import { expect, test } from "vitest";
import { sqlitePath, sqliteUrl } from "../src/drivers/sqlite.js";
import { resolveOptions } from "../src/config.js";

test("sqlite URLs round-trip absolute paths, including Windows drive paths", () => {
  expect(sqlitePath("sqlite:///tmp/a.db")).toBe("/tmp/a.db");
  expect(sqlitePath("sqlite:///C:/Users/x/a.db")).toBe("C:/Users/x/a.db");
  expect(sqlitePath("sqlite:///tmp/my%20dir/a.db?mode=rw")).toBe("/tmp/my dir/a.db");
  expect(sqlitePath("/plain/path.db")).toBe("/plain/path.db");
  expect(sqlitePath(sqliteUrl("/tmp/x/a.db"))).toMatch(/[\\/]tmp[\\/]x[\\/]a\.db$/);
});

test("sqlite ignores SLICETEST_DATABASE_URL and rejects db.url", () => {
  const before = process.env.SLICETEST_DATABASE_URL;
  process.env.SLICETEST_DATABASE_URL = "postgres://ci:ci@db/postgres";
  try {
    expect(resolveOptions({ app: { command: "x" }, db: { engine: "sqlite" } }, "/").db).toMatchObject({ engine: "sqlite", url: undefined });
  } finally {
    if (before === undefined) delete process.env.SLICETEST_DATABASE_URL;
    else process.env.SLICETEST_DATABASE_URL = before;
  }
  expect(() => resolveOptions({ app: { command: "x" }, db: { engine: "sqlite", url: "sqlite:///x.db" } }, "/")).toThrow(/db\.url doesn't apply to sqlite/);
});
