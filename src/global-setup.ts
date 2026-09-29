import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import type { TestProject } from "vitest/node";
import type { ResolvedOptions } from "./config.js";
import { configureContainerRuntime } from "./container-runtime.js";
import { withDatabase } from "./db.js";
import "./provided.js";

const exec = promisify(execFile);

/** Runs once per vitest run: start Postgres, migrate a template database, hand its location to the workers. */
export default async function setup(project: TestProject) {
  const opts = project.getProvidedContext().slicetestOptions;
  let adminUrl: string;
  let stopContainer: (() => Promise<unknown>) | undefined;

  if (opts.db.url) {
    adminUrl = opts.db.url;
  } else {
    configureContainerRuntime();
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const definition = new PostgreSqlContainer(opts.db.image);
    // A reused container is left running and found again by its configuration on the next run.
    if (opts.db.reuse) definition.withReuse();
    const container = await definition.start();
    adminUrl = container.getConnectionUri();
    if (!opts.db.reuse) stopContainer = () => container.stop();
  }

  // Unique per run and project, so parallel runs and projects sharing one server never collide.
  // The timestamp lets a later run recognise databases left behind by a run that was killed.
  const prefix = `${RUN_PREFIX}${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  let template: string;
  try {
    await admin.connect();
    if (!stopContainer) await dropStale(admin);
    const key = opts.db.reuse ? await migrationKey(opts) : undefined;
    template = key ? await cachedTemplate(admin, adminUrl, opts, key, prefix) : await freshTemplate(admin, adminUrl, opts, prefix);
  } catch (e) {
    await admin.end().catch(() => {});
    await stopContainer?.();
    throw e;
  }

  project.provide("slicetestDb", { adminUrl, template, prefix });

  return async () => {
    try {
      if (!stopContainer) {
        // Shared server: drop only the databases this run created.
        const { rows } = await admin.query<{ datname: string }>(
          "SELECT datname FROM pg_database WHERE starts_with(datname, $1)",
          [`${prefix}_`],
        );
        for (const { datname } of rows) await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`);
      }
    } finally {
      await admin.end();
      await stopContainer?.();
    }
  };
}

const RUN_PREFIX = "slicetest_r";
const TEMPLATE_PREFIX = "slicetest_tpl_";
const STALE_MS = 24 * 60 * 60 * 1000;

async function freshTemplate(admin: pg.Client, adminUrl: string, opts: ResolvedOptions, prefix: string) {
  const template = `${prefix}_template`;
  await admin.query(`CREATE DATABASE "${template}"`);
  await migrate(opts, withDatabase(adminUrl, template));
  return template;
}

/**
 * The template for these migrations, built once and kept on the server. Two runs
 * building the same one at once each migrate a private copy; the first rename wins.
 */
async function cachedTemplate(admin: pg.Client, adminUrl: string, opts: ResolvedOptions, key: string, prefix: string) {
  const name = `${TEMPLATE_PREFIX}${key}`;
  const exists = async () => ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount ?? 0) > 0;
  if (await exists()) return name;
  const building = await freshTemplate(admin, adminUrl, opts, prefix);
  try {
    await admin.query(`ALTER DATABASE "${building}" RENAME TO "${name}"`);
  } catch (e) {
    if (!(await exists())) throw e;
    // Another run finished first; its template is the same. Ours is dropped with this run's databases.
  }
  return name;
}

/**
 * A hash of everything that determines the migrated schema, or undefined when
 * that can't be known (a migration command without `inputs`).
 */
export async function migrationKey(opts: Pick<ResolvedOptions, "db" | "root">) {
  const m = opts.db.migrate;
  const hash = createHash("sha256").update(`v1\0${opts.db.image}\0${JSON.stringify(m ?? null)}\0`);
  const inputs = !m ? [] : "atlas" in m ? [atlasDirPath(m.atlas.dir, opts.root)] : "sql" in m ? [path.resolve(opts.root, m.sql)] : m.inputs?.map((p) => path.resolve(opts.root, p));
  if (!inputs) return undefined;
  for (const input of inputs) {
    for (const file of await filesUnder(input)) {
      hash.update(`${path.relative(opts.root, file).replace(/\\/g, "/")}\0`);
      hash.update(await readFile(file));
      hash.update("\0");
    }
  }
  return hash.digest("hex").slice(0, 20);
}

async function filesUnder(target: string): Promise<string[]> {
  const info = await stat(target).catch(() => undefined);
  if (!info) throw new Error(`slicetest: migration input not found: ${target}`);
  if (!info.isDirectory()) return [target];
  const entries = await readdir(target, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

function atlasDirPath(dir: string, root: string) {
  return path.resolve(root, dir.replace(/^file:\/\//, ""));
}

/** Databases from runs that were killed before cleaning up, recognised by the timestamp in their name. */
async function dropStale(admin: pg.Client) {
  const { rows } = await admin.query<{ datname: string }>("SELECT datname FROM pg_database WHERE starts_with(datname, $1)", [RUN_PREFIX]);
  for (const { datname } of rows) {
    const started = parseInt(datname.slice(RUN_PREFIX.length).split("_")[0]!, 36);
    if (Number.isFinite(started) && Date.now() - started > STALE_MS) {
      await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => {});
    }
  }
}

async function migrate(opts: ResolvedOptions, url: string) {
  const m = opts.db.migrate;
  if (!m) return;
  if ("atlas" in m) {
    const dir = atlasDirUrl(m.atlas.dir, opts.root);
    const u = new URL(url);
    if (!u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "disable");
    await run("atlas", ["migrate", "apply", "--url", u.toString(), "--dir", dir], opts.root);
  } else if ("sql" in m) {
    const target = path.resolve(opts.root, m.sql);
    const files = (await stat(target)).isDirectory()
      ? (await readdir(target)).filter((f) => f.endsWith(".sql")).sort().map((f) => path.join(target, f))
      : [target];
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      for (const file of files) await client.query(await readFile(file, "utf8"));
    } finally {
      await client.end();
    }
  } else {
    // Through the platform shell (sh or cmd.exe), like app.command.
    await run(m.command, [], opts.root, { DATABASE_URL: url }, true);
  }
}

/**
 * Atlas wants `file://<path>` with forward slashes. Absolute paths (including
 * Windows drive paths) are made relative to the root, which is the cwd Atlas runs in.
 */
export function atlasDirUrl(dir: string, root: string) {
  if (dir.startsWith("file://")) return dir;
  const rel = path.isAbsolute(dir) || /^[a-zA-Z]:[\\/]/.test(dir) ? path.relative(root, dir) : dir;
  return `file://${rel.replace(/\\/g, "/")}`;
}

async function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}, shell = false) {
  try {
    await exec(cmd, args, { cwd, env: { ...process.env, ...env }, shell, windowsHide: true });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(`slicetest: migration failed: ${cmd} ${args.join(" ")}\n${err.stderr || err.stdout || err.message}`);
  }
}
