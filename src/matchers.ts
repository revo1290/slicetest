import { expect } from "vitest";
import { Db, type Where } from "./db.js";
import type { HttpResponse } from "./http.js";
import { describeGraphQL } from "./graphql.js";
import { schemaProblems } from "./schema.js";
import { Stub, subset, type MatchOptions, type RecordedCall } from "./stub.js";
import { timeline } from "./timeline.js";

/** One expected call for `toHaveReceivedInOrder`: `[stub, method, path, match?]`. */
export type OrderedCall = [stub: string, method: string, path: string | RegExp, match?: MatchOptions];

interface SlicetestMatchers<R = unknown> {
  /** The stub received at least one call matching `method path` (and `match`, if given). */
  toHaveReceived(method: string, path: string | RegExp, match?: MatchOptions): R;
  /** The stub received exactly `n` calls matching `method path`. */
  toHaveReceivedTimes(n: number, method?: string, path?: string | RegExp, match?: MatchOptions): R;
  /**
   * On the scenario's `stub` accessor: the calls happened in this order, across stubs (other calls
   * may come in between): `expect(stub).toHaveReceivedInOrder([["stripe", "POST", "/v1/charges"], ["mail", "POST", "/send"]])`.
   */
  toHaveReceivedInOrder(calls: OrderedCall[]): R;
  /** The stub received a GraphQL request for `operation` (with `variables` as a subset, if given). */
  toHaveReceivedGraphQL(operation: string | RegExp, variables?: unknown): R;
  /** A GraphQL response without `errors`, whose `data` contains `expected` (if given). The failure message shows the errors. */
  toHaveGraphQLData(expected?: unknown): R;
  /**
   * The value (a response's JSON, for a response) matches a JSON Schema: an object, or a file
   * relative to the working directory with an optional pointer, `openapi.yaml#/components/schemas/Poll`.
   */
  toMatchSchema(schema: object | string): R;
  /** The response has this status, a status of this class (`"2xx"`) or one of a list (`[200, 204]`); the failure message shows the response body. */
  toHaveStatus(status: number | `${1 | 2 | 3 | 4 | 5}xx` | (number | `${1 | 2 | 3 | 4 | 5}xx`)[]): R;
  /** An array of responses has exactly these status counts, e.g. `{ 201: 1, 409: 9 }`. */
  toHaveStatuses(counts: Record<number, number>): R;
  /** Async: the table has at least one row matching `where` (`count` for an exact number). */
  toHaveRow(table: string, where?: Where, count?: number): Promise<void>;
}

declare module "vitest" {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> extends SlicetestMatchers<R> {}
}

const MAX_SHOWN = 5;

function describeCalls(calls: RecordedCall[]) {
  if (calls.length === 0) return "  (no calls)";
  const shown = calls.slice(-MAX_SHOWN).map((c) => {
    const q = c.query.size ? `?${c.query}` : "";
    if (c.graphql) return `  ${describeGraphQL(c.graphql)} (${c.method} ${c.path})  variables ${JSON.stringify(c.graphql.variables)}`;
    const body = c.body ? `  ${c.body.length > 200 ? `${c.body.slice(0, 200)}…` : c.body}` : "";
    return `  ${c.method} ${c.path}${q}${body}`;
  });
  const more = calls.length > MAX_SHOWN ? [`  …and ${calls.length - MAX_SHOWN} earlier`] : [];
  return [...more, ...shown].join("\n");
}

function assertStub(received: unknown): asserts received is Stub {
  if (!(received instanceof Stub)) throw new TypeError("slicetest: expected a stub, e.g. expect(stub(\"slack\"))");
}

/** A status code, a class (`"2xx"`), or a list of either: `[200, 204]`, `["2xx", 304]`. */
export type ExpectedStatus = number | string | (number | string)[];

export function statusMatches(expected: ExpectedStatus, actual: number): boolean {
  if (Array.isArray(expected)) {
    if (expected.length === 0) throw new TypeError("slicetest: toHaveStatus needs at least one status in the list");
    return expected.some((e) => statusMatches(e, actual));
  }
  if (typeof expected === "number") return expected === actual;
  const s = String(expected).trim().toLowerCase();
  if (/^\d{3}$/.test(s)) return Number(s) === actual;
  if (/^[1-5]xx$/.test(s)) return Math.floor(actual / 100) === Number(s[0]);
  throw new TypeError(`slicetest: a status is a code (201), a class ("2xx") or a list of them, got ${JSON.stringify(expected)}`);
}

function describeStatus(expected: ExpectedStatus): string {
  return Array.isArray(expected) ? `one of ${expected.join(", ")}` : String(expected);
}

export function statusCounts(responses: HttpResponse[]) {
  const out: Record<number, number> = {};
  for (const r of responses) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

function fmtCounts(c: Record<number, number>) {
  return `{ ${Object.entries(c).map(([k, n]) => `${k}: ${n}`).join(", ")} }`;
}

/** One example response per status, which is usually what explains the odd one out. */
function describeResponses(responses: HttpResponse[]) {
  const seen = new Map<number, HttpResponse>();
  for (const r of responses) if (!seen.has(r.status)) seen.set(r.status, r);
  return [...seen.values()]
    .map((r) => `  ${r.status || "failed"}: ${r.method} ${r.url}  ${(r.text.length > 200 ? `${r.text.slice(0, 200)}…` : r.text).replace(/\s+/g, " ") || "(empty)"}`)
    .join("\n");
}

expect.extend({
  toHaveReceived(received: unknown, method: string, path: string | RegExp, match?: MatchOptions) {
    assertStub(received);
    const pass = received.calls(method, path, match).length > 0;
    const cond = match && Object.keys(match).length ? ` with ${this.utils.stringify(match)}` : "";
    return {
      pass,
      message: () =>
        `expected stub "${received.name}" ${pass ? "not " : ""}to have received ${method} ${path}${cond}\n` +
        `Calls received:\n${describeCalls(received.calls())}`,
    };
  },

  toHaveReceivedTimes(received: unknown, n: number, method?: string, path?: string | RegExp, match?: MatchOptions) {
    assertStub(received);
    const actual = received.calls(method, path, match).length;
    const what = method ? `${method} ${path ?? "*"}` : "calls";
    return {
      pass: actual === n,
      message: () =>
        `expected stub "${received.name}" to have received ${what} ${this.isNot ? "not " : ""}${n} time(s), got ${actual}\n` +
        `Calls received:\n${describeCalls(received.calls())}`,
      actual,
      expected: n,
    };
  },

  toHaveReceivedInOrder(received: unknown, expected: OrderedCall[]) {
    if (typeof received !== "function") throw new TypeError("slicetest: toHaveReceivedInOrder takes the scenario's stub accessor: expect(stub).toHaveReceivedInOrder([...])");
    const stubOf = received as (name: string) => Stub;
    const startOf = (c: RecordedCall) => timeline.get(c)?.start ?? 0;
    let after = -Infinity;
    let failedAt = -1;
    for (const [i, [name, method, path, match]] of expected.entries()) {
      const next = stubOf(name)
        .calls(method, path, match)
        .map(startOf)
        .filter((t) => t > after)
        .sort((a, b) => a - b)[0];
      if (next === undefined) {
        failedAt = i;
        break;
      }
      after = next;
    }
    const names = [...new Set(expected.map(([n]) => n))];
    const all = names
      .flatMap((n) => stubOf(n).calls().map((c) => ({ n, c })))
      .sort((a, b) => startOf(a.c) - startOf(b.c))
      .map(({ n, c }) => `  ${n}: ${c.graphql ? describeGraphQL(c.graphql) : `${c.method} ${c.path}`}`);
    const label = ([n, m, p, match]: OrderedCall) => `${n}: ${m} ${p}${match && Object.keys(match).length ? ` with ${JSON.stringify(match, (_, v) => (v instanceof RegExp ? String(v) : v))}` : ""}`;
    return {
      pass: failedAt === -1,
      message: () =>
        failedAt === -1
          ? `expected the stubs not to receive, in this order:\n${expected.map((e) => `  ${label(e)}`).join("\n")}`
          : `expected the stubs to receive, in this order:\n${expected.map((e, i) => `  ${i === failedAt ? "✗" : i < failedAt ? "✓" : " "} ${label(e)}`).join("\n")}\n` +
            `${failedAt === 0 ? "the first call never came" : `no matching call came after #${failedAt}`}. Calls received, in order:\n${all.join("\n") || "  (no calls)"}`,
    };
  },

  toHaveReceivedGraphQL(received: unknown, operation: string | RegExp, variables?: unknown) {
    assertStub(received);
    const pass = received.calls("*", undefined, { graphql: { operation, variables } }).length > 0;
    const cond = variables === undefined ? "" : ` with variables ${this.utils.stringify(variables)}`;
    return {
      pass,
      message: () =>
        `expected stub "${received.name}" ${pass ? "not " : ""}to have received GraphQL ${operation}${cond}\n` +
        `Calls received:\n${describeCalls(received.calls())}`,
    };
  },

  toHaveGraphQLData(received: HttpResponse, expected?: unknown) {
    const body = received?.json;
    const errors = body && typeof body === "object" ? body.errors : undefined;
    const isGraphQL = body && typeof body === "object" && ("data" in body || "errors" in body);
    const hasErrors = Array.isArray(errors) && errors.length > 0;
    const pass = received?.status === 200 && isGraphQL && !hasErrors && (expected === undefined || subset(expected, body.data));
    return {
      pass,
      message: () => {
        const head = `expected ${received.method} ${received.url} ${this.isNot ? "not " : ""}to answer GraphQL data${expected === undefined ? "" : ` containing ${this.utils.stringify(expected)}`}`;
        if (!isGraphQL) return `${head}, got status ${received.status} without data or errors:\n  ${received.text.slice(0, 1000) || "(empty)"}`;
        if (hasErrors) return `${head}, got errors:\n${(errors as { message?: string; path?: unknown[] }[]).map((e) => `  ${e.message}${e.path ? ` (at ${e.path.join(".")})` : ""}`).join("\n")}`;
        return `${head}, got status ${received.status} and data:\n  ${JSON.stringify(body.data)}`;
      },
      actual: body?.data,
      expected,
    };
  },

  toMatchSchema(received: unknown, schema: object | string) {
    const isResponse = !!received && typeof received === "object" && "status" in received && (received as HttpResponse).headers instanceof Headers;
    const value = isResponse ? (received as HttpResponse).json : received;
    const problems = schemaProblems(schema, value);
    const what = isResponse ? `${(received as HttpResponse).method} ${(received as HttpResponse).url}'s JSON` : "the value";
    return {
      pass: problems.length === 0,
      message: () =>
        problems.length
          ? `expected ${what} to match ${typeof schema === "string" ? schema : "the schema"}:\n${problems.map((p) => `  ${p}`).join("\n")}\nValue:\n  ${JSON.stringify(value)?.slice(0, 1000)}`
          : `expected ${what} not to match ${typeof schema === "string" ? schema : "the schema"}`,
    };
  },

  toHaveStatus(received: HttpResponse, status: ExpectedStatus) {
    if (!received || typeof received !== "object" || typeof received.status !== "number") {
      throw new TypeError(`slicetest: toHaveStatus expects a response from http, got ${this.utils.stringify(received)}`);
    }
    const pass = statusMatches(status, received.status);
    return {
      pass,
      message: () => {
        const body = received.text.length > 1000 ? `${received.text.slice(0, 1000)}…` : received.text;
        return (
          `expected ${received.method} ${received.url} ${this.isNot ? "not " : ""}to respond ${describeStatus(status)}, got ${received.status}\n` +
          `Response body:\n  ${body || "(empty)"}`
        );
      },
      actual: received?.status,
      expected: status,
    };
  },

  toHaveStatuses(received: HttpResponse[], counts: Record<number, number>) {
    if (!Array.isArray(received)) throw new TypeError("slicetest: toHaveStatuses expects an array of responses, e.g. from http.concurrently()");
    const actual = statusCounts(received);
    const expected = Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => [Number(k), n]));
    const pass = this.equals(actual, expected);
    return {
      pass,
      message: () =>
        `expected ${received.length} responses ${this.isNot ? "not " : ""}to have statuses ${fmtCounts(expected)}, got ${fmtCounts(actual)}\n` +
        describeResponses(received),
      actual,
      expected,
    };
  },

  async toHaveRow(received: unknown, table: string, where: Where = {}, count?: number) {
    if (!(received instanceof Db)) throw new TypeError("slicetest: expected the db handle, e.g. expect(db)");
    const n = await received.count(table, where);
    const pass = count === undefined ? n > 0 : n === count;
    const sample = pass ? [] : await received.rows(table, {}, { limit: MAX_SHOWN });
    const want = count === undefined ? "a row" : `${count} row(s)`;
    return {
      pass,
      message: () =>
        `expected ${table} ${this.isNot ? "not " : ""}to have ${want} matching ${this.utils.stringify(where)}, found ${n}\n` +
        (sample.length ? `First rows in ${table}:\n${sample.map((r) => `  ${JSON.stringify(r)}`).join("\n")}` : `${table} is empty`),
    };
  },
});
