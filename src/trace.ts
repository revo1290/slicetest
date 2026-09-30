import type { Changes } from "./db.js";
import type { HttpResponse } from "./http.js";
import type { Mailbox } from "./mail.js";
import type { Stub } from "./stub.js";

/**
 * Everything one scenario did at the three boundaries: the requests it made to
 * the app, the calls the app made to stubs, and the rows it changed. Meant for
 * `expect(await trace()).toMatchSnapshot()`: resets make ids deterministic,
 * and `mask` replaces the values that aren't (timestamps, UUIDs).
 */
export interface Trace {
  http: { request: string; status: number; body?: unknown }[];
  stubs: Record<string, { request: string; body?: unknown; status?: number }[]>;
  db: Changes;
  /** Mail the app sent, when the `mail` option is on. */
  mail?: { from: string; to: string[]; subject: string; text: string }[];
}

export interface MaskOptions {
  /** Keys whose values are always replaced, e.g. `["token", "password_hash"]`. Matched at any depth. */
  keys?: string[];
  /** Also mask strings matching these patterns, e.g. `[/^tok_\w+$/]`. */
  patterns?: RegExp[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A copy of `value` with the parts that change from run to run replaced by
 * placeholders: dates (`Date` objects and ISO strings) by `[date]`, UUIDs by
 * `[uuid]`, and the values of `keys` / strings matching `patterns` by `[masked]`.
 */
export function mask<T>(value: T, opts: MaskOptions = {}): T {
  const keys = new Set(opts.keys ?? []);
  const walk = (v: unknown): unknown => {
    if (v instanceof Date) return "[date]";
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string") {
      if (UUID.test(v)) return "[uuid]";
      if (ISO_DATE.test(v)) return "[date]";
      if (opts.patterns?.some((p) => ((p.lastIndex = 0), p.test(v)))) return "[masked]";
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keys.has(k) && x != null ? "[masked]" : walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

export function buildTrace(history: readonly HttpResponse[], stubs: Iterable<Stub>, db: Changes, mailbox?: Mailbox): Trace {
  const trace: Trace = {
    http: history.map((r) => {
      const url = new URL(r.url, "http://app");
      const body = r.json !== undefined ? r.json : r.text || undefined;
      return { request: `${r.method} ${url.pathname}${url.search}`, status: r.status, ...(body !== undefined ? { body } : {}) };
    }),
    stubs: {},
    db,
  };
  for (const stub of stubs) {
    const calls = stub.calls();
    if (calls.length === 0) continue;
    trace.stubs[stub.name] = calls.map((c) => {
      const body = c.json !== undefined ? c.json : c.body || undefined;
      return {
        request: `${c.method} ${c.path}${c.query.size ? `?${c.query}` : ""}`,
        ...(body !== undefined ? { body } : {}),
        ...(c.response ? { status: c.response.status } : {}),
      };
    });
  }
  if (mailbox) trace.mail = mailbox.messages().map((m) => ({ from: m.from, to: m.to, subject: m.subject, text: m.text }));
  return trace;
}
