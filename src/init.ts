import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import type { CliConfig } from "./cli.js";
import type { MigrateOptions } from "./config.js";

/**
 * `npx slicetest init`: look at a project and write a starting
 * slicetest.config.yaml plus one scenario. Detection is best effort; every
 * guess is listed so the user knows what to check.
 */

export interface Detected {
  config: CliConfig;
  /** One line per guess, e.g. "app: package.json has a start script". */
  notes: string[];
}

const TODO_COMMAND = "echo 'TODO: the command that starts your app' && exit 1";

export async function detect(root: string): Promise<Detected> {
  const notes: string[] = [];
  const has = (p: string) => existsSync(path.join(root, p));
  const read = async (p: string) => (has(p) ? readFile(path.join(root, p), "utf8") : "");
  const pkg = has("package.json") ? (JSON.parse(await read("package.json")) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }) : undefined;
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const python = `${await read("requirements.txt")}\n${await read("pyproject.toml")}`.toLowerCase();
  const gemfile = await read("Gemfile");

  // --- app ---
  let command = TODO_COMMAND;
  const env: Record<string, string> = { PORT: "{{app.port}}", DATABASE_URL: "{{db.url}}" };
  if (pkg?.scripts?.start) {
    command = "npm start";
    notes.push("app: `npm start` (package.json start script). It must listen on $PORT.");
  } else if (pkg?.scripts?.dev) {
    command = "npm run dev";
    notes.push("app: `npm run dev` (no start script). A production start command is usually faster to boot.");
  } else if (has("manage.py")) {
    command = "python manage.py runserver 127.0.0.1:{{app.port}} --noreload";
    notes.push("app: Django (manage.py)");
  } else if (python.includes("uvicorn") || python.includes("fastapi")) {
    command = "uvicorn main:app --port {{app.port}}";
    notes.push("app: FastAPI/uvicorn. Adjust `main:app` to your module.");
  } else if (python.includes("flask")) {
    command = "flask run --port {{app.port}}";
    notes.push("app: Flask");
  } else if (/\brails\b/.test(gemfile)) {
    command = "bin/rails server -p {{app.port}}";
    notes.push("app: Rails");
  } else if (has("go.mod")) {
    command = "go run .";
    notes.push("app: Go (go.mod). It must listen on $PORT.");
  } else if (has("Cargo.toml")) {
    command = "cargo run";
    notes.push("app: Rust (Cargo.toml). It must listen on $PORT.");
  } else {
    notes.push("app: couldn't tell how to start the app. Set app.command.");
  }

  // --- migrations ---
  let migrate: MigrateOptions | undefined;
  const migrationsSql = has("migrations") && (await readdir(path.join(root, "migrations"))).some((f) => f.endsWith(".sql"));
  if (has("atlas.hcl") || has("migrations/atlas.sum")) {
    migrate = { atlas: { dir: "file://migrations" } };
    notes.push("db: Atlas migrations in migrations/");
  } else if (has("prisma/schema.prisma")) {
    migrate = { command: "npx prisma migrate deploy", inputs: ["prisma/migrations"] };
    notes.push("db: Prisma (prisma migrate deploy)");
  } else if (has("alembic.ini")) {
    const location = /^\s*script_location\s*=\s*(\S+)/m.exec(await read("alembic.ini"))?.[1] ?? "alembic";
    migrate = { command: "alembic upgrade head", inputs: [path.posix.join(location.replace("%(here)s/", ""), "versions")] };
    notes.push("db: Alembic (alembic upgrade head)");
  } else if (has("manage.py")) {
    migrate = { command: "python manage.py migrate" };
    notes.push("db: Django migrations. Add `inputs` (your apps' migrations dirs) to cache them between runs.");
  } else if (/\brails\b/.test(gemfile) && has("db/migrate")) {
    migrate = { command: "bin/rails db:migrate", inputs: ["db/migrate"] };
    notes.push("db: Rails migrations");
  } else if (deps["drizzle-kit"]) {
    migrate = { command: "npx drizzle-kit migrate", inputs: ["drizzle"] };
    notes.push("db: Drizzle (drizzle-kit migrate). Check that `inputs` points at your migrations folder.");
  } else if (deps.knex) {
    migrate = { command: "npx knex migrate:latest", inputs: ["migrations"] };
    notes.push("db: Knex migrations");
  } else if (migrationsSql) {
    migrate = { sql: "migrations" };
    notes.push("db: plain SQL files in migrations/, applied in name order");
  } else if (has("schema.sql")) {
    migrate = { sql: "schema.sql" };
    notes.push("db: schema.sql");
  } else {
    notes.push("db: no migrations found; the database starts empty. Set db.migrate.");
  }

  // --- OpenAPI ---
  const openapi = ["openapi.yaml", "openapi.yml", "openapi.json", "docs/openapi.yaml", "docs/openapi.yml", "docs/openapi.json"].find(has);
  if (openapi) notes.push(`openapi: ${openapi}. Every response will be checked against it.`);

  const config: CliConfig = {
    app: { command, env, ready: { path: "/" } },
    ...(migrate ? { db: { migrate } } : {}),
    stubs: [],
    ...(openapi ? { openapi } : {}),
  };
  return { config, notes };
}

const SCENARIO = `# yaml-language-server: $schema=https://unpkg.com/slicetest/schema/scenario.schema.json
# A first scenario. Run it with: npx slicetest
scenarios:
  - name: the app answers
    steps:
      - request: GET /
        expect: { status: 200 }
`;

export async function init(root: string, { force = false } = {}) {
  const configFile = path.join(root, "slicetest.config.yaml");
  const scenarioFile = path.join(root, "scenarios", "smoke.scenario.yaml");
  const existing = [configFile, scenarioFile].filter((f) => existsSync(f));
  if (existing.length && !force) {
    throw new Error(`slicetest: ${existing.map((f) => path.relative(root, f)).join(", ")} already exists. Use --force to overwrite.`);
  }
  const { config, notes } = await detect(root);
  const header = [
    "# slicetest config, generated by `npx slicetest init`. Paths are relative to this file.",
    "# Everything the Vitest plugin accepts works here: https://github.com/revo1290/slicetest#configuration-reference",
    "#",
    ...notes.map((n) => `# - ${n}`),
    "",
  ].join("\n");
  await writeFile(configFile, `${header}${stringify(config)}`);
  await mkdir(path.dirname(scenarioFile), { recursive: true });
  await writeFile(scenarioFile, SCENARIO);
  return { files: [configFile, scenarioFile].map((f) => path.relative(root, f)), notes };
}
