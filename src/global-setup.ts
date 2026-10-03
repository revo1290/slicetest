import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";
import type { ResolvedOptions } from "./config.js";
import { annotation, appendSummary, failureAnnotations, failureSummary, onGitHub, repoPath, yamlFailures } from "./ci.js";
import { interpolate } from "./app.js";
import { connectionVars } from "./connection.js";
import { configureContainerRuntime } from "./container-runtime.js";
import { engineFor } from "./drivers/index.js";
import type { Admin, Engine } from "./drivers/index.js";
import { coverageCacheFile } from "./gen.js";
import { appSpecFile, formatCoverage, formatUsage, OpenApiSpec } from "./openapi.js";
import { mergeRecordings, type Recording } from "./recording.js";
import { applySqlFiles, sqlMigrationFiles } from "./sql-migrations.js";
import "./provided.js";

const exec = promisify(execFile);

/** Runs once per vitest run: start the database server, migrate a template database, hand its location to the workers. */
export default async function setup(project: TestProject) {
  const opts = project.getProvidedContext().slicetestOptions;
  // Builds don't need the database, so they run while it starts.
  const builds = buildAll(opts);
  builds.catch(() => {});
  // No database (`db: false`): nothing to start or migrate, only the builds to wait for.
  const database = opts.db.none ? (await builds, undefined) : await startDatabase(opts, builds);

  // Each worker writes the documented responses it saw here; they are merged when the run ends.
  const coverageDir = opts.openapi.app || opts.openapi.fromApp ? await mkdtemp(path.join(os.tmpdir(), "slicetest-coverage-")) : undefined;
  // Likewise for recordings made against real services, merged into the recordings files at the end.
  const recording = Object.values(opts.recordings).some((r) => r.record);
  const recordDir = recording ? await mkdtemp(path.join(os.tmpdir(), "slicetest-recordings-")) : undefined;
  // On GitHub Actions, failed YAML steps are collected here and turned into annotations at the end.
  const ciDir = onGitHub() ? await mkdtemp(path.join(os.tmpdir(), "slicetest-ci-")) : undefined;
  // Operations the app called on providers whose spec a stub has, reported at the end.
  const usageDir = Object.keys(opts.openapi.stubs).length ? await mkdtemp(path.join(os.tmpdir(), "slicetest-usage-")) : undefined;
  project.provide("slicetestDb", { adminUrl: database?.adminUrl ?? "", template: database?.template ?? "", prefix: database?.prefix ?? "", coverageDir, recordDir, ciDir, usageDir });

  return async () => {
    try {
      await database?.teardown();
    } finally {
      if (coverageDir) await reportCoverage(opts, coverageDir, await partialRun(project));
      if (usageDir) await reportUsage(opts, usageDir);
      if (recordDir) await saveRecordings(opts, recordDir);
      if (ciDir) await reportToGitHub(ciDir);
    }
  };
}

/** Start (or reuse) the database server and migrate a template database for the workers to clone. */
async function startDatabase(opts: ResolvedOptions, builds: Promise<void>) {
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
    await builds;
  } catch (e) {
    await admin?.close().catch(() => {});
    await stopContainer?.();
    throw e;
  }
  const server = admin;
  return {
    adminUrl,
    template,
    prefix,
    async teardown() {
      try {
        if (!stopContainer) {
          // Shared server: drop only the databases this run created.
          for (const name of await server.databases(`${prefix}_`)) await server.drop(name);
        }
      } finally {
        await server.close();
        await stopContainer?.();
      }
    },
  };
}

/**
 * Why this run covers only part of the suite (a file or name filter, tags, a shard), or undefined for a full run.
 * Coverage then says little about the suite, so `minCoverage` isn't enforced and the cache for `gen --uncovered` is kept.
 */
export async function partialRun(project: TestProject): Promise<string | undefined> {
  try {
    const config = project.vitest.config as { testNamePattern?: RegExp; shard?: unknown };
    if (config.testNamePattern) return `only scenarios matching ${config.testNamePattern}`;
    if (process.env.SLICETEST_TAGS) return `only tags ${process.env.SLICETEST_TAGS}`;
    if (config.shard) return "one shard";
    const all = (await project.globTestFiles()).testFiles.length;
    const ran = project.vitest.state.getFiles().filter((f) => f.projectName === project.name).length;
    if (ran > 0 && ran < all) return `${ran} of ${all} files`;
  } catch {
    // An API this Vitest version lacks: treat the run as complete, as before.
  }
  return undefined;
}

async function reportCoverage(opts: ResolvedOptions, dir: string, partial?: string) {
  try {
    const hits = new Set<string>();
    for (const file of await readdir(dir)) {
      for (const key of JSON.parse(await readFile(path.join(dir, file), "utf8")) as string[]) hits.add(key);
    }
    // No scenario ran (e.g. everything filtered out): nothing to report.
    if (hits.size === 0) return;
    // A spec served by the app was saved next to the coverage files by the first worker that fetched it.
    const spec = opts.openapi.fromApp ? await OpenApiSpec.load(appSpecFile(dir), `GET ${opts.openapi.fromApp}`) : await OpenApiSpec.load(path.resolve(opts.root, opts.openapi.app!), opts.openapi.app);
    const report = formatCoverage(spec, hits);
    // For `slicetest gen --uncovered`.
    const cache = coverageCacheFile(opts.root);
    if (!partial) await mkdir(path.dirname(cache), { recursive: true }).then(() => writeFile(cache, JSON.stringify([...hits]))).catch(() => {});
    console.log(`\n${report.text}${partial ? `\n(partial run: ${partial}; openapi.minCoverage is checked on full runs)` : ""}\n`);
    await appendSummary(report.markdown);
    const min = opts.openapi.minCoverage;
    if (min !== undefined && report.percent < min && !partial) {
      // Not thrown: Vitest reports teardown errors as a crash. The failing exit code is what CI needs.
      const message = `OpenAPI coverage ${report.percent}% is below openapi.minCoverage (${min}%)`;
      console.error(`slicetest: ${message}\n`);
      if (onGitHub() && opts.openapi.app) console.log(annotation("error", message, { file: repoPath(path.resolve(opts.root, opts.openapi.app)), title: "slicetest: OpenAPI coverage" }));
      process.exitCode = 1;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(appSpecFile(dir), { force: true });
  }
}

async function reportUsage(opts: ResolvedOptions, dir: string) {
  try {
    const used = new Map<string, Set<string>>();
    for (const file of await readdir(dir)) {
      for (const [name, keys] of Object.entries(JSON.parse(await readFile(path.join(dir, file), "utf8")) as Record<string, string[]>)) {
        const set = used.get(name) ?? new Set<string>();
        for (const k of keys) set.add(k);
        used.set(name, set);
      }
    }
    for (const [name, file] of Object.entries(opts.openapi.stubs)) {
      const keys = used.get(name);
      if (!keys) continue;
      const report = formatUsage(name, await OpenApiSpec.load(path.resolve(opts.root, file), file), keys);
      console.log(`\n${report.text}\n`);
      await appendSummary(report.markdown);
      if (onGitHub() && report.deprecated.length) {
        console.log(annotation("warning", `The app calls operations ${file} marks deprecated: ${report.deprecated.join(", ")}`, { file: repoPath(path.resolve(opts.root, file)), title: `slicetest: deprecated ${name} API` }));
      }
    }
  } catch (e) {
    console.error(`slicetest: couldn't report API usage: ${(e as Error).message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function reportToGitHub(dir: string) {
  try {
    const failures = await yamlFailures(dir);
    for (const line of failureAnnotations(failures)) console.log(line);
    await appendSummary(failureSummary(failures));
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
  const output = await applyMigrations(opts, engine, url, m);
  // Some tools exit 0 when they couldn't connect (drizzle-kit push through a driver that can't reach
  // the server): an empty database after migrating means they did nothing.
  const driver = await engine.driver(url);
  try {
    if ((await driver.listTables(opts.db.schemas, [])).length > 0) return;
  } finally {
    await driver.close();
  }
  const tail = output.trim().split("\n").slice(-15).join("\n");
  throw new Error(
    `slicetest: db.migrate finished without error but created no tables${engine.name === "sqlite" ? "" : ` in ${opts.db.schemas.join(", ")}`}. Check that it reaches the database at DATABASE_URL.${tail ? `\nIts output:\n${tail}` : ""}`,
  );
}

async function applyMigrations(opts: ResolvedOptions, engine: Engine, url: string, m: NonNullable<ResolvedOptions["db"]["migrate"]>): Promise<string> {
  if ("atlas" in m) {
    const dir = atlasDirUrl(m.atlas.dir, opts.root);
    return run("atlas", ["migrate", "apply", "--url", engine.atlasUrl(url), "--dir", dir], opts.root);
  } else if ("sql" in m) {
    const files = await sqlMigrationFiles(path.resolve(opts.root, m.sql));
    const driver = await engine.driver(url);
    try {
      await applySqlFiles(files, (sql) => driver.exec(sql), opts.root);
    } finally {
      await driver.close();
    }
    return "";
  }
  // Through the platform shell (sh or cmd.exe), like app.command, with the same {{db.*}} placeholders.
  const vars: Record<string, string> = { "db.url": url };
  if (engine.name === "sqlite") vars["db.path"] = (await import("./drivers/sqlite.js")).sqlitePath(url);
  Object.assign(vars, connectionVars(engine.name, url, vars["db.path"]));
  const env = Object.fromEntries(Object.entries(m.env ?? {}).map(([k, v]) => [k, interpolate(v, vars, `db.migrate.env.${k}`)]));
  return run(interpolate(m.command, vars, "db.migrate.command"), [], opts.root, { DATABASE_URL: url, ...env }, true);
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

export async function buildAll(opts: Pick<ResolvedOptions, "app" | "services" | "root">) {
  const processes = [["app", opts.app], ...Object.entries(opts.services).map(([n, s]) => [`service ${n}`, s] as const)] as const;
  await Promise.all(
    processes
      .filter(([, p]) => p.build)
      .map(async ([label, p]) => {
        try {
          // The process's literal settings apply to its build too: Next.js inlines NEXT_PUBLIC_* at build
          // time. Values with placeholders ({{db.url}}, …) don't exist yet and are left out.
          const literal = Object.fromEntries(Object.entries(p.env ?? {}).filter(([, v]) => !v.includes("{{")));
          await exec(p.build!, [], { cwd: path.resolve(opts.root, p.cwd ?? "."), env: { ...process.env, ...literal }, shell: true, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
        } catch (e) {
          const err = e as { stdout?: string; stderr?: string; message: string };
          const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().split("\n").slice(-40).join("\n");
          throw new Error(`slicetest: ${label} build failed: ${p.build}\n${output || err.message}`);
        }
      }),
  );
}

async function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}, shell = false) {
  try {
    const { stdout, stderr } = await exec(cmd, args, { cwd, env: { ...process.env, ...env }, shell, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return `${stdout}${stderr}`;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(`slicetest: migration failed: ${cmd} ${args.join(" ")}\n${err.stderr || err.stdout || err.message}`);
  }
}
