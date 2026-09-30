// `slicetest record` end to end, against dist/: record a session through the
// proxy, then replay the written scenario with `slicetest` and expect it to pass.
import { execFile, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const root = path.join(import.meta.dirname, "..");
const cli = path.join(root, "dist/cli.js");
const config = path.join(root, "test/fixtures/record/slicetest.config.yaml");
// Inside the project, where `slicetest` looks for scenarios. Ignored by git.
const out = path.join(root, "test/fixtures/record/recorded/polls.scenario.yaml");
await rm(path.dirname(out), { recursive: true, force: true });

const output = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, "record", "--config", config, "--out", out], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let text = "";
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`record timed out:\n${text}`));
  }, 120_000);
  child.stderr.on("data", (d) => (text += d));
  child.stdout.on("data", async (d) => {
    text += d;
    const url = /through (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d))?.[1];
    if (!url) return;
    try {
      const json = { "content-type": "application/json" };
      const created = await (await fetch(`${url}/polls`, { method: "POST", headers: json, body: JSON.stringify({ title: "Dogs or cats?", a: "Dogs", b: "Cats" }) })).json();
      await fetch(`${url}/polls/${created.id}/votes`, { method: "POST", headers: json, body: JSON.stringify({ choice: "a" }) });
      await fetch(`${url}/polls/${created.id}`);
      await fetch(`${url}/favicon.ico`);
      child.stdin.write("\n");
    } catch (e) {
      reject(e);
    }
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    code === 0 ? resolve(text) : reject(new Error(`record exited with ${code}:\n${text}`));
  });
});

const yaml = await readFile(out, "utf8");
const expect = (cond, what) => {
  if (!cond) throw new Error(`record: ${what}\n--- output ---\n${output}\n--- scenario ---\n${yaml}`);
};
expect(/Wrote .*polls\.scenario\.yaml: 3 request\(s\), 1 stub route\(s\), changes in polls, votes/.test(output), "summary line");
expect(yaml.includes("request: POST /polls\n"), "the POST is recorded");
expect(yaml.includes("stub: slack\n        on: POST /hook"), "the stub's answer is recorded");
expect(yaml.includes("received: slack"), "the outbound call is asserted");
expect(/changes:\n\s+polls:\n\s+inserted: 1\n\s+votes:\n\s+inserted: 1/.test(yaml), "the database changes are counted");
expect(!yaml.includes("favicon"), "static files are left out");

// The recording replays green.
await promisify(execFile)(process.execPath, [cli, "--config", config, out], { cwd: root }).catch((e) => {
  throw new Error(`replaying the recording failed:\n${e.stdout}\n${e.stderr}\n--- scenario ---\n${yaml}`);
});
await rm(path.dirname(out), { recursive: true, force: true });
console.log("record: recorded 3 requests and replayed them");
