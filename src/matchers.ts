import { expect } from "vitest";
import { Db, type Where } from "./db.js";
import type { HttpResponse } from "./http.js";
import { Stub, type MatchOptions, type RecordedCall } from "./stub.js";

interface SlicetestMatchers<R = unknown> {
  /** The stub received at least one call matching `method path` (and `match`, if given). */
  toHaveReceived(method: string, path: string | RegExp, match?: MatchOptions): R;
  /** The stub received exactly `n` calls matching `method path`. */
  toHaveReceivedTimes(n: number, method?: string, path?: string | RegExp, match?: MatchOptions): R;
  /** The response has this status; the failure message shows the response body. */
  toHaveStatus(status: number): R;
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
    const body = c.body ? `  ${c.body.length > 200 ? `${c.body.slice(0, 200)}…` : c.body}` : "";
    return `  ${c.method} ${c.path}${q}${body}`;
  });
  const more = calls.length > MAX_SHOWN ? [`  …and ${calls.length - MAX_SHOWN} earlier`] : [];
  return [...more, ...shown].join("\n");
}

function assertStub(received: unknown): asserts received is Stub {
  if (!(received instanceof Stub)) throw new TypeError("slicetest: expected a stub, e.g. expect(stub(\"slack\"))");
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

  toHaveStatus(received: HttpResponse, status: number) {
    const pass = received?.status === status;
    return {
      pass,
      message: () => {
        const body = received.text.length > 1000 ? `${received.text.slice(0, 1000)}…` : received.text;
        return (
          `expected ${received.method} ${received.url} ${this.isNot ? "not " : ""}to respond ${status}, got ${received.status}\n` +
          `Response body:\n  ${body || "(empty)"}`
        );
      },
      actual: received?.status,
      expected: status,
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
