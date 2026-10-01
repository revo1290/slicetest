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
    "Next.js (build before start)",
    { "package.json": JSON.stringify({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "16.0.0" } }) },
    { app: { command: "npm start", build: "npm run build" } },
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
  expect(notes).toEqual([
    "app: couldn't tell how to start the app. Set app.command.",
    "db: no migrations found; the database starts empty. Set db.migrate.",
    "network: URLs written in the code (https://api.example.com) can be stubbed with `hosts`. Add `offline: true` and the first run names every host the app calls",
  ]);
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
  expect((config.db || undefined)?.engine).toBe("sqlite");
  expect(config.app.env?.DATABASE_URL).toBe(url);
  expect(notes.join("\n")).toContain("SQLite");
  expect(() => resolveOptions(config, "/")).not.toThrow();
});

test("a SQLite driver next to a Postgres one isn't taken for the app's database", async () => {
  const { config } = await detect(await project({ "package.json": JSON.stringify({ dependencies: { "better-sqlite3": "^11", pg: "^8" } }) }));
  expect((config.db || undefined)?.engine).toBeUndefined();
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

test("token issuer settings in .env.example turn on auth instead of becoming stubs", async () => {
  const { config, notes } = await detect(
    await project({
      "go.mod": "module x",
      ".env.example": ["OIDC_ISSUER_URL=https://login.example-idp.com/realms/app", "JWKS_URI=https://login.example-idp.com/certs", "JWT_AUDIENCE=api", "STRIPE_API_BASE=https://api.stripe.com"].join("\n"),
    }),
  );
  expect(config.auth).toBe(true);
  expect(config.app.env).toMatchObject({ OIDC_ISSUER_URL: "{{auth.issuer}}", JWKS_URI: "{{auth.jwks}}", JWT_AUDIENCE: "{{auth.audience}}" });
  expect(config.stubs).toEqual([{ name: "stripe", upstream: "https://api.stripe.com" }]);
  expect(notes.join("\n")).toContain("auth: OIDC_ISSUER_URL, JWKS_URI, JWT_AUDIENCE");
  expect(() => resolveOptions(config, "/")).not.toThrow();
});

test("an audience alone doesn't turn on auth; a JWT library only suggests it", async () => {
  const { config, notes } = await detect(
    await project({ "package.json": JSON.stringify({ scripts: { start: "node s.js" }, dependencies: { jose: "^5" } }), ".env.example": "API_AUDIENCE=x\n" }),
  );
  expect(config.auth).toBeUndefined();
  expect(config.app.env).not.toHaveProperty("API_AUDIENCE");
  expect(notes.join("\n")).toContain("auth: jose is a dependency");
});

test("a Spring Boot app in backend/ with Atlas migrations named in atlas/atlas.hcl and a podman-compose.yml", async () => {
  const root = await project({
    "frontend/package.json": JSON.stringify({ scripts: { dev: "next dev", build: "next build", start: "next start" } }),
    "backend/build.gradle": "plugins { id 'org.springframework.boot' version '3.4.0' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-actuator' }",
    "backend/gradlew": "",
    "atlas/atlas.hcl": 'env "local" {\n  migration {\n    dir = "file://migrations"\n  }\n}\n',
    "atlas/migrations/1_init.sql": "",
    "podman-compose.yml": "services:\n  db:\n    image: docker.io/library/postgres:16\n",
  });

  const { config, notes } = await detect(root);

  expect(config).toMatchObject({
    app: {
      cwd: "backend",
      build: process.platform === "win32" ? "gradlew.bat bootJar -q" : "./gradlew bootJar -q",
      command: process.platform === "win32" ? "gradlew.bat bootRun -q" : "./gradlew bootRun -q",
      env: { SERVER_PORT: "{{app.port}}", SPRING_DATASOURCE_URL: "{{db.jdbcUrl}}", SPRING_DATASOURCE_USERNAME: "{{db.user}}", SPRING_DATASOURCE_PASSWORD: "{{db.password}}" },
      ready: { path: "/actuator/health" },
      readyTimeout: 120000,
    },
    db: { image: "docker.io/library/postgres:16", migrate: { atlas: { dir: "file://atlas/migrations" } } },
  });
  expect(config.app.env).not.toHaveProperty("DATABASE_URL");
  expect(notes).toContain("app: in backend/ (app.cwd); commands for it run there");
});

test("migrations of an app in a subdirectory are found and run there", async () => {
  const root = await project({
    "package.json": JSON.stringify({ scripts: { prepare: "lefthook install" } }),
    "server/package.json": JSON.stringify({ scripts: { start: "node ." }, devDependencies: { prisma: "6" } }),
    "server/prisma/schema.prisma": "",
  });

  expect((await detect(root)).config).toMatchObject({
    app: { cwd: "server", command: "npm start" },
    db: { migrate: { command: "cd server && npx prisma migrate deploy", inputs: ["server/prisma/migrations"] } },
  });
});

test("a Gradle Spring Boot app in backend/ with its own atlas.hcl and migrations", async () => {
  const root = await project({
    "package.json": JSON.stringify({ scripts: { prepare: "lefthook install" } }),
    "backend/build.gradle.kts": 'plugins { id("org.springframework.boot") version "4.1.1" apply false }',
    "backend/atlas.hcl": 'env "local" {\n  migration {\n    dir = "file://migrations"\n  }\n}\n',
    "backend/migrations/1_users.sql": "",
    "backend/podman-compose.yml": "services:\n  postgres:\n    image: docker.io/library/postgres:16\n",
  });

  expect((await detect(root)).config).toMatchObject({
    app: { cwd: "backend", env: { SERVER_PORT: "{{app.port}}" } },
    db: { image: "docker.io/library/postgres:16", migrate: { atlas: { dir: "file://backend/migrations" } } },
  });
});

test("the first scenario requests the readiness path, and .env.example is read next to the app", async () => {
  const root = await project({
    "backend/pom.xml": "<parent><artifactId>spring-boot-starter-parent</artifactId></parent><dependency><artifactId>spring-boot-starter-actuator</artifactId></dependency>",
    "backend/.env.example": "PAYMENTS_API_URL=https://api.payments.example/v1\n",
  });

  await init(root);

  expect(await readFile(path.join(root, "scenarios", "smoke.scenario.yaml"), "utf8")).toContain("- request: GET /actuator/health");
  expect(parse(await readFile(path.join(root, "slicetest.config.yaml"), "utf8"))).toMatchObject({
    app: { cwd: "backend", env: { PAYMENTS_API_URL: "{{stub.payments}}/v1" } },
    stubs: [{ name: "payments", upstream: "https://api.payments.example" }],
  });
});

test("an app without migrations, database service or database library gets db: false", async () => {
  const root = await project({
    "backend/build.gradle.kts": 'plugins { id("org.springframework.boot") version "3.4.1" }\ndependencies { implementation("org.springframework.boot:spring-boot-starter-web") }',
    "docker-compose.yml": "services:\n  backend:\n    build: { context: ./backend }\n",
  });

  const { config, notes } = await detect(root);

  expect(config.db).toBe(false);
  expect(config.app.env).toEqual({ SERVER_PORT: "{{app.port}}" });
  expect(notes).toContain("db: none (no migrations, no database in compose, no database library), so `db: false`: no container is started");
  // A database library alone keeps the database.
  expect((await detect(await project({ "package.json": JSON.stringify({ scripts: { start: "node ." }, dependencies: { pg: "8" } }) }))).config.db).not.toBe(false);
});

test("the first scenario doesn't insist on 200 at / ", async () => {
  const root = await project({ "go.mod": "module x" });
  await init(root);
  const text = await readFile(path.join(root, "scenarios", "smoke.scenario.yaml"), "utf8");
  expect(text).toContain("      - request: GET /\n        # expect: { status: 200 }");
  expect(parse(text).scenarios[0].steps).toEqual([{ request: "GET /" }]);
});
