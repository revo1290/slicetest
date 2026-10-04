// IMP-06: the same faults in a copy of the app, run through both sides; keeps the failure output of each.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = import.meta.dirname;
const repo = path.resolve(here, "../..");
const mutations = JSON.parse(readFileSync(path.join(here, "mutations/mutations.json"), "utf8"));
const only = process.argv.slice(2);
const sh = (cmd, args, opts) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const socket = sh("podman", ["machine", "inspect", "--format", "{{.ConnectionInfo.PodmanSocket.Path}}"]).stdout.trim();
const JAVA_HOME = process.env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@21";
const env = { ...process.env, DOCKER_HOST: `unix://${socket}`, TESTCONTAINERS_RYUK_DISABLED: "true", JAVA_HOME, PATH: `${JAVA_HOME}/bin:${process.env.PATH}` };
const plain = (s) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
// The results are committed to a public repository: no user name, home or temp paths.
const replacements = [[os.homedir(), "~"], [os.userInfo().username, "<user>"], [realpathSync(os.tmpdir()), "<tmp>"], [os.tmpdir(), "<tmp>"], [socket, "<podman-socket>"], [repo, "<repo>"]].filter(([from]) => from && from.length > 2);
const scrub = (s) => replacements.reduce((text, [from, to]) => text.split(from).join(to), plain(s));

// A copy of examples/ (not of the repo): the harness paths stay relative, the original app is never touched.
const work = mkdtempSync(path.join(os.tmpdir(), "comparison-mutations-"));
const results = [];
for (const m of mutations.filter((m) => !only.length || only.includes(m.id))) {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // The filter looks at the path inside the copied directory: a checkout whose own path says "target" still copies.
  for (const d of ["spring-boot-api", "comparison", "migrations"]) {
    const from = path.join(here, "..", d);
    cpSync(from, path.join(work, d), { recursive: true, filter: (p) => !/(^|[\\/])(target|results|node_modules)([\\/]|$)/.test(path.relative(from, p)) });
  }
  for (const f of ["seed.sql"]) cpSync(path.join(here, "..", f), path.join(work, f));
  symlinkSync(path.join(repo, "node_modules"), path.join(work, "node_modules"));
  // The copy lives outside the repo, so its imports of slicetest's sources become absolute.
  const config = path.join(work, "comparison/vitest.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replaceAll("../../src/", `${repo}/src/`));
  const appDir = path.join(work, "spring-boot-api");
  const target = path.join(appDir, m.file);
  const source = readFileSync(target, "utf8");
  if (!source.includes(m.from)) throw new Error(`${m.id}: the text to replace isn't in ${m.file}`);
  writeFileSync(target, source.replace(m.from, m.to));

  const a = sh("mvn", ["-q", "-B", "test"], { cwd: appDir, env });
  // The slicetest config of the copy must reach the copy's app: its root is the copied comparison/.
  const b = sh(process.execPath, [path.join(repo, "node_modules/vitest/vitest.mjs"), "run", "--config", path.join(work, "comparison/vitest.config.ts"), "--reporter", "verbose"], {
    cwd: repo,
    env: { ...env, COMPARISON_REUSE: "off" },
  });
  const failedA = [...plain(a.stdout + a.stderr).matchAll(/\[ERROR\]\s+PollsApiTest\.(c\d)\w*/g)].map((x) => x[1].toUpperCase());
  const failedB = [...plain(b.stdout + b.stderr).matchAll(/^\s*×\s+\|spring-comparison\|\s+\S+ > (C\d)/gm)].map((x) => x[1]);
  // A non-zero exit without a failed case is a broken harness (a build or start-up error), not a detection.
  for (const [side, res, cases] of [["A", a, failedA], ["B", b, failedB]]) {
    if (res.status !== 0 && cases.length === 0) throw new Error(`${m.id}: side ${side} failed without a failed case:\n${plain(res.stdout + res.stderr).slice(0, 1500)}`);
  }
  // The fault must show up where it was meant to: a different failing case would mean the harness tests something else.
  for (const [side, cases] of [["A", failedA], ["B", failedB]]) {
    const missing = m.expect.filter((c) => !cases.includes(c));
    if (missing.length > 0) throw new Error(`${m.id}: side ${side} didn't fail ${missing.join(", ")} (failed: ${cases.join(", ") || "none"})`);
  }
  results.push({ id: m.id, name: m.name, expect: m.expect, A: { detected: a.status !== 0, failedCases: [...new Set(failedA)], output: scrub(a.stdout + a.stderr) }, B: { detected: b.status !== 0, failedCases: [...new Set(failedB)], output: scrub(b.stdout + b.stderr) } });
  console.error(`${m.id}: A ${a.status !== 0 ? "detected" : "MISSED"} ${[...new Set(failedA)]}; B ${b.status !== 0 ? "detected" : "MISSED"} ${[...new Set(failedB)]}`);
}
rmSync(work, { recursive: true, force: true });
const file = path.join(here, "results", `${new Date().toISOString().slice(0, 10)}-diagnose.json`);
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(file);
