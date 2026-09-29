import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { detect, init } from "../src/init.js";

async function project(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "slicetest-init-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

test.each([
  [
    "Node + Prisma + OpenAPI",
    { "package.json": JSON.stringify({ scripts: { start: "node server.js" } }), "prisma/schema.prisma": "", "openapi.yaml": "openapi: 3.1.0" },
    { app: { command: "npm start" }, db: { migrate: { command: "npx prisma migrate deploy", inputs: ["prisma/migrations"] } }, openapi: "openapi.yaml" },
  ],
  [
    "FastAPI + Alembic",
    { "requirements.txt": "fastapi\nuvicorn\n", "alembic.ini": "[alembic]\nscript_location = db/alembic\n" },
    { app: { command: "uvicorn main:app --port {{app.port}}" }, db: { migrate: { command: "alembic upgrade head", inputs: ["db/alembic/versions"] } } },
  ],
  [
    "Rails",
    { Gemfile: "gem 'rails'\n", "db/migrate/001_init.rb": "" },
    { app: { command: "bin/rails server -p {{app.port}}" }, db: { migrate: { command: "bin/rails db:migrate", inputs: ["db/migrate"] } } },
  ],
  [
    "Go + Atlas",
    { "go.mod": "module x", "migrations/atlas.sum": "", "migrations/1.sql": "" },
    { app: { command: "go run ." }, db: { migrate: { atlas: { dir: "file://migrations" } } } },
  ],
  ["plain SQL migrations", { "go.mod": "module x", "migrations/001.sql": "" }, { db: { migrate: { sql: "migrations" } } }],
])("detects %s", async (_, files, expected) => {
  const { config } = await detect(await project(files));
  expect(config).toMatchObject(expected);
});

test("an unknown project gets a placeholder command and explanations", async () => {
  const { config, notes } = await detect(await project({}));
  expect(config.app.command).toContain("TODO");
  expect(config.db).toBeUndefined();
  expect(notes).toEqual(["app: couldn't tell how to start the app. Set app.command.", "db: no migrations found; the database starts empty. Set db.migrate."]);
});

test("init writes a config with the detections as comments, and refuses to overwrite", async () => {
  const root = await project({ "package.json": JSON.stringify({ scripts: { start: "node ." } }), "schema.sql": "" });

  const { files } = await init(root);

  expect(files).toEqual(["slicetest.config.yaml", path.join("scenarios", "smoke.scenario.yaml")]);
  const text = await readFile(path.join(root, "slicetest.config.yaml"), "utf8");
  expect(text).toContain("# - db: schema.sql");
  expect(parse(text)).toMatchObject({ app: { command: "npm start", env: { PORT: "{{app.port}}" } }, db: { migrate: { sql: "schema.sql" } } });
  await expect(init(root)).rejects.toThrow("already exists. Use --force to overwrite.");
  await expect(init(root, { force: true })).resolves.toBeDefined();
});
