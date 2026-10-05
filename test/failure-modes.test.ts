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
  expect(output).toMatch(/failing\.scenario\.yaml:11 \(yaml wrong status, step 1: GET \/\)\n.*expected GET \/ to respond 201, got 200/);
  expect(output).toMatch(/failing\.scenario\.yaml:16 \(yaml wrong json, step 1: GET \/json\)/);
  expect(output).toMatch(/-\s+"name": "bob"/);
  expect(output).toContain("unknown variable {{userId}}. Defined so far: (none)");
  expect(output).toMatch(/failing\.scenario\.yaml:5 \(yaml failing inside use, step 1: use open home → step 1: GET \/\)\n.*expected GET \/ to respond 418, got 200/);
  expect(output).toMatch(/failing\.scenario\.yaml:29 \(yaml stub never called, step 2: received mail POST \/send\)\nexpected stub "mail" to have received POST \/send\n/);
});

test("a wait that would outlast the test's timeout gives up first and says what it waited for", () => {
  const block = output.slice(output.indexOf("yaml log wait gives up before the test timeout"));
  expect(block).toMatch(/app printed no line matching \/this line is never printed\/ within \d+ms \(the scenario's timeout of 5000ms ends then; raise it with `timeout:`\)/);
  expect(block.split("⎯⎯⎯")[0]).not.toContain("Test timed out");
});

test("expect.headers with null: the header must be absent", () => {
  expect(output).toMatch(/[✓√] .*yaml header null passes when the header is absent/);
  expect(output).toMatch(/yaml header null fails when the header is sent, step 1: GET \/json\)\nGET \/json: expected no content-type header, got "application\/json"/);
});
