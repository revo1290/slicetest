import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { seedRows } from "./db.js";
import { resolveOptions, seedFiles, type ResolvedOptions, type SlicetestOptions } from "./config.js";
import { configureContainerRuntime, loadContainers } from "./container-runtime.js";
import { engineFor } from "./drivers/index.js";
import { OpenApiSpec } from "./openapi.js";

/**
 * `slicetest doctor`: everything a run needs, checked up front, each problem
 * with what to do about it. Meant for a first setup and for CI logs, where a
 * container runtime that isn't there otherwise shows up as a timeout.
 */
export interface Check {
  status: "ok" | "warn" | "fail";
  label: string;
  /** What was found, or what to do. */
  detail?: string;
}

/** Things that touch the machine, replaceable in tests. */
export interface Probes {
  containerRuntime(): Promise<string>;
  database(opts: ResolvedOptions, url: string): Promise<void>;
  command(name: string, args: string[]): Promise<string>;
  resolvePackage(name: string, from: string): boolean;
}

const exec = promisify(execFile);

export const machine: Probes = {
  async containerRuntime() {
    configureContainerRuntime();
    const { getContainerRuntimeClient } = await loadContainers(() => import("testcontainers"));
    const client = await withTimeout(getContainerRuntimeClient(), 15_000, "no answer from the container runtime");
    const { containerRuntime: rt } = client.info;
    return `${rt.operatingSystem} ${rt.serverVersion} at ${rt.host}`;
  },
  async database(opts, url) {
    const admin = await withTimeout((await engineFor(opts)).admin(url), 10_000, "connection timed out");
    await admin.close();
  },
  async command(name, args) {
    const { stdout, stderr } = await exec(name, args, { windowsHide: true, timeout: 10_000, shell: process.platform === "win32" });
    return (stdout || stderr).trim().split(/\r?\n/)[0]!;
  },
  resolvePackage(name, from) {
    try {
      createRequire(path.join(from, "noop.js")).resolve(`${name}/package.json`);
      return true;
    } catch {
      try {
        createRequire(import.meta.url).resolve(name);
        return true;
      } catch {
        return false;
      }
    }
  },
};

export async function doctor(configPath: string | undefined, probes: Probes = machine, env = process.env): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (status: Check["status"], label: string, detail?: string) => checks.push({ status, label, ...(detail ? { detail } : {}) });

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20 ? "ok" : "fail", `Node.js ${process.versions.node}`, major >= 20 ? undefined : "slicetest needs Node.js 20 or later");

  if (!configPath || !existsSync(configPath)) {
    add("warn", "no slicetest.config.yaml", "checked the machine only. `npx slicetest init` writes a config; with the Vitest plugin, pass the same options to --config as YAML to check them");
    await checkContainerRuntime(add, probes);
    return checks;
  }
  const root = path.dirname(configPath);
  const rel = (p: string) => path.relative(process.cwd(), path.resolve(root, p)) || ".";

  let opts: ResolvedOptions;
  try {
    const raw = (parse(await readFile(configPath, "utf8")) ?? {}) as SlicetestOptions & { include?: unknown };
    delete raw.include;
    opts = resolveOptions(raw, root);
    add("ok", `config ${rel(configPath)}`);
  } catch (e) {
    add("fail", `config ${rel(configPath)}`, (e as Error).message.replace(/^slicetest: /, ""));
    return checks;
  }

  // Database: a server that's there already, or a container runtime to start one in.
  const url = opts.db.engine === "sqlite" ? undefined : (opts.db.url ?? env.SLICETEST_DATABASE_URL);
  if (opts.db.none) {
    add("ok", "no database (db: false)");
    if (Object.keys(opts.containers).length) await checkContainerRuntime(add, probes, `runs ${Object.values(opts.containers).map((c) => c.image).join(", ")}`);
  } else if (opts.db.engine === "sqlite") {
    const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
    if (maj > 22 || (maj === 22 && min >= 5)) add("ok", "sqlite (node:sqlite, no server needed)");
    else add("fail", "sqlite needs Node.js 22.5 or later", `this is ${process.versions.node}; slicetest uses the built-in node:sqlite`);
    if (Object.keys(opts.containers).length) await checkContainerRuntime(add, probes, `runs ${Object.values(opts.containers).map((c) => c.image).join(", ")}`);
  } else if (url) {
    try {
      await probes.database(opts, url);
      add("ok", `${opts.db.engine} at ${redact(url)}`);
    } catch (e) {
      add("fail", `${opts.db.engine} at ${redact(url)}`, `can't connect: ${(e as Error).message}. It must be a superuser (root) connection that can create databases`);
    }
  } else {
    await checkContainerRuntime(add, probes, `runs ${[opts.db.image, ...Object.values(opts.containers).map((c) => c.image)].join(", ")}`);
  }
  if (opts.db.engine === "mysql") {
    for (const pkg of ["mysql2", ...(url ? [] : ["@testcontainers/mysql"])]) {
      if (probes.resolvePackage(pkg, root)) add("ok", `${pkg} installed`);
      else add("fail", `${pkg} not installed`, `db.engine "mysql" needs it: npm i -D ${pkg}`);
    }
  }

  const m = opts.db.migrate;
  if (opts.db.none) {
    // Nothing to migrate.
  } else if (!m) add("warn", "db.migrate not set", "scenarios run against an empty database unless the app creates its own tables");
  else if ("atlas" in m) {
    await checkPath(add, "migrations", m.atlas.dir.replace(/^file:\/\//, ""), root, rel);
    try {
      add("ok", `atlas CLI (${await probes.command("atlas", ["version"])})`);
    } catch {
      add("fail", "atlas CLI not found", "db.migrate.atlas runs `atlas migrate apply`. Install it: https://atlasgo.io/getting-started");
    }
  } else if ("sql" in m) await checkPath(add, "migrations", m.sql, root, rel);
  else for (const input of m.inputs ?? []) await checkPath(add, "migration input", input, root, rel);
  for (const file of seedFiles(opts.db.seed)) {
    if (!/\.(ya?ml|json)$/i.test(file)) {
      await checkPath(add, "seed", file, root, rel);
      continue;
    }
    // A data seed is read here, so a broken one is reported before any container starts.
    let text: string;
    try {
      text = await readFile(path.resolve(root, file), "utf8");
    } catch {
      await checkPath(add, "seed", file, root, rel);
      continue;
    }
    try {
      const tables = seedRows(file, text);
      add("ok", `seed ${rel(file)} (${tables.map(([t, rows]) => `${t} ×${rows.length}`).join(", ") || "no tables"})`);
    } catch (e) {
      const why = (e as Error).message.replace(/^slicetest: seed [^:]+: /, "");
      add("fail", /must be a list|must map/.test(why) ? `seed ${rel(file)} isn't rows per table` : `seed ${rel(file)} isn't valid ${path.extname(file).slice(1).toUpperCase()}`, why);
    }
  }

  for (const [label, p] of [["app", opts.app], ...Object.entries(opts.services).map(([n, s]) => [`service ${n}`, s] as const)] as const) {
    if (p.cwd) await checkPath(add, `${label} cwd`, p.cwd, root, rel);
    const seen = new Set<string>();
    for (const command of [p.build, p.command]) {
      const program = command && firstWord(command);
      if (!program || /^[.\\/]|\{\{|\$/.test(program) || seen.has(program)) continue;
      seen.add(program);
      if (await onPath(program, env)) add("ok", `${label}: ${program} found`);
      else add("warn", `${label}: ${program} not found on PATH`, `\`${command}\` may fail to start. Fine if a shell alias or a relative script provides it`);
    }
  }

  const specs = [...(opts.openapi.app ? [["app OpenAPI", opts.openapi.app]] : []), ...Object.entries(opts.openapi.stubs).map(([n, f]) => [`stub ${n} OpenAPI`, f])];
  for (const [label, file] of specs) {
    try {
      const spec = await OpenApiSpec.load(path.resolve(root, file!), file!);
      add("ok", `${label} ${rel(file!)}`, `${spec.operations().length} operation(s)`);
    } catch (e) {
      add("fail", `${label} ${rel(file!)}`, (e as Error).message.replace(/^slicetest: /, ""));
    }
  }

  for (const [name, r] of Object.entries(opts.recordings)) {
    if (existsSync(r.file)) add("ok", `stub ${name}: recordings ${rel(r.file)}`);
    else add("warn", `stub ${name}: no recordings yet (${rel(r.file)})`, `run once with SLICETEST_RECORD=${name} to record ${r.upstream}`);
  }
  return checks;
}

async function checkContainerRuntime(add: (s: Check["status"], l: string, d?: string) => void, probes: Probes, forWhat?: string) {
  try {
    add("ok", `container runtime: ${await probes.containerRuntime()}`, forWhat);
  } catch (e) {
    add(
      "fail",
      "no container runtime",
      `${(e as Error).message.split("\n")[0]}. Start Docker or a Podman machine (\`podman machine start\`), or set SLICETEST_DATABASE_URL / db.url to an existing database server`,
    );
  }
}

async function checkPath(add: (s: Check["status"], l: string, d?: string) => void, label: string, p: string, root: string, rel: (p: string) => string) {
  try {
    await stat(path.resolve(root, p));
    add("ok", `${label} ${rel(p)}`);
  } catch {
    add("fail", `${label} ${rel(p)} not found`, `paths in the config are relative to the config file's directory (${rel(".")})`);
  }
}

function firstWord(command: string) {
  return /^\s*(?:"([^"]+)"|(\S+))/.exec(command)?.slice(1).find(Boolean);
}

async function onPath(program: string, env: NodeJS.ProcessEnv) {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      if (existsSync(path.join(dir, program + ext)) || existsSync(path.join(dir, program))) return true;
    }
  }
  return false;
}

function redact(url: string) {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string) {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref())]);
}

export function formatChecks(checks: Check[]) {
  const icon = { ok: "✓", warn: "!", fail: "✗" };
  const lines = checks.map((c) => `  ${icon[c.status]} ${c.label}${c.detail ? `\n      ${c.detail}` : ""}`);
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const summary = fails ? `${fails} problem(s) to fix before running.` : warns ? `Ready to run, with ${warns} warning(s).` : "Ready to run.";
  return `${lines.join("\n")}\n\n${summary}\n`;
}
