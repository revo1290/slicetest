import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { resolveOptions } from "../src/config.js";
import { Db } from "../src/db.js";
import { SqliteDriver, sqliteUrl } from "../src/drivers/sqlite.js";

test("db.seed takes a list of files, run in order after every reset", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slicetest-seed-"));
  const url = sqliteUrl(path.join(dir, "a.db"));
  const driver = await SqliteDriver.connect(url);
  await driver.exec("CREATE TABLE plans (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE users (id INTEGER PRIMARY KEY, plan_id INTEGER REFERENCES plans(id))");
  await writeFile(path.join(dir, "1-plans.sql"), "INSERT INTO plans (id, name) VALUES (1, 'free')");
  await writeFile(path.join(dir, "2-users.sql"), "INSERT INTO users (id, plan_id) VALUES (7, 1)");

  const db = await Db.connect(driver, url, { schemas: ["main"], keep: [], seedFiles: [path.join(dir, "1-plans.sql"), path.join(dir, "2-users.sql")] });
  await db.reset();
  await db.insert("plans", { id: 2, name: "pro" });
  await db.reset();

  expect(await db.count("plans")).toBe(1);
  expect(await db.one("users")).toMatchObject({ id: 7, plan_id: 1 });
});

test("db.seed is a file or a list of files", () => {
  const options = (seed: unknown) => resolveOptions({ app: { command: "x" }, db: { seed } } as never, "/");

  expect(options("seed.sql").db.seed).toBe("seed.sql");
  expect(options(["a.sql", "b.sql"]).db.seed).toEqual(["a.sql", "b.sql"]);
  expect(() => options(["a.sql", 1])).toThrow("db.seed must be a file (SQL, YAML or JSON) or a list of them");
  expect(() => options([])).toThrow("db.seed must be a file (SQL, YAML or JSON) or a list of them");
  expect(() => options(3)).toThrow("db.seed must be a file (SQL, YAML or JSON) or a list of them, e.g. seed.sql, got 3");
});

test("a YAML or JSON seed file lists rows per table, inserted in order with the engine's own quoting", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slicetest-seed-"));
  const url = sqliteUrl(path.join(dir, "a.db"));
  const driver = await SqliteDriver.connect(url);
  await driver.exec("CREATE TABLE plans (id INTEGER PRIMARY KEY, name TEXT, active INTEGER); CREATE TABLE users (id INTEGER PRIMARY KEY, plan_id INTEGER REFERENCES plans(id), note TEXT)");
  await writeFile(path.join(dir, "plans.yaml"), "plans:\n  - { id: 1, name: free, active: 1 }\n  - { id: 2, name: \"it's pro\", active: 0 }\nusers:\n  - { id: 7, plan_id: 2, note: null }\n");
  await writeFile(path.join(dir, "more.json"), JSON.stringify({ users: [{ id: 8, plan_id: 1 }] }));

  const db = await Db.connect(driver, url, { schemas: ["main"], keep: [], seedFiles: [path.join(dir, "plans.yaml"), path.join(dir, "more.json")] });
  await db.reset();
  await db.insert("users", { id: 9, plan_id: 1 });
  await db.reset();

  expect(await db.rows("plans")).toEqual([{ id: 1, name: "free", active: 1 }, { id: 2, name: "it's pro", active: 0 }]);
  expect(await db.rows("users")).toEqual([{ id: 7, plan_id: 2, note: null }, { id: 8, plan_id: 1, note: null }]);
  expect(await db.changes()).toEqual({});

  await writeFile(path.join(dir, "bad.yaml"), "plans: { id: 1 }\n");
  await expect(Db.connect(driver, url, { schemas: ["main"], keep: [], seedFiles: [path.join(dir, "bad.yaml")] })).rejects.toThrow(
    `seed ${path.join(dir, "bad.yaml")}: "plans" must be a list of rows, e.g. plans: [{ id: 1, name: free }]`,
  );
});
