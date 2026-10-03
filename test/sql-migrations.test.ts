import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { applySqlFiles, sqlMigrationFiles, upSection } from "../src/sql-migrations.js";

async function dir(files: Record<string, string>) {
  const d = await mkdtemp(path.join(os.tmpdir(), "slicetest-sql-"));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(d, name)), { recursive: true });
    await writeFile(path.join(d, name), text);
  }
  return d;
}

test("applies up migrations in version order, leaving out rollback files", async () => {
  const d = await dir({
    "000001_users.up.sql": "",
    "000001_users.down.sql": "",
    "000002_posts.UP.sql": "",
    "V2__b.sql": "",
    "V10__c.sql": "",
    "U2__b.sql": "",
    "README.md": "",
  });

  expect((await sqlMigrationFiles(d)).map((f) => path.basename(f))).toEqual(["000001_users.up.sql", "000002_posts.UP.sql", "V2__b.sql", "V10__c.sql"]);
  expect(await sqlMigrationFiles(path.join(d, "U2__b.sql"))).toEqual([path.join(d, "U2__b.sql")]);
});

test("Diesel's migration directories apply their up.sql", async () => {
  const d = await dir({
    "2024-02-01-000000_posts/up.sql": "",
    "2024-02-01-000000_posts/down.sql": "",
    "2024-01-01-000000_users/up.sql": "",
    "2024-01-01-000000_users/down.sql": "",
    "notes/readme.txt": "",
  });

  expect((await sqlMigrationFiles(d)).map((f) => path.relative(d, f).replace(/\\/g, "/"))).toEqual(["2024-01-01-000000_users/up.sql", "2024-02-01-000000_posts/up.sql"]);
});

test("goose and dbmate files run without their down section", () => {
  expect(upSection("-- +goose Up\nCREATE TABLE a (id int);\n-- +goose StatementBegin\nSELECT 1;\n-- +goose StatementEnd\n\n-- +goose Down\nDROP TABLE a;\n")).toBe(
    "-- +goose Up\nCREATE TABLE a (id int);\n-- +goose StatementBegin\nSELECT 1;\n-- +goose StatementEnd\n\n",
  );
  expect(upSection("-- migrate:up\ncreate table b (id int);\n\n-- migrate:down\ndrop table b;\n")).toBe("-- migrate:up\ncreate table b (id int);\n\n");
  expect(upSection("CREATE TABLE c (id int); -- not a marker: -- +goose Down\n")).toBe("CREATE TABLE c (id int); -- not a marker: -- +goose Down\n");
});

test("a failing migration names its file", async () => {
  const d = await dir({ "1_ok.sql": "ok", "2_bad.sql": "bad" });
  const ran: string[] = [];
  const exec = async (sql: string) => {
    if (sql === "bad") throw new Error("syntax error at or near \"bad\"");
    ran.push(sql);
  };

  await expect(applySqlFiles(await sqlMigrationFiles(d), exec, d)).rejects.toThrow('slicetest: db.migrate.sql: 2_bad.sql: syntax error at or near "bad"');
  expect(ran).toEqual(["ok"]);
});
