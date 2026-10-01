import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { CliConfig } from "./cli.js";
import type { ContainerOptions, DbOptions, MigrateOptions } from "./config.js";

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

  // --- docker compose: the database image and other dependencies ---
  const { db: composeDb, containers, appEnv, mail: composeMail } = await fromCompose(root, notes);
  Object.assign(env, appEnv);
  let mail = composeMail;
  if (!mail && (deps.nodemailer || /\b(flask-mail|fastapi-mail|django-anymail)\b/.test(python) || (has("manage.py") && /EMAIL_HOST/.test(await read(await djangoSettings(root))) ))) {
    mail = true;
    Object.assign(env, { SMTP_HOST: "{{mail.host}}", SMTP_PORT: "{{mail.port}}" });
    notes.push("mail: the app sends mail; slicetest catches it over SMTP (SMTP_HOST / SMTP_PORT, rename them to what your app reads)");
  }
  const sqlite = await detectSqlite(root, read, deps, python, gemfile);
  if (sqlite && !composeDb.engine) {
    composeDb.engine = "sqlite";
    env.DATABASE_URL = sqlite.url;
    notes.push(`db: SQLite (${sqlite.why}), no container needed. The app gets DATABASE_URL=${sqlite.url}; {{db.path}} is the plain file path`);
  }
  const auth = await authFromEnvExample(root, read, env, notes);
  const jwtDeps = ["jose", "jsonwebtoken", "passport-jwt", "express-oauth2-jwt-bearer", "express-jwt", "jwks-rsa", "@fastify/jwt", "next-auth"].filter((d) => deps[d]);
  const jwtPython = /\b(pyjwt|python-jose|authlib|fastapi-azure-auth|djangorestframework-simplejwt)\b/i.exec(python)?.[1];
  if (!auth && (jwtDeps.length || jwtPython)) {
    notes.push(
      `auth: ${jwtDeps[0] ?? jwtPython} is a dependency, so the app may verify JWTs. To test with real tokens, add \`auth: true\` and pass {{auth.issuer}} / {{auth.jwks}} / {{auth.audience}} to the variables the app reads`,
    );
  }
  const stubs = await stubsFromEnvExample(root, read, env, notes);
  const mysqlDeps = !!deps.mysql2 || !!deps.mysql || /\b(pymysql|mysqlclient|aiomysql)\b/.test(python) || /\bgem ['"]mysql2['"]/.test(gemfile);
  if (!composeDb.engine && mysqlDeps) {
    composeDb.engine = "mysql";
    notes.push("db: MySQL (a MySQL driver is a dependency). Install mysql2 and @testcontainers/mysql next to slicetest.");
  }

  // --- OpenAPI ---
  const openapi = ["openapi.yaml", "openapi.yml", "openapi.json", "docs/openapi.yaml", "docs/openapi.yml", "docs/openapi.json"].find(has);
  if (openapi) notes.push(`openapi: ${openapi}. Every response will be checked against it.`);

  const config: CliConfig = {
    app: { command, env, ready: { path: "/" } },
    ...(migrate || Object.keys(composeDb).length ? { db: { ...composeDb, ...(migrate ? { migrate } : {}) } } : {}),
    ...(Object.keys(containers).length ? { containers } : {}),
    ...(mail ? { mail: true } : {}),
    ...(auth ? { auth: true } : {}),
    stubs,
    ...(openapi ? { openapi } : {}),
  };
  return { config, notes };
}

async function djangoSettings(root: string) {
  for (const dir of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (dir.isDirectory() && existsSync(path.join(root, dir.name, "settings.py"))) return path.join(dir.name, "settings.py");
  }
  return "settings.py";
}

/** Where the project says it uses SQLite, and the URL form its framework reads. */
async function detectSqlite(root: string, read: (p: string) => Promise<string>, deps: Record<string, string>, python: string, gemfile: string) {
  if (/provider\s*=\s*"sqlite"/.test(await read("prisma/schema.prisma"))) return { why: "Prisma provider", url: "file:{{db.path}}" };
  if (/adapter:\s*sqlite3/.test(await read("config/database.yml"))) return { why: "config/database.yml", url: "sqlite3:{{db.path}}" };
  if (/\bgem ['"]sqlite3['"]/.test(gemfile) && !/\bgem ['"](pg|mysql2)['"]/.test(gemfile)) return { why: "sqlite3 gem", url: "sqlite3:{{db.path}}" };
  if (existsSync(path.join(root, "manage.py")) && /django\.db\.backends\.sqlite3/.test(await read(await djangoSettings(root)))) {
    return { why: "Django settings; make DATABASES read DATABASE_URL, e.g. with dj-database-url", url: "{{db.url}}" };
  }
  const pgOrMysql = deps.pg || deps.postgres || deps.mysql2 || /\b(psycopg|asyncpg|pymysql|mysqlclient)/.test(python);
  if (!pgOrMysql && (deps["better-sqlite3"] || deps.sqlite3 || deps["@libsql/client"])) return { why: "a SQLite driver is a dependency", url: "{{db.url}}" };
  return undefined;
}

/** Variables that tell the app which token issuer to trust, and what slicetest passes instead. */
const AUTH_VARS: [RegExp, string][] = [
  [/JWKS(_URL|_URI|_ENDPOINT)?$/, "{{auth.jwks}}"],
  [/(ISSUER|ISSUER_URL|ISSUER_BASE_URL|AUTHORITY)$/, "{{auth.issuer}}"],
  [/^(AUTH0|OKTA|KEYCLOAK|COGNITO|OIDC|OAUTH2?|AUTH|JWT)_?(DOMAIN|URL|BASE_URL)$/, "{{auth.issuer}}"],
  [/(AUDIENCE|_AUD)$/, "{{auth.audience}}"],
];

/**
 * `.env.example` variables naming a token issuer (`OIDC_ISSUER`, `AUTH0_DOMAIN`,
 * `JWKS_URL`, `JWT_AUDIENCE`) turn on `auth`, with the variables pointed at
 * slicetest's issuer. Returns whether any was found.
 */
async function authFromEnvExample(root: string, read: (p: string) => Promise<string>, env: Record<string, string>, notes: string[]) {
  const file = [".env.example", ".env.sample", ".env.template", ".env.dist"].find((f) => existsSync(path.join(root, f)));
  if (!file) return false;
  const found: string[] = [];
  for (const line of (await read(file)).split(/\r?\n/)) {
    const name = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    if (!name || name in env) continue;
    const match = AUTH_VARS.find(([re]) => re.test(name));
    // AUDIENCE alone doesn't say the app verifies tokens; it comes along with an issuer or JWKS.
    if (!match) continue;
    env[name] = match[1];
    found.push(name);
  }
  if (!found.some((n) => env[n] !== "{{auth.audience}}")) {
    for (const n of found) delete env[n];
    return false;
  }
  notes.push(`auth: ${found.join(", ")} in ${file} point at slicetest's OpenID issuer; scenarios mint tokens with auth.token({ sub, ... }) or \`auth:\` on a YAML request. An issuer the app expects as a bare domain (Auth0) may need the variable reshaped`);
  return true;
}

/** Hosts that are never third-party APIs to stub. */
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|host\.docker\.internal|[\w-]+$)/;

/**
 * `.env.example` lines like `STRIPE_API_BASE=https://api.stripe.com` name the
 * services the app calls: each becomes a stub recorded from that URL, and the
 * variable points the app at the stub.
 */
async function stubsFromEnvExample(root: string, read: (p: string) => Promise<string>, env: Record<string, string>, notes: string[]) {
  const file = [".env.example", ".env.sample", ".env.template", ".env.dist"].find((f) => existsSync(path.join(root, f)));
  if (!file) return [];
  const stubs: { name: string; upstream: string }[] = [];
  for (const line of (await read(file)).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*["']?(https?:\/\/[^\s"'#]+)/.exec(line);
    if (!m || m[1]! in env || !/(URL|URI|ENDPOINT|HOST|BASE)$/.test(m[1]!) || /DATABASE|REDIS|MONGO|AMQP|SMTP|MAIL|CALLBACK|REDIRECT|FRONTEND|PUBLIC|APP_URL|SITE_URL|WEBHOOK_URL$/.test(m[1]!)) continue;
    const url = new URL(m[2]!);
    if (LOCAL_HOST.test(url.hostname)) continue;
    const base = url.hostname.split(".").filter((p) => !["api", "www", "com", "io", "net", "org", "co", "dev", "app"].includes(p))[0] ?? url.hostname;
    let name = base.replace(/[^\w-]/g, "-").toLowerCase();
    while (stubs.some((s) => s.name === name)) name += "2";
    stubs.push({ name, upstream: url.origin });
    env[m[1]!] = `{{stub.${name}}}${url.pathname.replace(/\/$/, "")}`;
    notes.push(`stubs.${name}: ${m[1]} in ${file} points at ${url.origin}. Record it once with SLICETEST_RECORD=${name}, or register routes in scenarios`);
  }
  return stubs;
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

const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];

/** Development mail servers; `mail: true` does their job in-process. */
const MAIL_CATCHERS = /(^|\/)(mailpit|mailhog|maildev|smtp4dev|greenmail[\w-]*|mailcatcher|inbucket)(:|$)/;

/** Known images: the port they listen on, how to empty them, and the variable apps usually read. */
const KNOWN: { match: RegExp; port: number; reset?: string[]; env?: (name: string) => [string, string] }[] = [
  { match: /(^|\/)(redis|redis-stack|keydb)(:|$)/, port: 6379, reset: ["redis-cli", "FLUSHALL"], env: (n) => ["REDIS_URL", `redis://{{container.${n}}}`] },
  { match: /(^|\/)valkey(:|$)/, port: 6379, reset: ["valkey-cli", "FLUSHALL"], env: (n) => ["REDIS_URL", `redis://{{container.${n}}}`] },
  { match: /(^|\/)memcached(:|$)/, port: 11211 },
  {
    match: /(^|\/)mongo(:|$)/,
    port: 27017,
    reset: ["mongosh", "--quiet", "--eval", "db.getMongo().getDBNames().filter((n) => !['admin', 'config', 'local'].includes(n)).forEach((n) => db.getSiblingDB(n).dropDatabase())"],
    env: (n) => ["MONGODB_URL", `mongodb://{{container.${n}}}`],
  },
  { match: /(^|\/)(elasticsearch|opensearch)(:|$)/, port: 9200, env: (n) => ["ELASTICSEARCH_URL", `http://{{container.${n}}}`] },
  { match: /(^|\/)minio(:|$)/, port: 9000, env: (n) => ["S3_ENDPOINT", `http://{{container.${n}}}`] },
  { match: /(^|\/)rabbitmq(:|$)/, port: 5672, env: (n) => ["AMQP_URL", `amqp://guest:guest@{{container.${n}}}`] },
];

/**
 * Reads docker compose: a postgres / mysql service sets the database engine
 * and image; Redis, Mongo, MinIO and other images become `containers`.
 */
async function fromCompose(root: string, notes: string[]) {
  const db: DbOptions = {};
  const containers: Record<string, ContainerOptions> = {};
  const appEnv: Record<string, string> = {};
  let mail = false;
  const file = COMPOSE_FILES.find((f) => existsSync(path.join(root, f)));
  if (!file) return { db, containers, appEnv, mail };
  let doc: { services?: Record<string, Record<string, any>> };
  try {
    doc = (parse(await readFile(path.join(root, file), "utf8")) ?? {}) as typeof doc;
  } catch (e) {
    notes.push(`${file}: couldn't parse it (${(e as Error).message}); skipped`);
    return { db, containers, appEnv, mail };
  }
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    const image = typeof svc?.image === "string" ? svc.image : undefined;
    if (!image) {
      if (svc?.build) notes.push(`${file}: service "${name}" is built from source; if it's the app, app.command replaces it`);
      continue;
    }
    if (/(^|\/)(postgres|postgis)(:|$)/.test(image) || /(^|\/)postgis\//.test(image)) {
      db.image = image;
      notes.push(`db: Postgres image ${image} (${file} service "${name}")`);
      continue;
    }
    if (/(^|\/)(mysql|mariadb)(:|$)/.test(image)) {
      db.engine = "mysql";
      db.image = image;
      notes.push(`db: MySQL image ${image} (${file} service "${name}"). Install mysql2 and @testcontainers/mysql next to slicetest.`);
      continue;
    }
    if (MAIL_CATCHERS.test(image)) {
      mail = true;
      Object.assign(appEnv, { SMTP_HOST: "{{mail.host}}", SMTP_PORT: "{{mail.port}}" });
      notes.push(`mail: ${image} (${file} service "${name}") is replaced by slicetest's own SMTP server, passed to the app as SMTP_HOST / SMTP_PORT. Rename them to what your app reads`);
      continue;
    }
    const known = KNOWN.find((k) => k.match.test(image));
    const port = known?.port ?? containerPort(svc.ports?.[0] ?? svc.expose?.[0]);
    if (!port) {
      notes.push(`${file}: service "${name}" (${image}) exposes no port; skipped`);
      continue;
    }
    const environment = envOf(svc.environment);
    const command = Array.isArray(svc.command) ? svc.command.map(String) : typeof svc.command === "string" ? svc.command.split(/\s+/).filter(Boolean) : undefined;
    containers[name] = {
      image,
      port,
      ...(Object.keys(environment).length ? { env: environment } : {}),
      ...(command?.length ? { command } : {}),
      ...(known?.reset ? { reset: known.reset } : {}),
    };
    const [key, value] = known?.env?.(name) ?? [];
    if (key && value) appEnv[key] = value;
    notes.push(
      `containers.${name}: ${image} (${file})${key ? `, passed to the app as ${key}` : `, at {{container.${name}}}`}${known?.reset ? "" : ". Add `reset` to empty it between scenarios"}`,
    );
  }
  return { db, containers, appEnv, mail };
}

/** `"6379:6379"`, `"127.0.0.1:5432:5432/tcp"`, `9000`, `{ target: 6379 }` → the port inside the container. */
export function containerPort(spec: unknown): number | undefined {
  if (spec && typeof spec === "object" && "target" in spec) return Number((spec as { target: unknown }).target) || undefined;
  if (typeof spec !== "string" && typeof spec !== "number") return undefined;
  const last = String(spec).split("/")[0]!.split(":").at(-1)!;
  const n = Number(last.split("-")[0]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function envOf(environment: unknown): Record<string, string> {
  if (Array.isArray(environment)) {
    return Object.fromEntries(environment.map(String).filter((e) => e.includes("=")).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
  }
  if (environment && typeof environment === "object") return Object.fromEntries(Object.entries(environment).map(([k, v]) => [k, String(v ?? "")]));
  return {};
}
