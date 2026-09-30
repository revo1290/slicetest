import { execFile } from "node:child_process";
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
