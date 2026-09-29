import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const exec = promisify(execFile);
let output = "";

beforeAll(async () => {
  const config = path.join(import.meta.dirname, "fixtures/failing/vitest.config.ts");
  try {
    // node + the vitest entry, rather than `npx`, which is npx.cmd on Windows.
    const root = path.join(import.meta.dirname, "..");
    const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
    await exec(process.execPath, [vitest, "run", "--config", config, "--reporter", "verbose"], { cwd: root });
    throw new Error("fixture run was expected to fail");
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    // CI forces colors; strip them so the assertions see plain text.
    output = `${err.stdout}\n${err.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  }
}, 120_000);

test("a call to a stub with no matching route fails the scenario and lists the registered routes", () => {
  expect(output).toContain("the app called stubbed services with no matching route");
  expect(output).toContain("mail: POST /send");
  expect(output).toContain("registered on mail: POST /other");
});

test("an app crash fails the scenario and shows the app's output", () => {
  expect(output).toMatch(/app process exited \(code 3/);
  expect(output).toContain("boom: about to crash");
});

test("requests that got no response still show up in the diagnostics", () => {
  expect(output).toMatch(/GET \/crash → failed \(\d+ms\) {2}.*fetch failed/);
});

test("the app is restarted after a crash, so later scenarios still run", () => {
  // Vitest prints √ instead of ✓ on some Windows consoles.
  expect(output).toMatch(/[✓√] .*the next scenario gets a restarted app/);
});

test("a failed scenario prints its requests and only its own app output", () => {
  const block = output.slice(output.indexOf("requests to the app:\n  GET /log-something"));
  expect(block).toMatch(/^requests to the app:\n {2}GET \/log-something → 200 \(\d+ms\) {2}ok\n {2}GET \/ → 200/);
  expect(block).toMatch(/app output during this scenario:\nhandled log-something/);
  expect(block.split("-----------------")[0]).not.toContain("boom: about to crash");
  expect(block).toContain("database changes during this scenario: (none)");
});

test("YAML steps fail with the file, line and step that failed", () => {
  expect(output).toMatch(/failing\.scenario\.yaml:4 \(yaml wrong status, step 1: GET \/\)\n.*expected GET \/ to respond 201, got 200/);
  expect(output).toMatch(/failing\.scenario\.yaml:9 \(yaml wrong json, step 1: GET \/json\)/);
  expect(output).toMatch(/-\s+"name": "bob"/);
  expect(output).toContain("unknown variable {{userId}}. Defined so far: (none)");
  expect(output).toMatch(/failing\.scenario\.yaml:22 \(yaml stub never called, step 2: received mail POST \/send\)\nexpected stub "mail" to have received POST \/send\n/);
});
