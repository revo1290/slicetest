import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Runs a fixture project that is expected to fail and returns its plain-text output. */
export async function runFailingFixture(name: string, env: Record<string, string> = {}) {
  const root = path.join(import.meta.dirname, "..");
  const config = path.join(import.meta.dirname, "fixtures", name, "vitest.config.ts");
  try {
    // node + the vitest entry, rather than `npx`, which is npx.cmd on Windows.
    const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
    await exec(process.execPath, [vitest, "run", "--config", config, "--reporter", "verbose"], { cwd: root, env: { ...process.env, ...env } });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    // CI forces colors; strip them so the assertions see plain text.
    return `${err.stdout}\n${err.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  }
  throw new Error(`fixture "${name}" was expected to fail`);
}

export interface FixtureRun {
  tests: Map<string, { status: string; message: string }>;
  exitCode: number;
}

export async function runFixture(name: string, opts: { env?: Record<string, string>; args?: string[] } = {}): Promise<FixtureRun> {
  const root = path.join(import.meta.dirname, "..");
  const config = path.join(import.meta.dirname, "fixtures", name, "vitest.config.ts");
  const dir = await mkdtemp(path.join(os.tmpdir(), "slicetest-fixture-"));
  const outputFile = path.join(dir, "result.json");
  const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
  let exitCode = 0;
  let stderr = "";
  try {
    // Not unbounded: a stuck fixture would outlive the test run, with its apps and containers.
    await exec(process.execPath, [vitest, "run", "--config", config, "--reporter", "json", "--outputFile", outputFile, ...(opts.args ?? [])], {
      cwd: root,
      env: { ...process.env, ...opts.env },
      timeout: 200_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { code?: number | string; stderr?: string };
    exitCode = typeof err.code === "number" ? err.code : 1;
    stderr = err.stderr ?? "";
  }
  try {
    const report = JSON.parse(await readFile(outputFile, "utf8")) as { testResults: { assertionResults: { title: string; status: string; failureMessages: string[] }[] }[] };
    const tests = new Map<string, { status: string; message: string }>();
    for (const file of report.testResults) {
      for (const t of file.assertionResults) tests.set(t.title, { status: t.status, message: t.failureMessages.join("\n").replace(/\x1b\[[0-9;]*m/g, "") });
    }
    return { tests, exitCode };
  } catch (e) {
    throw new Error(`fixture "${name}" wrote no result (${(e as Error).message}):\n${stderr.replace(/\x1b\[[0-9;]*m/g, "").slice(-2000)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
