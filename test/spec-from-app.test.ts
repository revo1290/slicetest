import { beforeAll, expect, test } from "vitest";
import { runFailingFixture } from "./run-fixture.js";

let output = "";

beforeAll(async () => {
  output = await runFailingFixture("spec-from-app");
}, 120_000);

test("responses are checked against the spec the app serves at openapi.fromApp", () => {
  expect(output).toContain("✓ items.scenario.yaml > a response that matches the spec the app serves");
  expect(output).toMatch(/app: GET \/items\/\{id\} → 200: \/id must be integer/);
});

test("coverage is reported against that spec, and minCoverage applies", () => {
  expect(output).toMatch(/GET\s+\/items\/\{id\}\s+200 ✓\s+404 ✗/);
  expect(output).toContain("OpenAPI coverage 50% is below openapi.minCoverage (100%)");
});
