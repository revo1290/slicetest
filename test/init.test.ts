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
  [
    "Go with the server in cmd/ and golang-migrate in db/migrations",
    { "go.mod": "module example.com/shop\n", "cmd/worker/main.go": "package main\n", "cmd/shop/main.go": "package main\n", "internal/x.go": "package x\n", "db/migrations/1_a.up.sql": "", "db/migrations/1_a.down.sql": "" },
    { app: { command: "go run ./cmd/shop", build: "go build ./...", readyTimeout: 60_000 }, db: { migrate: { sql: "db/migrations" } } },
  ],
  ["Go with main.go at the root", { "go.mod": "module x", "main.go": "// x\npackage main\n", "cmd/tool/main.go": "package main\n" }, { app: { command: "go run ." } }],
  [
    "Rust + Diesel",
    { "Cargo.toml": "[package]\nname = \"api\"\n", "migrations/2024-01-01-000000_users/up.sql": "" },
    { app: { command: "cargo run -q", build: "cargo build -q", readyTimeout: 120_000 }, db: { migrate: { sql: "migrations" } } },
  ],
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

test("a Next.js SaaS: Drizzle SQL migrations from drizzle.config's out, Neon, Clerk, and SDK hosts as stubs", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      scripts: { build: "next build", start: "next start" },
      dependencies: { next: "15", "@neondatabase/serverless": "0.10", "drizzle-orm": "0.36", "@clerk/nextjs": "7", stripe: "17", "@anthropic-ai/sdk": "0.40" },
      devDependencies: { "drizzle-kit": "0.30" },
    }),
    "drizzle.config.ts": "export default { schema: './db/schema.ts', out: './db/migrations', dialect: 'postgresql' };",
    ".env.example": "STRIPE_SECRET_KEY=sk_test_...\nANTHROPIC_API_KEY=sk-ant-...\n",
  });

  const { config, notes } = await detect(root);

  expect(config).toMatchObject({
    db: { neon: true, migrate: { sql: "db/migrations" } },
    auth: true,
    app: { env: { STRIPE_SECRET_KEY: "sk_test_slicetest", ANTHROPIC_API_KEY: "sk-ant-slicetest", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuc2xpY2V0ZXN0LnRlc3Qk", CLERK_SECRET_KEY: "sk_test_slicetest" } },
    stubs: [
      { name: "stripe", hosts: ["api.stripe.com"] },
      { name: "anthropic", hosts: ["api.anthropic.com"] },
      { name: "clerk", hosts: ["api.clerk.com", "clerk.slicetest.test"] },
    ],
  });
  expect(config.app.env).not.toHaveProperty("STRIPE_WEBHOOK_SECRET"); // not in .env.example
  expect(notes).toContain("db: Drizzle, migrations expected in db/migrations/ (drizzle.config's out), which doesn't exist yet: run `npx drizzle-kit generate` and commit them");
});

test("Laravel (Sail): artisan serve, DB_* for the app and its migrations, MAIL_*, and the app's own compose service skipped", async () => {
  const root = await project({
    "composer.json": JSON.stringify({ require: { php: "^8.2", "laravel/framework": "^12.0" } }),
    artisan: "",
    "bootstrap/app.php": "->withRouting(web: __DIR__.'/../routes/web.php', health: '/up')",
    "database/migrations/0001_01_01_000000_create_users_table.php": "",
    ".env.example": "APP_NAME=Laravel\nDB_CONNECTION=pgsql\nAPP_URL=http://localhost\n",
    "compose.yaml": [
      "services:",
      "  laravel.test:",
      "    build: { context: ./vendor/laravel/sail/runtimes/8.4 }",
      "    image: sail-8.4/app",
      "    ports: ['${APP_PORT:-80}:80']",
      "  pgsql:",
      "    image: 'postgres:17'",
      "  mailpit:",
      "    image: 'axllent/mailpit:latest'",
    ].join("\n"),
  });

  const { config, notes } = await detect(root);

  const db = { DB_CONNECTION: "pgsql", DB_HOST: "{{db.host}}", DB_PORT: "{{db.port}}", DB_DATABASE: "{{db.name}}", DB_USERNAME: "{{db.user}}", DB_PASSWORD: "{{db.password}}" };
  expect(config).toMatchObject({
    app: { command: "php artisan serve --host=127.0.0.1 --port={{app.port}} --no-reload", env: { ...db, MAIL_MAILER: "smtp", MAIL_HOST: "{{mail.host}}", APP_KEY: expect.stringMatching(/^base64:/) }, ready: { path: "/up" } },
    db: { image: "postgres:17", migrate: { command: "php artisan migrate --force", inputs: ["database/migrations"], env: db } },
    mail: true,
  });
  expect(Buffer.from((config.app.env!.APP_KEY as string).slice(7), "base64")).toHaveLength(32);
  expect(config.app.env).not.toHaveProperty("DATABASE_URL");
  expect(config.app.env).not.toHaveProperty("SMTP_HOST");
  expect(config).not.toHaveProperty("containers");
  expect(notes.join("\n")).toContain('service "laravel.test" is built from source');
  // The written config is valid.
  expect(() => resolveOptions(config as never, "/")).not.toThrow();
});

test("a new Laravel project on SQLite, and Symfony with Doctrine migrations", async () => {
  const laravel = await detect(
    await project({ "composer.json": JSON.stringify({ require: { "laravel/framework": "^12.0" } }), artisan: "", ".env.example": "DB_CONNECTION=sqlite\n# DB_HOST=127.0.0.1\n", "database/migrations/1.php": "" }),
  );
  expect(laravel.config.db).toMatchObject({ engine: "sqlite", migrate: { env: { DB_CONNECTION: "sqlite", DB_DATABASE: "{{db.path}}" } } });
  expect(laravel.config.app.env).toMatchObject({ DB_CONNECTION: "sqlite", DB_DATABASE: "{{db.path}}" });

  const symfony = await detect(
    await project({ "composer.json": JSON.stringify({ require: { "symfony/framework-bundle": "7.*", "doctrine/doctrine-migrations-bundle": "^3", "doctrine/orm": "^3" } }), "bin/console": "", "public/index.php": "" }),
  );
  expect(symfony.config).toMatchObject({
    app: { command: "php -S 127.0.0.1:{{app.port}} -t public", env: { DATABASE_URL: "{{db.url}}" } },
    db: { migrate: { command: "php bin/console doctrine:migrations:migrate --no-interaction", inputs: ["migrations"] } },
  });
});

test("ASP.NET Core with EF Core: build once, run with ASPNETCORE_URLS, the connection string for the app and dotnet ef", async () => {
  const csproj = (sdk: string, packages: string[]) =>
    `<Project Sdk="${sdk}"><ItemGroup>${packages.map((p) => `<PackageReference Include="${p}" Version="9.0.0" />`).join("")}</ItemGroup></Project>`;
  const root = await project({
    "Shop.sln": "",
    "src/Shop.Api/Shop.Api.csproj": csproj("Microsoft.NET.Sdk.Web", ["Npgsql.EntityFrameworkCore.PostgreSQL", "Microsoft.EntityFrameworkCore.Design"]),
    "src/Shop.Api/appsettings.json": '﻿{ "ConnectionStrings": { "Shop": "Host=localhost;Database=shop" } }',
    "src/Shop.Api/Program.cs": 'app.MapHealthChecks("/healthz");',
    "src/Shop.Api/Migrations/20260101_Init.cs": "",
    "tests/Shop.Api.Tests/Shop.Api.Tests.csproj": csproj("Microsoft.NET.Sdk", ["xunit"]),
  });

  const { config } = await detect(root);

  const conn = { ConnectionStrings__Shop: "{{db.adoNet}}" };
  expect(config).toMatchObject({
    app: {
      build: "dotnet build src/Shop.Api/Shop.Api.csproj -v q",
      command: "dotnet run --project src/Shop.Api/Shop.Api.csproj --no-build --no-launch-profile",
      env: { ASPNETCORE_URLS: "http://127.0.0.1:{{app.port}}", ...conn },
      ready: { path: "/healthz" },
    },
    db: { migrate: { command: "dotnet ef database update --project src/Shop.Api/Shop.Api.csproj", inputs: ["src/Shop.Api/Migrations"], env: conn } },
  });
  expect(config.app.env).not.toHaveProperty("DATABASE_URL");
  expect(config.app.env).not.toHaveProperty("PORT");
});

test("ASP.NET Core on SQLite or MySQL, and without a database", async () => {
  const web = (packages: string[]) => ({ "Api.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web">${packages.map((p) => `<PackageReference Include="${p}" />`).join("")}</Project>` });
  expect((await detect(await project(web(["Microsoft.EntityFrameworkCore.Sqlite"])))).config).toMatchObject({ db: { engine: "sqlite" }, app: { env: { ConnectionStrings__DefaultConnection: "{{db.adoNet}}" } } });
  expect((await detect(await project(web(["Pomelo.EntityFrameworkCore.MySql"])))).config.db).toMatchObject({ engine: "mysql" });
  const none = await detect(await project(web([])));
  expect(none.config.db).toBe(false);
  expect(JSON.stringify(none.config.app.env)).not.toContain("{{db.");
});

test.each([
  ["Bun", { "package.json": JSON.stringify({ scripts: { start: "bun src/index.ts", build: "bun build" } }), "bun.lock": "" }, { command: "bun run start", build: "bun run build" }],
  ["pnpm", { "package.json": JSON.stringify({ scripts: { dev: "tsx watch src" } }), "pnpm-lock.yaml": "" }, { command: "pnpm run dev" }],
  ["Yarn", { "package.json": JSON.stringify({ scripts: { start: "node ." } }), "yarn.lock": "" }, { command: "yarn run start" }],
  ["Deno with a task", { "deno.jsonc": '{\n  // tasks\n  "tasks": { "start": "deno run -A main.ts" }\n}' }, { command: "deno task start" }],
  ["Deno without tasks", { "deno.json": "{}", "server.ts": "" }, { command: "deno run --allow-net --allow-env --allow-read server.ts" }],
])("starts a %s app with its own runner", async (_, files, app) => {
  expect((await detect(await project(files))).config.app).toMatchObject(app);
});

test("Phoenix runs in prod, where runtime.exs reads PORT and DATABASE_URL, and migrates with Ecto", async () => {
  const { config } = await detect(
    await project({ "mix.exs": "defp deps do\n  [{:phoenix, \"~> 1.8\"}, {:ecto_sql, \"~> 3.12\"}, {:postgrex, \">= 0.0.0\"}]\nend", "priv/repo/migrations/20260101_create_users.exs": "" }),
  );
  expect(config).toMatchObject({
    app: { command: "mix phx.server", build: "mix compile", env: { PORT: "{{app.port}}", DATABASE_URL: "{{db.url}}", MIX_ENV: "prod", PHX_SERVER: "true" } },
    db: { migrate: { command: "mix ecto.migrate", inputs: ["priv/repo/migrations"], env: { MIX_ENV: "prod" } } },
  });
  expect(config.app.env!.SECRET_KEY_BASE!.length).toBeGreaterThanOrEqual(64);
  expect(() => resolveOptions(config as never, "/")).not.toThrow();
});

test("Go without a main package to pick and a Rust workspace say what to set", async () => {
  const go = await detect(await project({ "go.mod": "module x", "cmd/a/main.go": "package main\n", "cmd/b/main.go": "package main\n" }));
  expect(go.config.app.command).toBe("go run .");
  expect(go.notes[0]).toContain("no main package at the root or in cmd/*/: set the package in app.command (`go run ./cmd/server`)");

  const rust = await detect(await project({ "Cargo.toml": '[workspace]\nmembers = ["api"]\n' }));
  expect(rust.notes[0]).toContain("Rust workspace (Cargo.toml): add `-p <crate>` to app.command");
});
