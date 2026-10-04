// Runs both sides of the comparison and writes raw data. See README.md for what is and isn't measured.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const here = import.meta.dirname;
const repo = path.resolve(here, "../..");
const app = path.join(repo, "examples/spring-boot-api");
const COLD = Number(process.env.COLD ?? 3);
const WARM = Number(process.env.WARM ?? 20);

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const out = (cmd, args) => (sh(cmd, args).stdout ?? "").trim();
const socket = out("podman", ["machine", "inspect", "--format", "{{.ConnectionInfo.PodmanSocket.Path}}"]);
const env = {
  ...process.env,
  DOCKER_HOST: `unix://${socket}`,
  TESTCONTAINERS_RYUK_DISABLED: "true",
  JAVA_HOME: process.env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@21",
};
env.PATH = `${env.JAVA_HOME}/bin:${env.PATH}`;

function environment() {
  // With the JDK env: without it a machine that has no default JDK records empty versions.
  const mvnVersion = (name) => (sh("mvn", ["-q", "-B", "-f", path.join(app, "pom.xml"), "help:evaluate", `-Dexpression=${name}`, "-DforceStdout"], { env }).stdout ?? "").trim();
  return {
    date: new Date().toISOString(),
    os: `${out("sw_vers", ["-productName"])} ${out("sw_vers", ["-productVersion"])} (${os.arch()})`,
    cpu: `${os.cpus()[0].model}, ${os.cpus().length} cores`,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    loadAverageAtStart: os.loadavg(),
    podman: `${out("podman", ["--version"])}; machine: ${out("podman", ["info", "--format", "{{.Version.Version}}"])}`,
    podmanMachine: out("podman", ["machine", "inspect", "--format", "{{.Resources.CPUs}} CPUs, {{.Resources.Memory}} MiB"]),
    postgresImage: out("podman", ["image", "inspect", "postgres:17-alpine", "--format", "{{.Id}}"]),
    java: sh("java", ["-version"], { env }).stderr.split("\n")[0],
    maven: out("mvn", ["-v"]).split("\n")[0],
    springBoot: mvnVersion("project.parent.version"),
    testcontainers: mvnVersion("testcontainers.version"),
    wiremock: "3.13.2 (wiremock-standalone, pinned in pom.xml)",
    node: process.version,
    vitest: JSON.parse(readFileSync(path.join(repo, "node_modules/vitest/package.json"), "utf8")).version,
    slicetest: `${JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).version}, commit ${out("git", ["-C", repo, "rev-parse", "--short", "HEAD"])}${out("git", ["-C", repo, "status", "--porcelain"]) ? " + uncommitted changes" : ""}`,
    workers: "A: one JVM, tests in one class, run serially. B: workers 1.",
    runnerNote: "Other processes on the machine were not stopped.",
  };
}

function timed(cmd, args, opts) {
  const start = process.hrtime.bigint();
  const res = sh(cmd, args, { env, ...opts });
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function surefire() {
  const dir = path.join(app, "target/surefire-reports");
  const xml = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".xml")).map((f) => readFileSync(path.join(dir, f), "utf8")).join("") : "";
  const m = /tests="(\d+)" errors="(\d+)" skipped="(\d+)" failures="(\d+)"/.exec(xml);
  return m ? { tests: +m[1], failed: +m[2] + +m[4], skipped: +m[3] } : { tests: 0, failed: 0, skipped: 0 };
}

const runs = [];
const scratch = mkdtempSync(path.join(os.tmpdir(), "comparison-"));
function runA(label, seed, cold) {
  if (cold) rmSync(path.join(app, "target"), { recursive: true, force: true });
  rmSync(path.join(app, "target/surefire-reports"), { recursive: true, force: true });
  const r = timed("mvn", ["-q", "-B", "test", `-Djunit.jupiter.execution.order.random.seed=${seed}`], { cwd: app });
  runs.push({ side: "A", label, seed, ...surefire(), exit: r.status, ms: Math.round(r.ms) });
}

function runB(label, seed, cold, reuse) {
  if (cold) rmSync(path.join(app, "target"), { recursive: true, force: true });
  // Not a fixed name, and removed first: a run that dies before writing would otherwise report the last run's numbers.
  const json = path.join(scratch, "result.json");
  rmSync(json, { force: true });
  const r = timed(process.execPath, [path.join(repo, "node_modules/vitest/vitest.mjs"), "run", "--config", path.join(here, "vitest.config.ts"), "--reporter", "json", "--outputFile", json, "--sequence.shuffle.tests", `--sequence.seed=${seed}`], {
    cwd: repo,
    env: { ...env, ...(reuse ? {} : { COMPARISON_REUSE: "off" }) },
  });
  let stats = { tests: 0, failed: 0, skipped: 0 };
  try {
    const j = JSON.parse(readFileSync(json, "utf8"));
    stats = { tests: j.numTotalTests, failed: j.numFailedTests, skipped: j.numPendingTests };
  } catch {}
  runs.push({ side: label.startsWith("B-reuse") ? "B(reuse)" : "B", label, seed, ...stats, exit: r.status, ms: Math.round(r.ms) });
}

const log = (s) => console.error(`${new Date().toISOString().slice(11, 19)} ${s}`);
const plan = [];
for (let i = 1; i <= COLD; i++) plan.push(["A-cold", i, () => runA("A-cold", i, true)], ["B-cold(reuse off)", i, () => runB("B-cold(reuse off)", i, true, false)]);
for (let i = 1; i <= WARM; i++) plan.push(["A-warm", i, () => runA("A-warm", i, false)], ["B-warm(reuse off)", i, () => runB("B-warm(reuse off)", i, false, false)], ["B-reuse-warm", i, () => runB("B-reuse-warm", i, false, true)]);
const env0 = environment();
// Not one side after the other: alternating spreads machine drift over both.
for (const [label, i, run] of plan) {
  log(`${label} #${i}`);
  run();
}

const count = (file) => readFileSync(file, "utf8").split("\n").filter((l) => l.trim() && !/^\s*(\/\/|\*|\/\*)/.test(l)).length;
const loc = {
  A_support: { file: "ApiTestEnvironment.java", lines: count(path.join(app, "src/test/java/example/polls/ApiTestEnvironment.java")) },
  A_cases: { file: "PollsApiTest.java", lines: count(path.join(app, "src/test/java/example/polls/PollsApiTest.java")) },
  A_config: { file: "pom.xml test dependencies + junit-platform.properties", lines: "see README" },
  B_support: { file: "comparison/vitest.config.ts", lines: count(path.join(here, "vitest.config.ts")) },
  B_cases: { file: "comparison/slicetest/polls-comparison.test.ts", lines: count(path.join(here, "slicetest/polls-comparison.test.ts")) },
};
mkdirSync(path.join(here, "results"), { recursive: true });
rmSync(scratch, { recursive: true, force: true });
const file = path.join(here, "results", `${env0.date.slice(0, 10)}-measure.json`);
writeFileSync(file, JSON.stringify({ environment: env0, cold: COLD, warm: WARM, loc, runs }, null, 2));
console.log(file);
