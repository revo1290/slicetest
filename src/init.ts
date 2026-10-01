import { existsSync, readFileSync } from "node:fs";
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

/** SDKs whose API hosts are written into them: a stub with `hosts` answers there. Packages are npm or PyPI names. */
const KNOWN_APIS: { packages: string[]; stub: string; hosts: string[]; env: Record<string, string> }[] = [
  { packages: ["stripe"], stub: "stripe", hosts: ["api.stripe.com"], env: { STRIPE_SECRET_KEY: "sk_test_slicetest", STRIPE_WEBHOOK_SECRET: "whsec_slicetest" } },
  { packages: ["@anthropic-ai/sdk", "anthropic"], stub: "anthropic", hosts: ["api.anthropic.com"], env: { ANTHROPIC_API_KEY: "sk-ant-slicetest" } },
  { packages: ["openai"], stub: "openai", hosts: ["api.openai.com"], env: { OPENAI_API_KEY: "sk-slicetest" } },
  { packages: ["resend"], stub: "resend", hosts: ["api.resend.com"], env: { RESEND_API_KEY: "re_slicetest" } },
  { packages: ["@sendgrid/mail", "sendgrid"], stub: "sendgrid", hosts: ["api.sendgrid.com"], env: { SENDGRID_API_KEY: "SG.slicetest" } },
  { packages: ["@slack/web-api", "slack_sdk"], stub: "slack", hosts: ["slack.com"], env: { SLACK_BOT_TOKEN: "xoxb-slicetest" } },
  { packages: ["@octokit/rest", "octokit", "PyGithub"], stub: "github", hosts: ["api.github.com"], env: { GITHUB_TOKEN: "ghp_slicetest" } },
  { packages: ["twilio"], stub: "twilio", hosts: ["api.twilio.com"], env: { TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000", TWILIO_AUTH_TOKEN: "slicetest" } },
];

/** Files that mark a directory as an app slicetest can start. */
const APP_MARKERS = ["manage.py", "requirements.txt", "pyproject.toml", "Gemfile", "go.mod", "Cargo.toml", "build.gradle", "build.gradle.kts", "pom.xml"];
/** Build files of a Gradle or Maven multi-project build (two levels down), for dependencies declared in a subproject. */
async function subprojectBuildFiles(dir: string, gradle: boolean) {
  const names = gradle ? ["build.gradle", "build.gradle.kts"] : ["pom.xml"];
  const texts: string[] = [];
  const walk = async (d: string, depth: number) => {
    if (depth > 2) return;
    for (const entry of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || ["build", "target", "node_modules", "src", "gradle"].includes(entry.name)) continue;
      const sub = path.join(d, entry.name);
      for (const n of names) if (existsSync(path.join(sub, n))) texts.push(await readFile(path.join(sub, n), "utf8"));
      await walk(sub, depth + 1);
    }
  };
  await walk(dir, 1);
  return texts;
}

/** Where monorepos usually keep the server, when the root isn't one. */
const APP_DIRS = ["backend", "server", "api", "app", "service"];

function runnable(dir: string) {
  if (APP_MARKERS.some((f) => existsSync(path.join(dir, f)))) return true;
  try {
    const scripts = (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
    return !!(scripts.start || scripts.dev);
  } catch {
    return false;
  }
}

export async function detect(root: string): Promise<Detected> {
  const notes: string[] = [];
  // The app may live in a subdirectory (backend/, server/, …); everything about the app is read there.
  const appDir = runnable(root) ? "" : (APP_DIRS.find((d) => runnable(path.join(root, d))) ?? "");
  if (appDir) notes.push(`app: in ${appDir}/ (app.cwd); commands for it run there`);
  const appRoot = path.join(root, appDir);
  const has = (p: string) => existsSync(path.join(appRoot, p));
  const read = async (p: string) => (has(p) ? readFile(path.join(appRoot, p), "utf8") : "");
  const pkg = has("package.json") ? (JSON.parse(await read("package.json")) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }) : undefined;
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const python = `${await read("requirements.txt")}\n${await read("pyproject.toml")}`.toLowerCase();
  const gemfile = await read("Gemfile");

  // --- app ---
  let command = TODO_COMMAND;
  let jvmBuild: string | undefined;
  let build: string | undefined;
  let readyPath = "/";
  let scope: "worker" | undefined;
  let workers: number | undefined;
  let readyTimeout: number | undefined;
  const env: Record<string, string> = { PORT: "{{app.port}}", DATABASE_URL: "{{db.url}}" };
  if (pkg?.scripts?.start) {
    command = "npm start";
    notes.push("app: `npm start` (package.json start script). It must listen on $PORT.");
    if (pkg.scripts.build) {
      // Otherwise `next start` and the like serve whatever was built last, and scenarios pass against stale code.
      build = "npm run build";
      notes.push("app: `npm run build` once per run, before starting (package.json build script).");
    }
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
  } else if (has("build.gradle") || has("build.gradle.kts") || has("pom.xml")) {
    const gradle = !has("pom.xml");
    const buildFile = await read(gradle ? (has("build.gradle.kts") ? "build.gradle.kts" : "build.gradle") : "pom.xml");
    jvmBuild = [buildFile, ...(await subprojectBuildFiles(appRoot, gradle))].join("\n");
    const wrapper = gradle ? (process.platform === "win32" ? "gradlew.bat" : "./gradlew") : process.platform === "win32" ? "mvnw.cmd" : "./mvnw";
    const tool = has(gradle ? "gradlew" : "mvnw") ? wrapper : gradle ? "gradle" : "mvn";
    if (/spring-boot|org\.springframework\.boot/.test(buildFile)) {
      // Built once up front: bootRun / spring-boot:run in several workers would otherwise all compile
      // changed sources at the same moment, and download missing dependencies while the app runs
      // with slicetest's proxy settings (which `offline` refuses). bootJar / package resolve them all.
      build = gradle ? `${tool} bootJar -q` : `${tool} -q package -DskipTests`;
      command = gradle ? `${tool} bootRun -q` : `${tool} -q spring-boot:run`;
      // Spring reads these variables (relaxed binding).
      delete env.PORT;
      delete env.DATABASE_URL;
      Object.assign(env, {
        SERVER_PORT: "{{app.port}}",
        SPRING_DATASOURCE_URL: "{{db.jdbcUrl}}",
        SPRING_DATASOURCE_USERNAME: "{{db.user}}",
        SPRING_DATASOURCE_PASSWORD: "{{db.password}}",
      });
      readyTimeout = 120_000;
      // A JVM takes seconds to start: start it once per worker, and only in a couple of workers.
      scope = "worker";
      workers = 2;
      if (/actuator/.test(buildFile) || (await subprojectBuildFiles(appRoot, gradle)).some((t) => /actuator/.test(t))) readyPath = "/actuator/health";
      notes.push(`app: Spring Boot (${gradle ? "Gradle" : "Maven"}). SERVER_PORT and SPRING_DATASOURCE_* override application.yml; {{db.jdbcUrl}} is the JDBC URL`);
      notes.push("app: started once per worker (scope: worker) in 2 workers (workers: 2), since the JVM takes seconds to start");
    } else {
      command = gradle ? `${tool} run -q` : `${tool} -q exec:java`;
      notes.push(`app: ${gradle ? "Gradle" : "Maven"} project. Check the command; the app must listen on the port in {{app.port}}`);
    }
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
  const migrationsSql = has("migrations") && (await readdir(path.join(appRoot, "migrations"))).some((f) => f.endsWith(".sql"));
  const atlas = await findAtlas(root, appDir);
  if (atlas) {
    migrate = { atlas: { dir: `file://${atlas}` } };
    notes.push(`db: Atlas migrations in ${atlas}/`);
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
    // drizzle-kit migrate/push connect with whatever driver the project has (with only Neon's,
    // over a WebSocket that a local server doesn't answer); the generated SQL needs no driver.
    const configFile = ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs", "drizzle.config.json"].find(has);
    const out = (configFile && /\bout\s*:\s*["'`]([^"'`]+)["'`]/.exec(await read(configFile))?.[1]?.replace(/^\.\//, "")) || "drizzle";
    migrate = { sql: out };
    notes.push(
      has(out)
        ? `db: Drizzle migrations in ${out}/, applied as SQL in name order`
        : `db: Drizzle, migrations expected in ${out}/ (drizzle.config's out), which doesn't exist yet: run \`npx drizzle-kit generate\` and commit them`,
    );
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

  // Migrations found in the app's directory: their paths are relative to it, and commands run there.
  if (appDir && migrate && !("atlas" in migrate)) {
    if ("sql" in migrate) migrate = { sql: path.posix.join(appDir, migrate.sql) };
    else migrate = { command: `cd ${appDir} && ${migrate.command}`, ...(migrate.inputs ? { inputs: migrate.inputs.map((i) => path.posix.join(appDir, i)) } : {}) };
  }

  // --- docker compose: the database image and other dependencies ---
  const { db: composeDb, containers, appEnv, mail: composeMail } = await fromCompose(root, notes, [...new Set(["", appDir])]);
  Object.assign(env, appEnv);
  let mail = composeMail;
  if (!mail && (deps.nodemailer || /\b(flask-mail|fastapi-mail|django-anymail)\b/.test(python) || (has("manage.py") && /EMAIL_HOST/.test(await read(await djangoSettings(appRoot))) ))) {
    mail = true;
    Object.assign(env, { SMTP_HOST: "{{mail.host}}", SMTP_PORT: "{{mail.port}}" });
    notes.push("mail: the app sends mail; slicetest catches it over SMTP (SMTP_HOST / SMTP_PORT, rename them to what your app reads)");
  }
  const sqlite = await detectSqlite(appRoot, read, deps, python, gemfile);
  if (sqlite && !composeDb.engine) {
    composeDb.engine = "sqlite";
    env.DATABASE_URL = sqlite.url;
    notes.push(`db: SQLite (${sqlite.why}), no container needed. The app gets DATABASE_URL=${sqlite.url}; {{db.path}} is the plain file path`);
  }
  let authClerk = false;
  const auth = await authFromEnvExample(appRoot, read, env, notes);
  const jwtDeps = ["jose", "jsonwebtoken", "passport-jwt", "express-oauth2-jwt-bearer", "express-jwt", "jwks-rsa", "@fastify/jwt", "next-auth"].filter((d) => deps[d]);
  const jwtPython = /\b(pyjwt|python-jose|authlib|fastapi-azure-auth|djangorestframework-simplejwt)\b/i.exec(python)?.[1];
  if (!auth && (jwtDeps.length || jwtPython)) {
    notes.push(
      `auth: ${jwtDeps[0] ?? jwtPython} is a dependency, so the app may verify JWTs. To test with real tokens, add \`auth: true\` and pass {{auth.issuer}} / {{auth.jwks}} / {{auth.audience}} to the variables the app reads`,
    );
  }
  const stubs: NonNullable<CliConfig["stubs"]> = await stubsFromEnvExample(appRoot, read, env, notes);
  const envExample = [".env.example", ".env.sample", ".env.template", ".env.dist"].map((f) => (has(f) ? f : "")).find(Boolean);
  const exampleText = envExample ? await read(envExample) : "";
  for (const api of KNOWN_APIS) {
    if (!api.packages.some((p) => deps[p] || new RegExp(`\\b${p.replace(/[^\w-]/g, "")}\\b`).test(python))) continue;
    if (stubs.some((s) => (typeof s === "string" ? s : s.name) === api.stub)) continue;
    stubs.push({ name: api.stub, hosts: api.hosts });
    // Placeholder credentials for the variables the app is documented to read; the stub doesn't check them.
    for (const [k, v] of Object.entries(api.env)) if (!(k in env) && new RegExp(`^\\s*${k}\\s*=`, "m").test(exampleText)) env[k] = v;
    notes.push(`stubs.${api.stub}: ${api.packages.find((p) => deps[p]) ?? api.packages[0]} calls ${api.hosts.join(", ")}; the stub answers there (register its routes in scenarios)`);
  }
  if (deps["@clerk/nextjs"] || deps["@clerk/express"] || deps["@clerk/backend"]) {
    // A publishable key is the Frontend API host, base64-encoded with a trailing "$".
    env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= `pk_test_${Buffer.from("clerk.slicetest.test$").toString("base64")}`;
    env.CLERK_SECRET_KEY ??= "sk_test_slicetest";
    authClerk = true;
    stubs.push({ name: "clerk", hosts: ["api.clerk.com", "clerk.slicetest.test"] });
    notes.push("auth: Clerk. Sessions are tokens from slicetest's issuer (auth: true); the clerk stub serves its keys at /v1/jwks and users at /v1/users/:id. See the README's Clerk section");
  }
  notes.push("network: URLs written in the code (https://api.example.com) can be stubbed with `hosts`. Add `offline: true` and the first run names every host the app calls");
  const mysqlDeps = !!deps.mysql2 || !!deps.mysql || /\b(pymysql|mysqlclient|aiomysql)\b/.test(python) || /\bgem ['"]mysql2['"]/.test(gemfile);
  if (!composeDb.engine && mysqlDeps) {
    composeDb.engine = "mysql";
    notes.push("db: MySQL (a MySQL driver is a dependency). Install mysql2 and @testcontainers/mysql next to slicetest.");
  }

  // --- OpenAPI ---
  const openapi = ["openapi.yaml", "openapi.yml", "openapi.json", "docs/openapi.yaml", "docs/openapi.yml", "docs/openapi.json"].find(has);
  if (openapi) notes.push(`openapi: ${openapi}. Every response will be checked against it.`);

  const neon = !!(deps["@neondatabase/serverless"] || deps["@vercel/postgres"]);
  if (neon) notes.push("db: Neon's serverless driver (db.neon): DATABASE_URL is a Neon-style URL whose HTTP queries slicetest answers from the test database");

  // An app with no migrations, no database in compose and no database library gets no database at all.
  const dbLibrary =
    Object.keys(deps).some((d) => /^(pg|postgres|mysql2?|@prisma\/client|prisma|drizzle-orm|knex|typeorm|sequelize|kysely|better-sqlite3|sqlite3|@neondatabase\/serverless|@vercel\/postgres|@libsql\/client|mongoose|mongodb)$/.test(d)) ||
    /data-jpa|data-jdbc|spring-jdbc|r2dbc|postgresql|mysql|flyway|liquibase|hibernate/.test(jvmBuild ?? "") ||
    /\b(psycopg|sqlalchemy|asyncpg|pymysql|mysqlclient|django|peewee|tortoise|sqlmodel)\b/.test(python) ||
    /\b(rails|activerecord|sequel|pg|mysql2|sqlite3)\b/.test(gemfile);
  const knownStack = !!pkg || jvmBuild !== undefined || python.trim().length > 0 || gemfile.length > 0;
  const noDb = knownStack && !dbLibrary && !migrate && !composeDb.engine && !composeDb.image && !has("manage.py");
  if (noDb) {
    for (const k of ["DATABASE_URL", "SPRING_DATASOURCE_URL", "SPRING_DATASOURCE_USERNAME", "SPRING_DATASOURCE_PASSWORD"]) delete env[k];
    const i = notes.indexOf("db: no migrations found; the database starts empty. Set db.migrate.");
    if (i >= 0) notes.splice(i, 1);
    notes.push("db: none (no migrations, no database in compose, no database library), so `db: false`: no container is started");
  }

  const config: CliConfig = {
    app: { ...(appDir ? { cwd: appDir } : {}), command, ...(build ? { build } : {}), env, ready: { path: readyPath }, ...(readyTimeout ? { readyTimeout } : {}), ...(scope ? { scope } : {}) },
    ...(workers ? { workers } : {}),
    ...(noDb ? { db: false as const } : migrate || neon || Object.keys(composeDb).length ? { db: { ...composeDb, ...(neon ? { neon: true } : {}), ...(migrate ? { migrate } : {}) } } : {}),
    ...(Object.keys(containers).length ? { containers } : {}),
    ...(mail ? { mail: true } : {}),
    ...(auth || authClerk ? { auth: true } : {}),
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

/**
 * A first scenario against the path the app is checked for readiness on. At `/` an API often
 * answers 404, so there it only checks that the app answers (and doesn't crash).
 */
const scenario = (readyPath: string) => `# yaml-language-server: $schema=https://unpkg.com/slicetest/schema/scenario.schema.json
# A first scenario. Run it with: npx slicetest
scenarios:
  - name: the app answers
    steps:
      - request: GET ${readyPath}
${readyPath === "/" ? "        # expect: { status: 200 }   (what should / answer? An API often has no page there)\n" : "        expect: { status: 200 }\n"}`;

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
  await writeFile(scenarioFile, scenario((config.app.ready as { path?: string } | undefined)?.path ?? "/"));
  return { files: [configFile, scenarioFile].map((f) => path.relative(root, f)), notes };
}

const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml", "podman-compose.yml", "podman-compose.yaml"];

/**
 * The Atlas migrations directory, relative to the project root: from an atlas.hcl's
 * `dir = "file://..."` (in the root, the app's directory or atlas/, db/), else a
 * migrations/ folder with an atlas.sum.
 */
async function findAtlas(root: string, appDir: string) {
  for (const dir of [...new Set(["", appDir, "atlas", "db", "database"])]) {
    const hcl = path.join(root, dir, "atlas.hcl");
    if (!existsSync(hcl)) continue;
    const found = /\bdir\s*=\s*"file:\/\/([^"]+)"/.exec(await readFile(hcl, "utf8"))?.[1];
    const rel = path.posix.join(dir.replace(/\\/g, "/"), (found ?? "migrations").replace(/^\.\//, ""));
    if (existsSync(path.join(root, rel))) return rel;
  }
  for (const dir of [...new Set(["migrations", path.posix.join(appDir, "migrations")])]) {
    if (existsSync(path.join(root, dir, "atlas.sum"))) return dir;
  }
  return undefined;
}

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
async function fromCompose(root: string, notes: string[], dirs: string[] = [""]) {
  const db: DbOptions = {};
  const containers: Record<string, ContainerOptions> = {};
  const appEnv: Record<string, string> = {};
  let mail = false;
  const file = dirs.flatMap((d) => COMPOSE_FILES.map((f) => path.join(d, f))).find((f) => existsSync(path.join(root, f)));
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
