import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
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
    const container = await new PostgreSqlContainer(opts.db.image).start();
    adminUrl = container.getConnectionUri();
    stopContainer = () => container.stop();
  }

  // Unique per run and project, so parallel runs and projects sharing one server never collide.
  const prefix = `slicetest_${randomBytes(4).toString("hex")}`;
  const template = `${prefix}_template`;
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${template}"`);
    await migrate(opts, withDatabase(adminUrl, template));
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
