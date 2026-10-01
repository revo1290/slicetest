import { expect, test } from "vitest";
import { parseScenarioFile } from "../src/yaml.js";
import { interpolate, lookup, toMatchers } from "../src/yaml-runtime.js";

const parse = (text: string) => parseScenarioFile(text, "s.scenario.yaml");

test("parses scenarios and records each step's line", () => {
  const doc = parse(`
setup:
  - stub: slack
    on: POST /hook
    reply: { status: 200 }
scenarios:
  - name: a
    steps:
      - request: GET /health
        expect: { status: 200 }
`);
  expect(doc.setup[0]).toMatchObject({ stub: "slack", line: 3 });
  expect(doc.scenarios[0]).toMatchObject({ name: "a", line: 7, steps: [{ request: "GET /health", line: 9 }] });
});

test.each([
  ["scenarios: []", "s.scenario.yaml:1: `scenarios:` must be a non-empty list"],
  ["scenarios:\n  - name: a\n    steps:\n      - reqest: GET /\n", "s.scenario.yaml:4: a step needs one of: stub, request, submit, insert, sql, db, received"],
  ["scenarios:\n  - name: a\n    steps:\n      - request: GET /\n        expect: { stauts: 200 }\n", 's.scenario.yaml:5: unknown key "stauts" in expect'],
  ["scenarios:\n  - name: a\n    steps:\n      - request: /polls\n", 's.scenario.yaml:4: `request` must look like "POST /path", got "/polls"'],
  ["scenarios:\n  - name: a\n    steps:\n      - stub: s\n        on: GET /\n", "exactly one of reply / sequence / networkError"],
  ["scenarios:\n  - name: a\n    steps:\n      - request: GET /\n        db: t\n", "a step can only be one of request / db"],
  ["scenarios:\n  - name: a\n    step: []\n", 'unknown scenario key "step"'],
  ["scenarios:\n  - name: a\n    steps:\n      - request: GET /\n    json: {\n", "s.scenario.yaml:6: Flow map"],
  ["scenarios:\n  - name: a\n    steps:\n      - changes: { polls: { added: 1 } }\n", 'unknown key "added" in changes of "polls"'],
  ["scenarios:\n  - name: a\n    steps:\n      - changes: { polls: { inserted: yes } }\n", "polls.inserted must be a count or a list of rows"],
  ["scenarios:\n  - name: a\n    steps:\n      - checkpoint: db\n", "use `checkpoint: true`"],
  ["scenarios:\n  - name: a\n    steps:\n      - log: \"(\"\n", "`log` must be a regular expression"],
  ["scenarios:\n  - name: a\n    steps:\n      - db: t\n        within: 0\n", "`within` must be a positive number of milliseconds"],
  ["scenarios:\n  - name: a\n    steps:\n      - request: GET /\n        within: 100\n", 'unknown key "within" in a request step'],
])("rejects %j", (text, message) => {
  expect(() => parse(text)).toThrow(message);
});

test("parses changes, checkpoint and within", () => {
  const doc = parse(`
scenarios:
  - name: a
    steps:
      - checkpoint: true
      - changes: { votes: { inserted: [{ choice: a }], deleted: 0 } }
        within: 500
`);
  expect(doc.scenarios[0]!.steps).toMatchObject([{ checkpoint: true }, { changes: { votes: { inserted: [{ choice: "a" }], deleted: 0 } }, within: 500 }]);
});

test("interpolation keeps the type of whole-value placeholders", () => {
  const vars = { id: 7, user: { name: "a" }, list: [1] };

  expect(interpolate({ id: "{{id}}", path: "/u/{{id}}", who: "{{ user.name }}", raw: "{{list}}", json: "x{{list}}" }, vars)).toEqual({
    id: 7,
    path: "/u/7",
    who: "a",
    raw: [1],
    json: "x[1]",
  });
  expect(() => interpolate("{{nope}}", vars)).toThrow("unknown variable {{nope}}. Defined so far: id, user, list");
});

test("lookup reads dotted and bracketed paths", () => {
  expect(lookup({ json: { items: [{ id: 3 }] } }, "json.items[0].id")).toBe(3);
  expect(lookup({ json: { items: [{ id: 3 }] } }, "json.items.0.id")).toBe(3);
  expect(lookup({}, "json.x.y")).toBeUndefined();
});

test("$-objects become asymmetric matchers", () => {
  const m = toMatchers({ id: { $type: "number" }, ref: { $regex: "^ch_" }, note: { $contains: "ok" }, any: { $any: true }, gone: { $type: "null" } });

  expect({ id: 1, ref: "ch_9", note: "is ok", any: 0, gone: null }).toEqual(m);
  expect({ id: "1", ref: "ch_9", note: "is ok", any: 0, gone: null }).not.toEqual(m);
  expect(() => toMatchers({ $typo: 1 })).toThrow("unknown matcher $typo");
});
