import http from "node:http";
import type { AddressInfo } from "node:net";
import { isDeepStrictEqual } from "node:util";

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** Parsed JSON body, or undefined when the body isn't JSON. */
  json: any;
  /** Values captured by `:name` segments of the matching route's path. */
  params: Record<string, string>;
  /** Whether a registered route answered this call. */
  matched: boolean;
  /** What the stub answered, once it has. */
  response?: { status: number; headers: Record<string, string>; body: string };
  /** Answered by the fallback (e.g. an example from the provider's OpenAPI spec), not a registered route. */
  fallback?: boolean;
}

export interface StubResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Objects are sent as JSON. */
  body?: unknown;
}

export type Responder = StubResponse | ((call: RecordedCall) => StubResponse | Promise<StubResponse>);

/**
 * Extra conditions a call must meet for a route to answer it. Plain values are
 * compared exactly (`json` as a subset); RegExps test strings; functions and
 * `expect.*` asymmetric matchers receive the actual value.
 */
export interface MatchOptions {
  query?: Record<string, Matcher>;
  headers?: Record<string, Matcher>;
  json?: unknown;
  body?: Matcher;
}

type Matcher = string | number | boolean | RegExp | ((value: any) => boolean) | { asymmetricMatch(value: unknown): boolean };

interface Route {
  method: string;
  path: string | RegExp;
  pattern?: RegExp;
  paramNames: string[];
  match: MatchOptions;
  respond: Responder;
  /** Remaining answers; Infinity unless limited with times()/once(). */
  remaining: number;
  delayMs: number;
  fault?: "reset";
  hits: number;
}

/** Builder returned by `stub.on()`. Finish it with `reply()` or `networkError()`. */
export interface RouteBuilder {
  /** Answer only the next `n` matching calls; later calls fall through to other routes. */
  times(n: number): RouteBuilder;
  once(): RouteBuilder;
  /** Wait before answering, e.g. to exercise the app's timeouts. */
  delay(ms: number): RouteBuilder;
  reply(status: number, body?: unknown, headers?: Record<string, string>): Stub;
  reply(response: Responder): Stub;
  /** Answer each matching call with the next response in the list; the last one repeats. */
  replySequence(responses: StubResponse[]): Stub;
  /** Drop the connection without answering. */
  networkError(): Stub;
}

/**
 * A fake outbound service. The app is pointed at `url`; tests register routes
 * with `on()` and inspect what the app sent with `calls()`.
 */
export class Stub {
  #server: http.Server;
  #routes: Route[] = [];
  #calls: RecordedCall[] = [];
  #fallback?: (call: RecordedCall) => StubResponse | undefined;
  url = "";

  private constructor(readonly name: string) {
    this.#server = http.createServer((req, res) => {
      // An aborted request rejects while reading the body; don't let that crash the worker.
      this.#handle(req, res).catch(() => res.destroy());
    });
  }

  static async start(name: string) {
    const stub = new Stub(name);
    await new Promise<void>((resolve) => stub.#server.listen(0, "127.0.0.1", resolve));
    stub.url = `http://127.0.0.1:${(stub.#server.address() as AddressInfo).port}`;
    return stub;
  }

  /**
   * Answer `method path`. `path` may contain `:name` segments (captured into
   * `call.params`) or be a RegExp; `method` may be `*`. Later routes win.
   */
  on(method: string, path: string | RegExp, match: MatchOptions = {}): RouteBuilder {
    const { pattern, paramNames } = compilePath(path);
    const route: Omit<Route, "respond"> = {
      method: method.toUpperCase(),
      path,
      pattern,
      paramNames,
      match,
      remaining: Infinity,
      delayMs: 0,
      hits: 0,
    };
    const add = (respond: Responder, extra: Partial<Route> = {}) => {
      this.#routes.unshift({ ...route, ...extra, respond });
      return this;
    };
    const builder: RouteBuilder = {
      times: (n) => ((route.remaining = n), builder),
      once: () => builder.times(1),
      delay: (ms) => ((route.delayMs = ms), builder),
      reply: (statusOrResponse: number | Responder, body?: unknown, headers?: Record<string, string>) =>
        add(typeof statusOrResponse === "number" ? { status: statusOrResponse, body, headers } : statusOrResponse),
      replySequence: (responses) => {
        if (responses.length === 0) throw new Error("slicetest: replySequence() needs at least one response");
        let i = 0;
        return add(() => responses[Math.min(i++, responses.length - 1)]!);
      },
      networkError: () => add({}, { fault: "reset" }),
    };
    return builder;
  }

  /** Calls received so far, optionally filtered by method, path and conditions (same syntax as `on()`). */
  calls(method?: string, path?: string | RegExp, match: MatchOptions = {}): RecordedCall[] {
    const compiled = path === undefined ? undefined : compilePath(path);
    return this.#calls.filter(
      (c) =>
        (!method || method === "*" || c.method === method.toUpperCase()) &&
        (!compiled || matchPath(path!, compiled.pattern, c.path) !== undefined) &&
        matchConditions(match, c),
    );
  }

  unmatched() {
    return this.#calls.filter((c) => !c.matched);
  }

  /** Human-readable list of registered routes, for diagnostics. */
  describeRoutes() {
    return this.#routes.map((r) => {
      const limit = Number.isFinite(r.remaining + r.hits) ? ` (${r.hits}/${r.remaining + r.hits} used)` : "";
      const cond = Object.keys(r.match).length ? ` + ${Object.keys(r.match).join("/")} conditions` : "";
      return `${r.method} ${r.path}${cond}${limit}`;
    });
  }

  reset() {
    this.#routes = [];
    this.#calls = [];
  }

  /**
   * Answer calls that no registered route matches, instead of failing with 501.
   * Return undefined to leave a call unanswered (it then fails the scenario as usual).
   * Kept across scenarios, unlike routes.
   */
  fallback(respond: ((call: RecordedCall) => StubResponse | undefined) | undefined) {
    this.#fallback = respond;
    return this;
  }

  async close() {
    this.#server.closeAllConnections();
    await new Promise((resolve) => this.#server.close(resolve));
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", this.url);
    const call: RecordedCall = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body,
      json: parseJson(body),
      params: {},
      matched: false,
    };
    this.#calls.push(call);

    let route: Route | undefined;
    for (const r of this.#routes) {
      if (r.remaining <= 0) continue;
      if (r.method !== "*" && r.method !== call.method) continue;
      const params = matchPath(r.path, r.pattern, call.path, r.paramNames);
      if (!params || !matchConditions(r.match, call)) continue;
      call.params = params;
      route = r;
      break;
    }
    if (!route) {
      const out = this.#fallback?.(call);
      if (!out) {
        res.writeHead(501, { "content-type": "text/plain" }).end(`slicetest: no stub for ${call.method} ${call.path}`);
        return;
      }
      call.matched = true;
      call.fallback = true;
      this.#send(call, res, out);
      return;
    }
    call.matched = true;
    route.remaining--;
    route.hits++;
    if (route.delayMs > 0) await new Promise((r) => setTimeout(r, route.delayMs));
    if (route.fault === "reset") {
      req.socket.destroy();
      return;
    }
    try {
      this.#send(call, res, typeof route.respond === "function" ? await route.respond(call) : route.respond);
    } catch (e) {
      res.writeHead(500).end(`slicetest: stub handler threw: ${e}`);
    }
  }

  #send(call: RecordedCall, res: http.ServerResponse, out: StubResponse) {
    const raw = out.body === undefined || typeof out.body === "string" || out.body instanceof Uint8Array;
    const headers = { ...out.headers };
    if (!raw && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
    const payload = raw ? (out.body as string | Uint8Array | undefined) : JSON.stringify(out.body);
    call.response = {
      status: out.status ?? 200,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      body: payload === undefined ? "" : typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8"),
    };
    res.writeHead(out.status ?? 200, headers);
    res.end(payload);
  }
}

function compilePath(path: string | RegExp) {
  if (typeof path !== "string" || !path.includes("/:")) return { pattern: undefined, paramNames: [] };
  const paramNames: string[] = [];
  const source = path
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":")) return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      paramNames.push(seg.slice(1));
      return "([^/]+)";
    })
    .join("/");
  return { pattern: new RegExp(`^${source}$`), paramNames };
}

/** Returns captured params on a match, undefined otherwise. */
function matchPath(path: string | RegExp, pattern: RegExp | undefined, actual: string, names: string[] = []) {
  if (typeof path === "string" && !pattern) return path === actual ? {} : undefined;
  const re = pattern ?? (path as RegExp);
  re.lastIndex = 0;
  const m = re.exec(actual);
  if (!m) return undefined;
  const params: Record<string, string> = { ...m.groups };
  names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1]!)));
  return params;
}

function matchConditions(match: MatchOptions, call: RecordedCall) {
  for (const [k, m] of Object.entries(match.query ?? {})) {
    if (!test(m, call.query.get(k) ?? undefined)) return false;
  }
  for (const [k, m] of Object.entries(match.headers ?? {})) {
    const v = call.headers[k.toLowerCase()];
    if (!test(m, Array.isArray(v) ? v.join(", ") : v)) return false;
  }
  if (match.body !== undefined && !test(match.body, call.body)) return false;
  if (match.json !== undefined && !subset(match.json, call.json)) return false;
  return true;
}

function test(m: Matcher, value: string | undefined): boolean {
  if (isAsymmetric(m)) return m.asymmetricMatch(value);
  if (typeof m === "function") return m(value);
  if (value === undefined) return false;
  if (typeof m === "number" || typeof m === "boolean") return String(m) === value;
  return m instanceof RegExp ? m.test(value) : m === value;
}

/** `expected` is contained in `actual`: objects compare key by key, arrays element-wise. */
export function subset(expected: unknown, actual: unknown): boolean {
  if (isAsymmetric(expected)) return expected.asymmetricMatch(actual);
  if (expected instanceof RegExp) return typeof actual === "string" && expected.test(actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => subset(e, actual[i]));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => subset(v, (actual as Record<string, unknown>)[k]));
  }
  return isDeepStrictEqual(expected, actual);
}

function isAsymmetric(m: unknown): m is { asymmetricMatch(value: unknown): boolean } {
  return !!m && typeof m === "object" && typeof (m as { asymmetricMatch?: unknown }).asymmetricMatch === "function";
}

function parseJson(body: string) {
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
