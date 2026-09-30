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
setup:
  - stub: pay
    on: POST /charges/:id
    when: { query: { a: "1" }, headers: { x: y }, json: { amount: 1 }, body: raw }
    reply: { status: 201, headers: { x-id: "1" }, body: { id: "{{call.params.id}}" } }
    times: 2
    delay: 10
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
      - request: POST /x
        headers: { a: b }
        query: { q: 1 }
        json: { a: 1 }
        follow: true
        expect: { status: 200, headers: { x: y }, json: { id: { $type: number } }, text: { $contains: ok } }
        capture: { id: json.id }
      - request: POST /form
        form: { a: b }
      - request: POST /raw
        body: hello
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
`;

test("the schema and the parser both accept every documented step and option", () => {
  expect(parserError(EVERYTHING)).toBeUndefined();
  expect(schemaErrors(EVERYTHING)).toEqual([]);
});

test.each([
  ["an unknown step key", "scenarios:\n  - name: a\n    steps:\n      - request: GET /\n        wat: 1\n"],
  ["an unknown step kind", "scenarios:\n  - name: a\n    steps:\n      - reqest: GET /\n"],
  ["an unknown scenario key", "scenarios:\n  - name: a\n    step: []\n"],
  ["an unknown top-level key", "scenario: []\n"],
  ["within on a request", "scenarios:\n  - name: a\n    steps:\n      - request: GET /\n        within: 10\n"],
  ["an unknown changes key", "scenarios:\n  - name: a\n    steps:\n      - changes: { t: { added: 1 } }\n"],
  ["checkpoint that isn't true", "scenarios:\n  - name: a\n    steps:\n      - checkpoint: yes please\n"],
])("the schema and the parser both reject %s", (_, text) => {
  expect(parserError(text)).toBeDefined();
  expect(schemaErrors(text)).not.toEqual([]);
});
