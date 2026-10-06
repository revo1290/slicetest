import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { sqliteEngine, sqlitePath } from "../src/drivers/sqlite.js";

test("the driver holds the WAL index from connect on, before the app starts and while it is restarted", async () => {
  const { url, stop } = await sqliteEngine.startContainer("", false);
  const admin = await sqliteEngine.admin(url);
  try {
    await admin.create("a");
    const file = path.join(sqlitePath(url), "a.db");
    expect(existsSync(`${file}-shm`)).toBe(false);
    const driver = await sqliteEngine.driver(admin.urlFor("a"));
    try {
      expect(existsSync(`${file}-shm`)).toBe(true);
    } finally {
      await driver.close();
    }
  } finally {
    await admin.close();
    await stop();
  }
});

test("slicetest's own commits skip fsync: the test database is thrown away, and resets took seconds on Windows", async () => {
  const { url, stop } = await sqliteEngine.startContainer("", false);
  const admin = await sqliteEngine.admin(url);
  try {
    await admin.create("a");
    const driver = await sqliteEngine.driver(admin.urlFor("a"));
    try {
      expect(await driver.query("PRAGMA synchronous")).toEqual([{ synchronous: 0 }]);
    } finally {
      await driver.close();
    }
  } finally {
    await admin.close();
    await stop();
  }
});
