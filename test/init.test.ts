import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { resolveOptions } from "../src/config.js";
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

test("reads docker compose: the database image, and other services as containers with a reset", async () => {
  const compose = `
services:
  app:
    build: .
  db:
    image: postgis/postgis:17-3.5
    ports: ["5432:5432"]
  cache:
    image: valkey/valkey:8
  search:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.15.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
  storage:
    image: minio/minio
    command: server /data
    environment: { MINIO_ROOT_USER: test }
  mail:
    image: axllent/mailpit
    ports: ["127.0.0.1:8025:8025/tcp", "1025:1025"]
  worker-only:
    image: busybox
`;
  const { config, notes } = await detect(await project({ "package.json": JSON.stringify({ scripts: { start: "node ." } }), "compose.yaml": compose }));
  expect(config.db).toEqual({ image: "postgis/postgis:17-3.5" });
  expect(notes.join("\n")).toContain("worker-only");
  expect(config.containers).toEqual({
    cache: { image: "valkey/valkey:8", port: 6379, reset: ["valkey-cli", "FLUSHALL"] },
    search: { image: "docker.elastic.co/elasticsearch/elasticsearch:8.15.0", port: 9200, env: { "discovery.type": "single-node", "xpack.security.enabled": "false" } },
    storage: { image: "minio/minio", port: 9000, command: ["server", "/data"], env: { MINIO_ROOT_USER: "test" } },
  });
  expect(config.mail).toBe(true);
  // What init writes is a valid config.
  expect(() => resolveOptions(config, "/")).not.toThrow();
  expect(config.app.env).toMatchObject({ REDIS_URL: "redis://{{container.cache}}", ELASTICSEARCH_URL: "http://{{container.search}}", S3_ENDPOINT: "http://{{container.storage}}" });
  expect(notes).toEqual(
    expect.arrayContaining([
      'compose.yaml: service "app" is built from source; if it\'s the app, app.command replaces it',
      'compose.yaml: service "worker-only" (busybox) exposes no port; skipped',
    ]),
  );
});

test("a MySQL service or driver switches the engine", async () => {
  const fromCompose = await detect(await project({ "docker-compose.yml": "services:\n  db:\n    image: mysql:8.4\n" }));
  expect(fromCompose.config.db).toEqual({ engine: "mysql", image: "mysql:8.4" });
  const fromDeps = await detect(await project({ "package.json": JSON.stringify({ scripts: { start: "node ." }, dependencies: { mysql2: "^3" } }) }));
  expect(fromDeps.config.db).toEqual({ engine: "mysql" });
});

test("a mail catcher in compose, or a mail library, turns on mail with SMTP variables", async () => {
  const compose = await detect(await project({ "go.mod": "module x", "compose.yaml": "services:\n  mail:\n    image: axllent/mailpit:latest\n    ports: ['1025:1025', '8025:8025']\n" }));
  expect(compose.config).toMatchObject({ mail: true, app: { env: { SMTP_HOST: "{{mail.host}}", SMTP_PORT: "{{mail.port}}" } } });
  expect(compose.config.containers).toBeUndefined();
  expect(compose.notes.join("\n")).toContain("axllent/mailpit:latest");
  const node = await detect(await project({ "package.json": JSON.stringify({ scripts: { start: "x" }, dependencies: { nodemailer: "^6" } }) }));
  expect(node.config.mail).toBe(true);
  const plain = await detect(await project({ "package.json": JSON.stringify({ scripts: { start: "x" } }) }));
  expect(plain.config.mail).toBeUndefined();
});

test.each([
  ["Prisma", { "package.json": "{}", "prisma/schema.prisma": 'datasource db {\n  provider = "sqlite"\n  url = env("DATABASE_URL")\n}\n' }, "file:{{db.path}}"],
  ["Rails", { Gemfile: "gem 'rails'\ngem 'sqlite3'\n", "config/database.yml": "default: &default\n  adapter: sqlite3\n" }, "sqlite3:{{db.path}}"],
  ["Django", { "manage.py": "", "mysite/settings.py": "DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3'}}" }, "{{db.url}}"],
  ["a Node driver", { "package.json": JSON.stringify({ dependencies: { "better-sqlite3": "^11" } }) }, "{{db.url}}"],
])("detects SQLite from %s, with the URL form the framework reads", async (_, files, url) => {
  const { config, notes } = await detect(await project(files));
  expect(config.db?.engine).toBe("sqlite");
  expect(config.app.env?.DATABASE_URL).toBe(url);
  expect(notes.join("\n")).toContain("SQLite");
  expect(() => resolveOptions(config, "/")).not.toThrow();
});

test("a SQLite driver next to a Postgres one isn't taken for the app's database", async () => {
  const { config } = await detect(await project({ "package.json": JSON.stringify({ dependencies: { "better-sqlite3": "^11", pg: "^8" } }) }));
  expect(config.db?.engine).toBeUndefined();
});

test("third-party API URLs in .env.example become stubs, and the variables point at them", async () => {
  const { config, notes } = await detect(
    await project({
      "go.mod": "module x",
      ".env.example": [
        "DATABASE_URL=postgres://localhost/app",
        "STRIPE_API_BASE=https://api.stripe.com",
        "export GITHUB_API_URL='https://api.github.com/'",
        "SLACK_WEBHOOK_URL=https://hooks.slack.com/services/x",
        "SENDGRID_ENDPOINT=https://api.sendgrid.com/v3 # mail",
        "APP_URL=https://example.com",
        "INTERNAL_API_URL=http://localhost:4000",
        "USERS_SERVICE_URL=http://users:8080",
      ].join("\n"),
    }),
  );
  expect(config.stubs).toEqual([
    { name: "stripe", upstream: "https://api.stripe.com" },
    { name: "github", upstream: "https://api.github.com" },
    { name: "sendgrid", upstream: "https://api.sendgrid.com" },
  ]);
  expect(config.app.env).toMatchObject({ STRIPE_API_BASE: "{{stub.stripe}}", GITHUB_API_URL: "{{stub.github}}", SENDGRID_ENDPOINT: "{{stub.sendgrid}}/v3" });
  expect(notes.join("\n")).toContain("SLICETEST_RECORD=stripe");
  expect(() => resolveOptions(config, "/")).not.toThrow();
});
