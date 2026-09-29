import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { OpenApiSpec } from "../src/openapi.js";

async function spec(doc: object) {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), "slicetest-oas-")), "spec.json");
  await writeFile(file, JSON.stringify(doc));
  return OpenApiSpec.load(file, "spec.json");
}

const json = (schema: object) => ({ content: { "application/json": { schema } } });
const ok = (body: unknown, status = 200) => ({ status, contentType: "application/json; charset=utf-8", body });

test("3.0: nullable, $ref'd schemas, status ranges and default", async () => {
  const s = await spec({
    openapi: "3.0.3",
    paths: {
      "/items/{id}": {
        get: {
          responses: {
            "200": { description: "", ...json({ $ref: "#/components/schemas/Item" }) },
            "4XX": { description: "", ...json({ type: "object", required: ["error"] }) },
            default: { description: "" },
          },
        },
      },
    },
    components: { schemas: { Item: { type: "object", properties: { note: { type: "string", nullable: true }, tag: { enum: ["a"], nullable: true } } } } },
  });

  expect(s.checkResponse("GET", "/items/1", ok({ note: null, tag: null }))).toEqual([]);
  expect(s.checkResponse("GET", "/items/1", ok({ note: 1 }))).toEqual(["GET /items/{id} → 200: /note must be string,null"]);
  expect(s.checkResponse("GET", "/items/1", ok({}, 404))).toEqual(["GET /items/{id} → 404: body must have required property 'error'"]);
  expect(s.checkResponse("GET", "/items/1", ok("boom", 500))).toEqual([]);
  expect(s.checkResponse("GET", "/items/1", { status: 200, contentType: "text/html", body: "<p>" })).toEqual([
    'GET /items/{id} → 200: content-type "text/html" is not one of application/json',
  ]);
  expect(s.checkResponse("POST", "/items/1", ok({}))).toEqual(["POST /items/1 is not in spec.json"]);
});

test("concrete paths win over templated ones, and server base paths are stripped", async () => {
  const s = await spec({
    openapi: "3.1.0",
    servers: [{ url: "https://api.example.com/v2" }],
    paths: {
      "/users/{id}": { get: { responses: { "200": { description: "", ...json({ type: "object", required: ["id"] }) } } } },
      "/users/me": { get: { responses: { "200": { description: "", ...json({ type: "object", required: ["me"] }) } } } },
    },
  });

  expect(s.find("GET", "/v2/users/me")?.template).toBe("/users/me");
  expect(s.find("GET", "/users/42")?.template).toBe("/users/{id}");
  expect(s.find("GET", "/users/42/extra")).toBeUndefined();
});

test("requests: required query parameters and body", async () => {
  const s = await spec({
    openapi: "3.1.0",
    paths: {
      "/search": {
        parameters: [{ name: "q", in: "query", required: true }],
        post: { requestBody: { required: true, ...json({ type: "object", properties: { limit: { type: "integer", maximum: 100 } } }) }, responses: {} },
      },
    },
  });

  expect(s.checkRequest("POST", "/search", { contentType: "application/json", body: { limit: 5 }, query: new URLSearchParams("q=x") })).toEqual([]);
  expect(s.checkRequest("POST", "/search", { contentType: "application/json", body: "", query: new URLSearchParams() })).toEqual([
    'POST /search: required query parameter "q" is missing',
    "POST /search: the request body is required",
  ]);
  expect(s.checkRequest("POST", "/search", { contentType: "application/json", body: { limit: 500 }, query: new URLSearchParams("q=x") })).toEqual([
    "POST /search request: /limit must be <= 100",
  ]);
});

test("rejects files that aren't OpenAPI 3", async () => {
  await expect(spec({ swagger: "2.0" })).rejects.toThrow("spec.json is not an OpenAPI 3 document");
});

test("exampleResponse: spec examples first, then values built from the schema", async () => {
  const s = await spec({
    openapi: "3.1.0",
    paths: {
      "/charges": {
        post: {
          responses: {
            "202": { description: "", ...json({ type: "object" }) },
            "201": { description: "", content: { "application/json": { schema: { type: "object" }, example: { id: "ch_1" } } } },
          },
        },
      },
      "/named": { get: { responses: { "200": { description: "", content: { "application/json": { examples: { a: { value: [1] } } } } } } } },
      "/users/{id}": { get: { responses: { "200": { description: "", ...json({ $ref: "#/components/schemas/User" }) } } } },
      "/empty": { delete: { responses: { "204": { description: "" } } } },
      "/errors-only": { get: { responses: { "404": { description: "" } } } },
    },
    components: {
      schemas: {
        User: {
          allOf: [
            { type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 1 }, email: { type: "string", format: "email" } } },
            { type: "object", properties: { role: { enum: ["admin", "member"] }, tags: { type: "array", items: { type: "string", minLength: 8 } }, nick: { type: ["string", "null"] } } },
          ],
        },
      },
    },
  });

  expect(s.exampleResponse("POST", "/charges")).toEqual({ status: 201, headers: { "content-type": "application/json" }, body: { id: "ch_1" } });
  expect(s.exampleResponse("GET", "/named")?.body).toEqual([1]);
  expect(s.exampleResponse("GET", "/users/7")?.body).toEqual({ id: 1, email: "user@example.com", role: "admin", tags: ["stringxx"], nick: "string" });
  expect(s.exampleResponse("DELETE", "/empty")).toEqual({ status: 204 });
  expect(s.exampleResponse("GET", "/errors-only")).toBeUndefined();
  expect(s.exampleResponse("GET", "/nope")).toBeUndefined();

  // Whatever it builds must pass its own contract check.
  for (const [method, path] of [["POST", "/charges"], ["GET", "/users/7"], ["DELETE", "/empty"]] as const) {
    const r = s.exampleResponse(method, path)!;
    expect(s.checkResponse(method, path, { status: r.status, contentType: r.headers?.["content-type"], body: r.body })).toEqual([]);
  }
});
