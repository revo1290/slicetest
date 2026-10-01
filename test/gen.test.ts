import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { coverageCacheFile, gen } from "../src/gen.js";
import { parseScenarioFile } from "../src/yaml.js";

const SPEC = `
openapi: 3.0.3
info: { title: t, version: "1" }
paths:
  /users:
    post:
      summary: create a user
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [email]
              properties: { email: { type: string, format: email }, age: { type: integer, minimum: 18 } }
      responses:
        "201":
          description: created
          content: { application/json: { schema: { type: object, properties: { id: { type: integer } } } } }
        "422": { description: invalid }
        "409": { description: taken }
  /users/{id}:
    get:
      parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
      responses:
        "200": { description: ok }
        "404": { description: missing }
  /reports/{day}:
    get:
      parameters:
        - { name: day, in: path, required: true, schema: { type: string, format: date } }
        - { name: tz, in: query, required: true, example: Asia/Tokyo }
      responses:
        "200": { description: ok }
`;

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "slicetest-gen-"));
  await writeFile(path.join(root, "openapi.yaml"), SPEC);
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function scenarios(file: string) {
  const text = await readFile(path.join(root, file), "utf8");
  // Steps carry their line number for error messages; leave it out of the comparisons.
  return parseScenarioFile(text, file).scenarios.map((s) => ({ ...s, steps: s.steps.map(({ line: _, ...step }) => step) }));
}

test("writes one valid scenario file per resource, runnable where the spec says enough", async () => {
  const result = await gen(root, { spec: "openapi.yaml" });
  expect(result).toEqual({ count: 6, written: [path.join("scenarios", "users.gen.scenario.yaml"), path.join("scenarios", "reports.gen.scenario.yaml")], skipped: [], needsAuth: false });

  const users = await scenarios("scenarios/users.gen.scenario.yaml");
  expect(users.map((s) => [s.name, s.skip])).toEqual([
    ["POST /users → 201 (create a user)", false],
    ["POST /users → 409 (create a user) — TODO: arrange the state that produces this", true],
    ["POST /users → 422 (create a user)", false],
    ["GET /users/{id} → 200", false],
    ["GET /users/{id} → 404", false],
  ]);
  // A sample body from the schema; an empty one for the validation error.
  expect(users[0]!.steps).toEqual([{ request: "POST /users", json: { email: "user@example.com", age: 18 }, expect: { status: 201 } }]);
  expect(users[2]!.steps).toEqual([{ request: "POST /users", json: {}, expect: { status: 422 } }]);
  // The id comes from creating a user first.
  expect(users[3]!.steps).toEqual([
    { request: "POST /users", json: { email: "user@example.com", age: 18 }, expect: { status: 201 }, capture: { id: "json.id" } },
    { request: "GET /users/{{id}}", expect: { status: 200 } },
  ]);
  expect(users[4]!.steps).toEqual([{ request: "GET /users/0", expect: { status: 404 } }]);

  // Nothing creates a report, so the test has to arrange one.
  const [report] = await scenarios("scenarios/reports.gen.scenario.yaml");
  expect(report).toMatchObject({ skip: true, steps: [{ request: "GET /reports/2026-01-01", query: { tz: "Asia/Tokyo" }, expect: { status: 200 } }] });
});

test("--uncovered leaves out what the last run produced, and existing files are kept unless forced", async () => {
  await expect(gen(root, { spec: "openapi.yaml", uncovered: true })).rejects.toThrow("no coverage from a previous run yet");

  const cache = coverageCacheFile(root);
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(cache, JSON.stringify(["POST /users 201", "POST /users 422", "POST /users 409", "GET /users/{id} 200", "GET /users/{id} 404"]));
  expect(await gen(root, { spec: "openapi.yaml", uncovered: true })).toMatchObject({ count: 1, written: [path.join("scenarios", "reports.gen.scenario.yaml")] });

  expect(await gen(root, { spec: "openapi.yaml", uncovered: true })).toMatchObject({ written: [], skipped: [path.join("scenarios", "reports.gen.scenario.yaml")] });
  expect(await gen(root, { spec: "openapi.yaml", uncovered: true, force: true })).toMatchObject({ written: [path.join("scenarios", "reports.gen.scenario.yaml")] });
});

test("protected operations get a token from the auth issuer, with the scopes they require, and 401 runs without one", async () => {
  await writeFile(
    path.join(root, "secure.yaml"),
    `
openapi: 3.0.3
info: { title: t, version: "1" }
security: [{ bearer: [] }]
components:
  securitySchemes:
    bearer: { type: http, scheme: bearer }
    oauth: { type: oauth2, flows: { clientCredentials: { tokenUrl: /token, scopes: { "orders:write": w } } } }
paths:
  /health:
    get:
      security: []
      responses: { "200": { description: ok } }
  /orders:
    get:
      responses:
        "200": { description: ok }
        "401": { description: no token }
    post:
      security: [{ oauth: ["orders:write"] }]
      responses:
        "201": { description: created }
        "403": { description: wrong scope }
`,
  );
  const result = await gen(root, { spec: "secure.yaml" });
  expect(result.needsAuth).toBe(true);
  const health = await scenarios("scenarios/health.gen.scenario.yaml");
  expect(health[0]!.steps).toEqual([{ request: "GET /health", expect: { status: 200 } }]);
  const orders = await scenarios("scenarios/orders.gen.scenario.yaml");
  expect(orders.map((s) => [s.name, s.skip, s.steps])).toEqual([
    ["GET /orders → 200", false, [{ request: "GET /orders", auth: true, expect: { status: 200 } }]],
    ["GET /orders → 401", false, [{ request: "GET /orders", expect: { status: 401 } }]],
    ["POST /orders → 201", false, [{ request: "POST /orders", auth: { scope: "orders:write" }, expect: { status: 201 } }]],
    ["POST /orders → 403 — TODO: arrange the state that produces this", true, [{ request: "POST /orders", auth: { scope: "orders:write" }, expect: { status: 403 } }]],
  ]);
});
