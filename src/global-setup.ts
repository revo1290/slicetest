import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";
import type { ResolvedOptions } from "./config.js";
import { configureContainerRuntime } from "./container-runtime.js";
import { engineFor } from "./drivers/index.js";
import type { Admin, Engine } from "./drivers/index.js";
import { coverageCacheFile } from "./gen.js";
import { formatCoverage, OpenApiSpec } from "./openapi.js";
import { mergeRecordings, type Recording } from "./recording.js";
import "./provided.js";

const exec = promisify(execFile);

/** Runs once per vitest run: start the database server, migrate a template database, hand its location to the workers. */
export default async function setup(project: TestProject) {
  const opts = project.getProvidedContext().slicetestOptions;
  const engine = await engineFor(opts);
  let adminUrl: string;
  let stopContainer: (() => Promise<unknown>) | undefined;

  if (opts.db.url) {
    adminUrl = opts.db.url;
  } else {
    if (!engine.local) configureContainerRuntime();
    const container = await engine.startContainer(opts.db.image, opts.db.reuse);
    adminUrl = container.url;
    if (!opts.db.reuse) stopContainer = container.stop;
  }

  // Unique per run and project, so parallel runs and projects sharing one server never collide.
  // The timestamp lets a later run recognise databases left behind by a run that was killed.
  const prefix = `${RUN_PREFIX}${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  let admin: Admin | undefined;
  let template: string;
  try {
    admin = await engine.admin(adminUrl);
    if (!stopContainer) await dropStale(admin);
    const key = opts.db.reuse ? await migrationKey(opts) : undefined;
    template = key ? await cachedTemplate(admin, engine, opts, key) : await freshTemplate(admin, engine, opts, prefix);
  } catch (e) {
    await admin?.close().catch(() => {});
    await stopContainer?.();
    throw e;
  }
  const server = admin;

  // Each worker writes the documented responses it saw here; they are merged when the run ends.
  const coverageDir = opts.openapi.app ? await mkdtemp(path.join(os.tmpdir(), "slicetest-coverage-")) : undefined;
  // Likewise for recordings made against real services, merged into the recordings files at the end.
  const recording = Object.values(opts.recordings).some((r) => r.record);
  const recordDir = recording ? await mkdtemp(path.join(os.tmpdir(), "slicetest-recordings-")) : undefined;
  project.provide("slicetestDb", { adminUrl, template, prefix, coverageDir, recordDir });

  return async () => {
    try {
      if (!stopContainer) {
        // Shared server: drop only the databases this run created.
        for (const name of await server.databases(`${prefix}_`)) await server.drop(name);
      }
    } finally {
      await server.close();
      await stopContainer?.();
      if (coverageDir) await reportCoverage(opts, coverageDir);
      if (recordDir) await saveRecordings(opts, recordDir);
    }
  };
}

async function reportCoverage(opts: ResolvedOptions, dir: string) {
  try {
    const hits = new Set<string>();
    for (const file of await readdir(dir)) {
      for (const key of JSON.parse(await readFile(path.join(dir, file), "utf8")) as string[]) hits.add(key);
    }
    // No scenario ran (e.g. everything filtered out): nothing to report.
    if (hits.size === 0) return;
    const spec = await OpenApiSpec.load(path.resolve(opts.root, opts.openapi.app!), opts.openapi.app);
    const report = formatCoverage(spec, hits);
    // For `slicetest gen --uncovered`.
    const cache = coverageCacheFile(opts.root);
    await mkdir(path.dirname(cache), { recursive: true }).then(() => writeFile(cache, JSON.stringify([...hits]))).catch(() => {});
    console.log(`\n${report.text}\n`);
    const min = opts.openapi.minCoverage;
    if (min !== undefined && report.percent < min) {
      // Not thrown: Vitest reports teardown errors as a crash. The failing exit code is what CI needs.
      console.error(`slicetest: OpenAPI coverage ${report.percent}% is below openapi.minCoverage (${min}%)\n`);
      process.exitCode = 1;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function saveRecordings(opts: ResolvedOptions, dir: string) {
  try {
    const files = await readdir(dir);
    for (const [name, r] of Object.entries(opts.recordings)) {
      const added: Recording[] = [];
      for (const f of files.filter((f) => f.startsWith(`${name}.`)).sort()) added.push(...(JSON.parse(await readFile(path.join(dir, f), "utf8")) as Recording[]));
      if (added.length === 0) continue;
      await mergeRecordings(path.resolve(opts.root, r.file), r.upstream, added);
      console.log(`slicetest: recorded ${added.length} call(s) to ${r.upstream} in ${r.file}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const RUN_PREFIX = "slicetest_r";
const TEMPLATE_PREFIX = "slicetest_tpl_";
const STALE_MS = 24 * 60 * 60 * 1000;

async function freshTemplate(admin: Admin, engine: Engine, opts: ResolvedOptions, prefix: string) {
  const template = `${prefix}_template`;
  await admin.create(template);
  await migrate(opts, engine, admin.urlFor(template));
  return template;
}

/**
 * The template for these migrations, built once and kept on the server. The
 * lock makes concurrent runs wait for the first one instead of building their own.
 */
async function cachedTemplate(admin: Admin, engine: Engine, opts: ResolvedOptions, key: string) {
  const name = `${TEMPLATE_PREFIX}${key}`;
  return admin.withLock(name, async () => {
    if ((await admin.databases(name)).includes(name)) return name;
    await admin.create(name);
    try {
      await migrate(opts, engine, admin.urlFor(name));
    } catch (e) {
      // Never leave a half-migrated template behind for later runs to reuse.
      await admin.drop(name).catch(() => {});
      throw e;
    }
    return name;
  });
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
async function dropStale(admin: Admin) {
  for (const datname of await admin.databases(RUN_PREFIX)) {
    const started = parseInt(datname.slice(RUN_PREFIX.length).split("_")[0]!, 36);
    if (Number.isFinite(started) && Date.now() - started > STALE_MS) {
      await admin.drop(datname).catch(() => {});
    }
  }
}

async function migrate(opts: ResolvedOptions, engine: Engine, url: string) {
  const m = opts.db.migrate;
  if (!m) return;
  if ("atlas" in m) {
    const dir = atlasDirUrl(m.atlas.dir, opts.root);
    await run("atlas", ["migrate", "apply", "--url", engine.atlasUrl(url), "--dir", dir], opts.root);
  } else if ("sql" in m) {
    const target = path.resolve(opts.root, m.sql);
    const files = (await stat(target)).isDirectory()
      ? (await readdir(target)).filter((f) => f.endsWith(".sql")).sort().map((f) => path.join(target, f))
      : [target];
    const driver = await engine.driver(url);
    try {
      for (const file of files) await driver.exec(await readFile(file, "utf8"));
    } finally {
      await driver.close();
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
