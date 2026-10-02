import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { schemaProblems } from "../src/schema.js";
import "../src/matchers.js";

const spec = `openapi: 3.0.3
info: { title: polls, version: "1" }
paths: {}
components:
  schemas:
    Poll:
      type: object
      required: [id, title, options]
      additionalProperties: false
      properties:
        id: { type: integer, format: int64 }
        title: { type: string }
        closedAt: { type: string, format: date-time, nullable: true }
        options: { type: array, items: { $ref: "#/components/schemas/Option" } }
    Option:
      type: object
      required: [label]
      properties: { label: { type: string }, votes: { type: integer, minimum: 0 } }
`;

test("a schema in an OpenAPI 3.0 file, with $refs and nullable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slicetest-schema-"));
  await writeFile(path.join(dir, "openapi.yaml"), spec);
  const ref = "openapi.yaml#/components/schemas/Poll";

  expect(schemaProblems(ref, { id: 1, title: "Tea?", closedAt: null, options: [{ label: "yes", votes: 2 }] }, dir)).toEqual([]);
  expect(schemaProblems(ref, { id: "1", title: "Tea?", options: [{ votes: -1 }], extra: true }, dir)).toEqual([
    "(root) must NOT have additional properties (extra)",
    "/id must be integer",
    "/options/0 must have required property 'label'",
    "/options/0/votes must be >= 0",
  ]);
  expect(() => schemaProblems("openapi.yaml", {}, dir)).toThrow("is an OpenAPI document; point at a schema in it");
  expect(() => schemaProblems("openapi.yaml#/components/schemas/Nope", {}, dir)).toThrow("no schema at openapi.yaml#/components/schemas/Nope");
});

test("toMatchSchema takes an inline schema, and a response's JSON", () => {
  const schema = { type: "object", required: ["id"], properties: { id: { type: "integer" }, email: { type: "string", format: "email" } } };
  expect({ id: 1, email: "a@b.test" }).toMatchSchema(schema);
  expect({ id: 1, email: "not mail" }).not.toMatchSchema(schema);
  const res = { method: "GET", url: "/users/1", status: 200, headers: new Headers(), text: "", json: { id: "x" }, durationMs: 1 };
  expect(() => expect(res).toMatchSchema(schema)).toThrow("expected GET /users/1's JSON to match the schema:\n  /id must be integer");
});
