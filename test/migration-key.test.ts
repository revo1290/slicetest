import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { resolveOptions, type SlicetestOptions } from "../src/config.js";
import { migrationKey } from "../src/global-setup.js";

const key = (root: string, db: SlicetestOptions["db"]) => migrationKey(resolveOptions({ app: { command: "x" }, db }, root));

test("the template cache key follows the contents of the migrations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slicetest-key-"));
  await mkdir(path.join(root, "migrations/nested"), { recursive: true });
  await writeFile(path.join(root, "migrations/1.sql"), "CREATE TABLE a (id int);");
  await writeFile(path.join(root, "migrations/nested/2.sql"), "CREATE TABLE b (id int);");

  const first = await key(root, { migrate: { atlas: { dir: "file://migrations" } } });
  expect(await key(root, { migrate: { atlas: { dir: "migrations" } } })).not.toBe(first); // the option itself is part of the key
  expect(await key(root, { migrate: { atlas: { dir: "file://migrations" } } })).toBe(first);

  await writeFile(path.join(root, "migrations/nested/2.sql"), "CREATE TABLE b (id bigint);");
  expect(await key(root, { migrate: { atlas: { dir: "file://migrations" } } })).not.toBe(first);

  expect(await key(root, { migrate: { sql: "migrations" }, image: "postgres:16" })).not.toBe(await key(root, { migrate: { sql: "migrations" } }));
});

test("a migration command is cached only when its inputs are declared", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slicetest-key-"));
  await writeFile(path.join(root, "schema.prisma"), "model A {}");

  expect(await key(root, { migrate: { command: "prisma migrate deploy" } })).toBeUndefined();
  expect(await key(root, { migrate: { command: "prisma migrate deploy", inputs: ["schema.prisma"] } })).toMatch(/^[0-9a-f]{20}$/);
  await expect(key(root, { migrate: { command: "x", inputs: ["missing"] } })).rejects.toThrow("migration input not found");
});
