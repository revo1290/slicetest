import { beforeAll, expect, test } from "vitest";
import { runFailingFixture } from "./run-fixture.js";

let output = "";

beforeAll(async () => {
  output = await runFailingFixture("failing");
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

test("a crashed service fails the scenario with its output, and is restarted on the same port", () => {
  expect(output).toMatch(/service sidecar process exited \(code 9/);
  expect(output).toContain("sidecar: exiting on request");
  expect(output).toMatch(/[✓√] .*the crashed service is restarted on the same port/);
});

test("YAML steps fail with the file, line and step that failed", () => {
  expect(output).toMatch(/failing\.scenario\.yaml:4 \(yaml wrong status, step 1: GET \/\)\n.*expected GET \/ to respond 201, got 200/);
  expect(output).toMatch(/failing\.scenario\.yaml:9 \(yaml wrong json, step 1: GET \/json\)/);
  expect(output).toMatch(/-\s+"name": "bob"/);
  expect(output).toContain("unknown variable {{userId}}. Defined so far: (none)");
  expect(output).toMatch(/failing\.scenario\.yaml:22 \(yaml stub never called, step 2: received mail POST \/send\)\nexpected stub "mail" to have received POST \/send\n/);
});
