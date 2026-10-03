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
  ["scenarios:\n  - name: a\n    steps:\n      - request: GET /\n        expect: { duration: 0 }\n", "`expect.duration` is a number of milliseconds (at most)"],
  ["scenarios:\n  - name: a\n    steps:\n      - request: GET /\n        expect: { cookies: { sid: true } }\n", "`expect.cookies` maps cookie names to attributes"],
  ["scenarios:\n  - name: a\n    steps:\n      - request: GET /\n        within: 100\n        concurrency: 2\n", "can't be combined with `concurrency`"],
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

test("built-ins give ids, counters, times with offsets and environment variables", () => {
  process.env.SLICETEST_TEST_TOKEN = "t-1";
  const before = Date.now();
  const out = interpolate(
    { id: "{{$uuid}}", n: "{{$seq}}", m: "{{ $seq }}", now: "{{$now}}", later: "{{$now+1d}}", day: "{{$today-1d}}", ts: "{{$timestamp-30m}}", ms: "{{$timestampMs}}", token: "Bearer {{env.SLICETEST_TEST_TOKEN}}" },
    {},
  ) as Record<string, unknown>;

  expect(out.id).toMatch(/^[0-9a-f-]{36}$/);
  expect((out.m as number) - (out.n as number)).toBe(1);
  expect(Date.parse(out.later as string) - Date.parse(out.now as string)).toBeGreaterThanOrEqual(86_400_000 - 5);
  expect(out.day).toBe(new Date(before - 86_400_000).toISOString().slice(0, 10));
  expect(Math.abs((out.ts as number) - Math.floor((before - 1_800_000) / 1000))).toBeLessThanOrEqual(1);
  expect(out.ms).toBeGreaterThanOrEqual(before);
  expect(out.token).toBe("Bearer t-1");
  expect(interpolate("{{env.x}}", { env: { x: "captured" } })).toBe("captured");
  expect(() => interpolate("{{env.SLICETEST_NOT_SET}}", {})).toThrow("the environment variable SLICETEST_NOT_SET isn't set");
  expect(() => interpolate("{{$nope}}", {})).toThrow("unknown built-in {{$nope}}");
});

test("set steps are parsed, with variable names checked", () => {
  const doc = parseScenarioFile(`
scenarios:
  - name: s
    steps:
      - set: { orderId: "{{$uuid}}", expires: "{{$now+1h}}" }
`, "s.scenario.yaml");
  expect(doc.scenarios[0]!.steps[0]).toMatchObject({ set: { orderId: "{{$uuid}}", expires: "{{$now+1h}}" } });
  expect(() => parseScenarioFile("scenarios:\n  - name: s\n    steps:\n      - set: { order-id: 1 }\n", "s.scenario.yaml")).toThrow('"order-id" isn\'t a variable name');
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

test("comparison, length, negation, alternatives and formats match loosely", () => {
  const m = toMatchers({
    total: { $gte: 1, $lt: 10 },
    price: { $gt: 0 },
    created: { $gte: "2026-01-01", $format: "date-time" },
    items: { $len: { $gte: 2 } },
    tags: { $contains: "new" },
    lines: { $contains: { sku: "a" } },
    status: { $oneOf: ["paid", "pending"] },
    error: { $not: { $any: true } },
    id: { $format: "uuid" },
    count: { $type: "integer" },
    name: { $not: "" },
  });
  const ok = {
    total: 3,
    price: 0.5,
    created: "2026-10-03T09:00:00Z",
    items: [1, 2],
    tags: ["new", "sale"],
    lines: [{ sku: "b", n: 1 }, { sku: "a", n: 2 }],
    status: "pending",
    error: null,
    id: "3f1c2a5e-8d4b-4c1e-9a7f-0123456789ab",
    count: 4,
    name: "x",
  };
  expect(ok).toEqual(m);
  for (const [k, bad] of Object.entries({ total: 10, price: "abc", created: "2025-12-31T00:00:00Z", items: [1], tags: ["old"], lines: [{ sku: "b" }], status: "void", error: "boom", id: "nope", count: 1.5, name: "" })) {
    expect({ ...ok, [k]: bad }, k).not.toEqual(m);
  }
  // Decimal columns come back as strings: "12.50" still compares as a number, "1e3" and "" don't.
  expect({ ...ok, price: "12.50", total: "3" }).toEqual(m);
  expect({ ...ok, price: "-0.5" }).not.toEqual(m);
  expect({ ...ok, price: "1e3" }).not.toEqual(m);
  expect(() => toMatchers({ $gte: true })).toThrow("$gte takes a number or a string");
  expect(() => toMatchers({ $oneOf: "a" })).toThrow("$oneOf takes a list");
  expect(() => toMatchers({ $format: "ipv9" })).toThrow("$format must be one of");
});

const USES = (use: string) => `
define:
  login:
    params: [email]
    steps:
      - request: POST /login
        json: { email: "{{email}}" }
  twice:
    - use: login
      with: { email: a@b.test }
scenarios:
  - name: a
    steps:
${use}
`;

test("define and use: steps, params and line numbers", () => {
  const doc = parse(USES("      - use: twice"));
  expect(doc.define.login).toMatchObject({ params: ["email"], steps: [{ request: "POST /login", line: 6 }] });
  expect(doc.define.twice!.params).toEqual([]);
  expect(doc.scenarios[0]!.steps[0]).toMatchObject({ use: "twice", line: 14 });
});

test.each([
  ["an unknown definition", "      - use: logn", 's.scenario.yaml:14: no definition "logn" (defined: login, twice)'],
  ["a missing param", "      - use: login", "s.scenario.yaml:14: use login needs `with: { email }`"],
  ["an unknown param", "      - use: login\n        with: { email: x, pass: y }", 's.scenario.yaml:14: "pass" isn\'t a param of login (params: email)'],
])("use rejects %s", (_, use, message) => {
  expect(() => parse(USES(use))).toThrow(message);
});

test("a definition that uses itself, through another, is rejected", () => {
  const text = "define:\n  a:\n    - use: b\n  b:\n    - use: a\nscenarios:\n  - name: x\n    steps:\n      - use: a\n";
  expect(() => parse(text)).toThrow('s.scenario.yaml:5: "a" uses itself (a → b → a)');
});

test("a reply file excludes body, sse and GraphQL answers", () => {
  const src = (reply: string) => `scenarios:\n  - name: s\n    steps:\n      - stub: svc\n        on: GET /x\n        reply: ${reply}\n`;
  expect(parseScenarioFile(src("{ file: replies/a.json, status: 201 }"), "s.scenario.yaml").scenarios[0]!.steps[0]).toMatchObject({ reply: { file: "replies/a.json", status: 201 } });
  expect(() => parseScenarioFile(src("{ file: a.json, body: x }"), "s.scenario.yaml")).toThrow("a reply has `file` instead of `body`");
});

test("ignored() reads columns, table.column and table.*", async () => {
  const { ignored } = await import("../src/db.js");
  const list = ["updated_at", "orders.synced_at", "sessions.*", "billing.invoices.paid_at"];
  expect(ignored(list, "orders")).toEqual(new Set(["updated_at", "synced_at"]));
  expect(ignored(list, "users")).toEqual(new Set(["updated_at"]));
  expect(ignored(list, "sessions")).toBe("*");
  expect(ignored(list, "billing.invoices")).toEqual(new Set(["updated_at", "paid_at"]));
  expect(ignored(["invoices.*"], "billing.invoices")).toBe("*");
});

test("order steps need two calls in the <stub> METHOD /path form", () => {
  const src = (order: string) => `scenarios:\n  - name: s\n    steps:\n      - order: ${order}\n`;
  expect(parseScenarioFile(src('["a GET /x", { stub: b, call: POST /y, when: { json: { k: 1 } } }]'), "s.scenario.yaml").scenarios[0]!.steps[0]).toMatchObject({ order: ["a GET /x", { stub: "b" }] });
  expect(() => parseScenarioFile(src('["a GET /x"]'), "s.scenario.yaml")).toThrow("lists at least two calls");
  expect(() => parseScenarioFile(src('["a GET /x", "POST /y"]'), "s.scenario.yaml")).toThrow('"POST /y" should be "<stub> METHOD /path"');
});

test("a request step takes a timeout in ms", () => {
  const src = (t: string) => `scenarios:\n  - name: s\n    steps:\n      - request: GET /slow\n        timeout: ${t}\n`;
  expect(parseScenarioFile(src("500"), "s.scenario.yaml").scenarios[0]!.steps[0]).toMatchObject({ timeout: 500 });
  expect(() => parseScenarioFile(src("soon"), "s.scenario.yaml")).toThrow("`timeout` must be a positive number of milliseconds");
});
