// Real projects, made by each framework's own generator, taken from `slicetest init` to a passing run with the
// packed package. init.test.ts only compares what `init` detects, which is how a config that can't run went unnoticed.
//   node test/stacks/run.mjs [stack...]       every stack, or the ones named
//   STACKS_TARBALL=path.tgz                   use this package instead of building one
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const here = import.meta.dirname;
const root = path.join(here, "../..");
const shell = (cmd, cwd, env = process.env) => spawnSync("sh", ["-ec", cmd], { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

function tarball() {
  if (process.env.STACKS_TARBALL) return path.resolve(process.env.STACKS_TARBALL);
  execFileSync("npm", ["run", "--silent", "build"], { cwd: root, stdio: "inherit" });
  const dir = mkdtempSync(path.join(os.tmpdir(), "slicetest-pack-"));
  const name = execFileSync("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: root, encoding: "utf8" }).trim().split("\n").pop();
  return path.join(dir, name);
}

/** The steps a new user takes, stopping at the first that fails. */
function runStack(name, pkg) {
  const source = path.join(here, name);
  const dir = mkdtempSync(path.join(os.tmpdir(), `slicetest-stack-${name}-`));
  const env = { ...process.env, PATH: `${path.join(dir, ".venv/bin")}${path.delimiter}${process.env.PATH}` };
  const step = (label, cmd) => {
    const started = Date.now();
    const r = shell(cmd, dir, env);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (r.status !== 0) return { label, seconds, failed: true, output: `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, "") };
    console.log(`  ✓ ${label} (${seconds}s)`);
    return { label, seconds, output: r.stdout };
  };
  try {
    const steps = [
      ["project", `sh ${JSON.stringify(path.join(source, "project.sh"))}`],
      ["install", `[ -f package.json ] || npm init -y >/dev/null; npm i --silent --no-audit --no-fund -D ${JSON.stringify(pkg)} vitest`],
      ["slicetest init", "npx slicetest init"],
      ["slicetest doctor", "npx slicetest doctor"],
    ];
    for (const [label, cmd] of steps) {
      const r = step(label, cmd);
      if (r.failed) return r;
    }
    cpSync(path.join(source, "scenarios"), path.join(dir, "scenarios"), { recursive: true });
    const run = step("slicetest", "npx slicetest --reporter default --reporter json --output-file slicetest.json");
    if (run.failed) return run;
    const report = JSON.parse(readFileSync(path.join(dir, "slicetest.json"), "utf8"));
    const scenarios = readdirSync(path.join(source, "scenarios")).map((f) => (readFileSync(path.join(source, "scenarios", f), "utf8").match(/^ {2}- name:/gm) ?? []).length).reduce((a, b) => a + b, 0);
    // The smoke scenario `init` wrote, plus the stack's own: all of them ran, and none was skipped.
    if (report.numPassedTests !== scenarios + 1) return { label: "scenario count", seconds: 0, failed: true, output: `expected ${scenarios + 1} passed, got ${report.numPassedTests} of ${report.numTotalTests}` };
    if (existsSync(path.join(source, "verify.sh"))) {
      const r = step("verify", `sh ${JSON.stringify(path.join(source, "verify.sh"))}`);
      if (r.failed) return r;
    }
    return {};
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const stacks = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(here, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
for (const name of stacks) if (!existsSync(path.join(here, name, "project.sh"))) throw new Error(`no stack ${name} in ${here}`);
const pkg = tarball();
const failures = [];
for (const name of stacks) {
  console.log(`${name}:`);
  const result = runStack(name, pkg);
  if (result.failed) {
    console.log(`  ✗ ${result.label}\n${result.output.split("\n").slice(-60).join("\n")}`);
    failures.push(name);
  }
}
console.log(failures.length ? `\nFailed: ${failures.join(", ")}` : `\nAll ${stacks.length} stack(s) passed.`);
process.exit(failures.length ? 1 : 0);
