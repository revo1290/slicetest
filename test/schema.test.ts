// The JSON Schema (for editors) and the parser (for runs) describe the same
// format; these tests keep them from drifting apart.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { parseScenarioFile } from "../src/yaml.js";

const root = path.join(import.meta.dirname, "..");
const schema = JSON.parse(readFileSync(path.join(root, "schema/scenario.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);

const schemaErrors = (text: string) => (validate(parse(text)) ? [] : validate.errors!.map((e) => `${e.instancePath} ${e.message}`));
const parserError = (text: string) => {
  try {
    parseScenarioFile(text, "x.scenario.yaml");
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
};

test.each(["examples/scenarios/polls.scenario.yaml", "test/fixtures/failing/failing.scenario.yaml", "test/fixtures/services/worker.scenario.yaml"])(
  "%s matches the schema",
  (file) => {
    expect(schemaErrors(readFileSync(path.join(root, file), "utf8"))).toEqual([]);
  },
);

/** Every step kind with every option. Both the schema and the parser must accept it. */
const EVERYTHING = `
define:
  plain:
    - checkpoint: true
  with params:
    params: [n]
    steps:
      - use: plain
setup:
  - use: with params
    with: { n: 1 }
    name: reused
  - stub: pay
    on: POST /charges/:id
    when: { query: { a: "1" }, headers: { x: y }, json: { amount: 1 }, body: raw }
    reply: { status: 201, headers: { x-id: "1" }, body: { id: "{{call.params.id}}" } }
    times: 2
    delay: 10
    optional: true
    name: charge
scenarios:
  - name: all steps {{n}}
    each: [{ n: 1 }]
    skip: false
    only: false
    timeout: 5000
    steps:
      - stub: pay
        on: GET /status
        sequence: [{ status: 503 }, { status: 200 }]
      - stub: pay
        on: "* /down"
        networkError: true
      - stub: pay
        on: POST /stream
        reply: { status: 200, headers: { x: y }, sse: [{ event: start, data: { a: 1 }, id: "1" }, { data: done }] }
      - stub: pay
        on: POST /streams
        sequence: [{ sse: [{ data: one }] }, { status: 529 }]
      - request: POST /x
        headers: { a: b }
        query: { q: 1 }
        json: { a: 1 }
        follow: true
        expect: { status: 200, headers: { x: y }, json: { id: { $type: number } }, text: { $contains: ok } }
        capture: { id: json.id }
      - request: POST /form
        form: { a: b }
        concurrency: 5
        expect: { statuses: { 201: 1, 409: 4 } }
      - request: POST /raw
        body: hello
      - stub: gh
        graphql: CreateIssue
        when: { variables: { title: Bug }, headers: { authorization: x } }
        reply: { headers: { x: y }, data: { createIssue: { number: 1 } }, errors: [oops, { message: bad, path: [a] }] }
      - stub: gh
        graphql: Viewer
        sequence: [{ errors: [down] }, { data: { viewer: { login: a } } }]
      - request: POST /graphql
        graphql: "{ me }"
      - request: POST /graphql
        graphql: { query: "query Q($a: Int) { q(a: $a) }", variables: { a: 1 }, operationName: Q }
        expect: { json: { data: { q: 1 } } }
      - received: gh
        graphql: CreateIssue
        when: { variables: { title: Bug } }
      - submit: Sign up
        form: signup
        fields: { email: a@b.test, age: 3, terms: true, tags: [a, b] }
        headers: { a: b }
        follow: true
        expect: { status: 200, headers: { x: y }, json: { ok: true }, text: { $contains: ok } }
        capture: { page: text }
      - submit: true
        form: 0
      - insert: users
        rows: [{ name: a }]
        capture: { userId: row.id }
      - sql: SELECT 1 AS n
        params: []
        expect: { rows: [{ n: 1 }], count: 1 }
        capture: { n: row.n }
        within: 100
      - db: users
        where: { name: a }
        orderBy: [-id]
        expect: { rows: [{ name: a }], count: 1 }
        capture: { u: row.id }
        within: 100
      - received: pay
        call: POST /charges/1
        when: { json: { amount: 1 } }
        times: 1
        within: 100
      - checkpoint: true
      - snapshot: true
        mask: [token]
      - changes:
          users: { inserted: 1, updated: [{ name: b }], deleted: 0 }
        within: 100
      - log: "done \\\\d+"
        from: worker
        within: 100
      - mail: { to: a@example.com, from: b@example.com, subject: Hi, text: { $regex: "code \\\\d+" }, html: ok }
        times: 1
        within: 100
        capture: { link: links.0 }
`;

test("the schema and the parser both accept every documented step and option", () => {
  expect(parserError(EVERYTHING)).toBeUndefined();
  expect(schemaErrors(EVERYTHING)).toEqual([]);
});

test.each([
  ["expect.statuses without concurrency", "scenarios:\n  - name: a\n    steps:\n      - request: GET /\n        expect: { statuses: { 200: 1 } }\n"],
  ["capture with concurrency", "scenarios:\n  - name: a\n    steps:\n      - request: GET /\n        concurrency: 2\n        capture: { a: json.a }\n"],
])("the parser rejects %s", (_, text) => {
  expect(parserError(text)).toBeDefined();
});

test.each([
  ["an unknown step key", "scenarios:\n  - name: a\n    steps:\n      - request: GET /\n        wat: 1\n"],
  ["an unknown step kind", "scenarios:\n  - name: a\n    steps:\n      - reqest: GET /\n"],
  ["an unknown scenario key", "scenarios:\n  - name: a\n    step: []\n"],
  ["an unknown top-level key", "scenario: []\n"],
  ["within with concurrency on a request", "scenarios:\n  - name: a\n    steps:\n      - request: GET /\n        within: 10\n        concurrency: 2\n"],
  ["multipart with json on a request", "scenarios:\n  - name: a\n    steps:\n      - request: POST /\n        json: {}\n        multipart: { a: b }\n"],
  ["every without within on a request", "scenarios:\n  - name: a\n    steps:\n      - request: GET /\n        every: 10\n"],
  ["an unknown changes key", "scenarios:\n  - name: a\n    steps:\n      - changes: { t: { added: 1 } }\n"],
  ["statuses that aren't status codes", "scenarios:\n  - name: a\n    steps:\n      - request: GET /\n        concurrency: 2\n        expect: { statuses: { ok: 2 } }\n"],
  ["an unknown mail key", "scenarios:\n  - name: a\n    steps:\n      - mail: { subjct: Hi }\n"],
  ["checkpoint that isn't true", "scenarios:\n  - name: a\n    steps:\n      - checkpoint: yes please\n"],
  ["submit without a button", "scenarios:\n  - name: a\n    steps:\n      - submit: false\n"],
  ["a submit field that is a mapping", "scenarios:\n  - name: a\n    steps:\n      - submit: Go\n        fields: { a: { b: 1 } }\n"],
  ["a stub with both on and graphql", "scenarios:\n  - name: a\n    steps:\n      - stub: s\n        on: POST /graphql\n        graphql: Q\n        reply: { data: {} }\n"],
  ["a GraphQL reply with a body", "scenarios:\n  - name: a\n    steps:\n      - stub: s\n        graphql: Q\n        reply: { body: x, data: {} }\n"],
  ["a request with both json and graphql", "scenarios:\n  - name: a\n    steps:\n      - request: POST /graphql\n        json: {}\n        graphql: \"{ a }\"\n"],
  ["a graphql request with an unknown key", "scenarios:\n  - name: a\n    steps:\n      - request: POST /graphql\n        graphql: { query: \"{ a }\", vars: {} }\n"],
  ["received with both call and graphql", "scenarios:\n  - name: a\n    steps:\n      - received: s\n        call: POST /graphql\n        graphql: Q\n"],
  ["a reply with both body and sse", "scenarios:\n  - name: a\n    steps:\n      - stub: s\n        on: GET /\n        reply: { body: x, sse: [{ data: y }] }\n"],
  ["an sse event without data", "scenarios:\n  - name: a\n    steps:\n      - stub: s\n        on: GET /\n        reply: { sse: [{ event: start }] }\n"],
  ["statuses on submit", "scenarios:\n  - name: a\n    steps:\n      - submit: Go\n        expect: { statuses: { 200: 1 } }\n"],
])("the schema and the parser both reject %s", (_, text) => {
  expect(parserError(text)).toBeDefined();
  expect(schemaErrors(text)).not.toEqual([]);
});
