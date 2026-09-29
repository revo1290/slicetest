import { beforeAll, expect, test } from "vitest";
import { runFailingFixture } from "./run-fixture.js";

let output = "";

beforeAll(async () => {
  output = await runFailingFixture("contract");
}, 120_000);

test("a response that breaks the app's schema fails the scenario", () => {
  expect(output).toContain("slicetest: traffic doesn't match the OpenAPI spec:\n  app: GET /users/{id} → 200: /id must be integer");
});

test("undocumented statuses and paths are reported", () => {
  expect(output).toContain("app: GET /users/{id} responded 418, which openapi.yaml doesn't document (documented: 200, 404)");
  expect(output).toContain("app: GET /secret is not in openapi.yaml");
});

test("the app's requests to a stub are checked against the service's spec, below its server path", () => {
  expect(output).toContain("app → mail: POST /mail/send request: body must have required property 'subject'");
  expect(output).toContain('app → mail: POST /mail/send request: /to must match format "email"');
});

test("a stub reply the real service would never send is reported", () => {
  expect(output).toContain("stub mail reply (the real service wouldn't answer this way): POST /mail/send responded 200, which mail.openapi.yaml doesn't document (documented: 202)");
});

test("the run ends with a coverage report, and fails below minCoverage", () => {
  expect(output).toContain(
    ["slicetest: OpenAPI coverage (openapi.yaml): 2/3 documented responses (67%)", "  GET    /users/{id}  200 ✓  404 ✗", "  POST   /signup      201 ✓"].join("\n"),
  );
  expect(output).toContain("OpenAPI coverage 67% is below openapi.minCoverage (90%)");
});

test("mismatches also appear in the failure diagnostics, and matching traffic passes", () => {
  expect(output).toContain("OpenAPI mismatches:\n  app: GET /users/{id} → 200: /id must be integer");
  expect(output).toMatch(/[✓√] .*traffic that matches the specs passes/);
});
