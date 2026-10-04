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

test("formatUsage lists the provider operations the app called and flags deprecated ones", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { OpenApiSpec, formatUsage } = await import("../src/openapi.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "slicetest-usage-"));
  const file = path.join(dir, "pay.yaml");
  await writeFile(
    file,
    "openapi: 3.1.0\ninfo: { title: pay, version: '1' }\npaths:\n  /v1/charges:\n    post: { deprecated: true, responses: { '200': { description: ok } } }\n  /v1/payment_intents:\n    post: { responses: { '200': { description: ok } } }\n  /v1/customers/{id}:\n    get: { responses: { '200': { description: ok } } }\n",
  );
  const spec = await OpenApiSpec.load(file, "pay.yaml");
  expect(spec.operationOf("GET", "/v1/customers/cus_1")).toEqual({ key: "GET /v1/customers/{id}", deprecated: false });

  const report = formatUsage("pay", spec, new Set(["POST /v1/charges", "GET /v1/customers/{id}"]));

  expect(report.text).toBe("slicetest: the app used 2 of 3 operations of pay (pay.yaml), 1 deprecated\n  POST /v1/charges        ⚠ deprecated\n  GET /v1/customers/{id}");
  expect(report.markdown).toContain("- `POST /v1/charges` ⚠️ deprecated");
  expect(report.deprecated).toEqual(["POST /v1/charges"]);
});

test("server URLs with variables use their defaults and enum values as base paths", async () => {
  const s = await spec({
    openapi: "3.1.0",
    servers: [
      { url: "https://{region}.api.example.com/{version}", variables: { region: { default: "eu" }, version: { default: "v1", enum: ["v1", "v2"] } } },
      { url: "{scheme}://legacy.example.com/api", variables: { scheme: { default: "https" } } },
    ],
    paths: { "/users": { get: { responses: { "200": { description: "" } } } } },
  });

  expect(s.operationOf("GET", "/v1/users")?.key).toBe("GET /users");
  expect(s.operationOf("GET", "/v2/users")?.key).toBe("GET /users");
  expect(s.operationOf("GET", "/api/users")?.key).toBe("GET /users");
  expect(s.operationOf("GET", "/v3/users")).toBeUndefined();
});

test("requests: query values are held to their parameter schema, required headers must be sent", async () => {
  const s = await spec({
    openapi: "3.0.3",
    paths: {
      "/items": {
        parameters: [{ name: "x-tenant", in: "header", required: true, schema: { type: "string" } }],
        get: {
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
            { name: "sort", in: "query", schema: { type: "string", enum: ["asc", "desc"] } },
            { name: "active", in: "query", schema: { type: "boolean" } },
            { name: "ids", in: "query", schema: { type: "array", items: { type: "integer" } } },
            { $ref: "#/components/parameters/Cursor" },
            { name: "Authorization", in: "header", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "" } },
        },
      },
    },
    components: { parameters: { Cursor: { name: "cursor", in: "query", schema: { type: "string", pattern: "^c_" } } } },
  });
  const req = (query: string, headers: Record<string, string> = { "x-tenant": "t1" }) => ({ body: "", query: new URLSearchParams(query), headers });

  expect(s.checkRequest("GET", "/items", req("limit=10&sort=asc&active=true&ids=1&ids=2&cursor=c_1"))).toEqual([]);
  expect(s.checkRequest("GET", "/items", req(""))).toEqual([]);
  expect(s.checkRequest("GET", "/items", req("limit=abc"))).toEqual(['GET /items: query parameter "limit" must be integer (got "abc")']);
  expect(s.checkRequest("GET", "/items", req("limit=0"))).toEqual(['GET /items: query parameter "limit" must be >= 1 (got "0")']);
  expect(s.checkRequest("GET", "/items", req("sort=up"))).toEqual(['GET /items: query parameter "sort" must be equal to one of the allowed values (got "up")']);
  expect(s.checkRequest("GET", "/items", req("active=yes"))).toEqual(['GET /items: query parameter "active" must be boolean (got "yes")']);
  expect(s.checkRequest("GET", "/items", req("ids=1,2"))).toEqual([]);
  expect(s.checkRequest("GET", "/items", req("ids=1,x"))).toEqual(['GET /items: query parameter "ids" item 2 must be integer (got "x")']);
  expect(s.checkRequest("GET", "/items", req("ids=1&ids=x"))).toEqual(['GET /items: query parameter "ids" item 2 must be integer (got "x")']);
  expect(s.checkRequest("GET", "/items", req("cursor=zz"))).toEqual(['GET /items: query parameter "cursor" must match pattern "^c_" (got "zz")']);
  expect(s.checkRequest("GET", "/items", req("", {}))).toEqual(['GET /items: required header "x-tenant" is missing']);
  // Authorization is listed as required but is the transport's business, so its absence isn't reported.
  expect(s.checkRequest("GET", "/items", req("", { "x-tenant": "t" }))).toEqual([]);
});

test("a generated example response satisfies the schema it was built from", async () => {
  const props = {
    code: { type: "string", maxLength: 2 },
    negative: { type: "integer", maximum: -5 },
    below: { type: "integer", exclusiveMaximum: 0 },
    stepped: { type: "integer", minimum: 1, multipleOf: 5 },
    strict30: { type: "integer", minimum: 0, exclusiveMinimum: true },
    ratio: { type: "number", minimum: 0.5, maximum: 0.9 },
    tags: { type: "array", minItems: 2, maxItems: 3, uniqueItems: true, items: { type: "string", enum: ["a", "b"] } },
    padded: { type: "string", minLength: 8, maxLength: 8 },
  };
  const s = await spec({
    openapi: "3.0.3",
    paths: { "/x": { get: { responses: { "200": { description: "", ...json({ type: "object", properties: props }) } } } } },
  });

  const example = s.exampleResponse("GET", "/x")!;

  expect(s.checkResponse("GET", "/x", { status: 200, contentType: "application/json", body: example.body })).toEqual([]);
});

test("3.0's boolean exclusiveMinimum / exclusiveMaximum are read as bounds, not rejected by the validator", async () => {
  const s = await spec({
    openapi: "3.0.3",
    paths: { "/x": { get: { responses: { "200": { description: "", ...json({ type: "object", properties: { n: { type: "integer", minimum: 0, exclusiveMinimum: true, maximum: 10, exclusiveMaximum: false } } }) } } } } },
  });

  expect(s.checkResponse("GET", "/x", ok({ n: 1 }))).toEqual([]);
  expect(s.checkResponse("GET", "/x", ok({ n: 10 }))).toEqual([]);
  expect(s.checkResponse("GET", "/x", ok({ n: 0 }))).toEqual(["GET /x → 200: /n must be > 0"]);
  expect(s.checkResponse("GET", "/x", ok({ n: 11 }))).toEqual(["GET /x → 200: /n must be <= 10"]);
});

test("responses: headers the spec lists are required when marked so, and held to their schema", async () => {
  const s = await spec({
    openapi: "3.0.3",
    paths: {
      "/items": {
        get: {
          responses: {
            "200": {
              description: "",
              headers: {
                "X-Rate-Limit": { required: true, schema: { type: "integer", minimum: 0 } },
                "X-Request-Id": { schema: { type: "string", pattern: "^req_" } },
                Location: { $ref: "#/components/headers/Where" },
                "Content-Type": { required: true, schema: { type: "string" } },
              },
              ...json({ type: "object" }),
            },
          },
        },
      },
    },
    components: { headers: { Where: { required: true, schema: { type: "string", format: "uri-reference" } } } },
  });
  const res = (headers: Record<string, string>) => ({ ...ok({}), headers });

  expect(s.checkResponse("GET", "/items", res({ "x-rate-limit": "5", "x-request-id": "req_1", location: "/items/1" }))).toEqual([]);
  expect(s.checkResponse("GET", "/items", res({ location: "/x" }))).toEqual(['GET /items → 200: required header "X-Rate-Limit" is missing']);
  expect(s.checkResponse("GET", "/items", res({ "x-rate-limit": "-1", location: "/x" }))).toEqual(['GET /items → 200: header "X-Rate-Limit" must be >= 0 (got "-1")']);
  expect(s.checkResponse("GET", "/items", res({ "x-rate-limit": "1", "x-request-id": "abc", location: "/x" }))).toEqual(['GET /items → 200: header "X-Request-Id" must match pattern "^req_" (got "abc")']);
  expect(s.checkResponse("GET", "/items", res({ "x-rate-limit": "1" }))).toEqual(['GET /items → 200: required header "Location" is missing']);
  // Without headers on the message (a caller that doesn't pass them) nothing is claimed about them.
  expect(s.checkResponse("GET", "/items", ok({}))).toEqual([]);
});

test("an example response carries the headers the spec requires, so autoReply satisfies the header check", async () => {
  const s = await spec({
    openapi: "3.0.3",
    paths: {
      "/items": {
        get: {
          responses: {
            "200": {
              description: "",
              headers: { "X-Total-Count": { required: true, schema: { type: "integer" } }, "X-Optional": { schema: { type: "string" } }, "X-Ver": { required: true, example: "v2", schema: { type: "string" } } },
              ...json({ type: "array", items: { type: "string" } }),
            },
            "204": { description: "", headers: { "X-Only": { required: true, schema: { type: "string" } } } },
          },
        },
      },
    },
  });

  const example = s.exampleResponse("GET", "/items")!;

  expect(example.headers).toMatchObject({ "content-type": "application/json", "X-Total-Count": "0", "X-Ver": "v2" });
  expect(example.headers).not.toHaveProperty("X-Optional");
  const lower = Object.fromEntries(Object.entries(example.headers!).map(([k, v]) => [k.toLowerCase(), v]));
  expect(s.checkResponse("GET", "/items", { status: 200, contentType: lower["content-type"], body: example.body, headers: lower })).toEqual([]);
});
