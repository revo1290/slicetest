import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { Db } from "../src/db.js";
import { SqliteDriver, sqliteUrl } from "../src/drivers/sqlite.js";

const DJANGO_ROWS = `
  CREATE TABLE django_content_type (id INTEGER PRIMARY KEY, model TEXT);
  CREATE TABLE auth_permission (id INTEGER PRIMARY KEY, codename TEXT);
  CREATE TABLE django_site (id INTEGER PRIMARY KEY, domain TEXT);
  CREATE TABLE auth_user (id INTEGER PRIMARY KEY, username TEXT);
  INSERT INTO django_content_type VALUES (1, 'user');
  INSERT INTO auth_permission VALUES (1, 'add_user');
  INSERT INTO django_site VALUES (1, 'example.com');
  INSERT INTO auth_user VALUES (1, 'ada');`;

async function database(sql: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slicetest-reset-"));
  const url = sqliteUrl(path.join(dir, "a.db"));
  const driver = await SqliteDriver.connect(url);
  await driver.exec(sql);
  return Db.connect(driver, url, { schemas: ["main"], keep: [], seedFiles: [] });
}

test("rows Django's migrate creates survive a reset: no seed can bring back what post_migrate wrote", async () => {
  const db = await database(`CREATE TABLE django_migrations (id INTEGER PRIMARY KEY); ${DJANGO_ROWS}`);
  await db.reset();
  expect(await db.count("django_content_type")).toBe(1);
  expect(await db.count("auth_permission")).toBe(1);
  expect(await db.count("django_site")).toBe(1);
  expect(await db.count("auth_user")).toBe(0);
  await db.close();
});

test("tables that only share those names are emptied in a project that isn't Django", async () => {
  const db = await database(DJANGO_ROWS);
  await db.reset();
  expect(await db.count("auth_permission")).toBe(0);
  expect(await db.count("django_site")).toBe(0);
  await db.close();
});
