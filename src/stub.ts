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
  /** The fault `chaos()` injected instead of the normal answer: `503`, `reset`. */
  fault?: string;
}

/**
 * Faults injected into a stub's answers, to test the app's retries, timeouts and
 * fallbacks. Random faults come from a seeded generator, so a failing run can be
 * replayed with the seed printed in the failure output.
 */
export interface ChaosOptions {
  /** Fail the first `n` calls, then answer normally: the shape of a retry test. */
  failFirst?: number;
  /** Share of calls (0–1) answered with one of `statuses`. */
  errorRate?: number;
  /** Error statuses to pick from. Default [500, 502, 503]; 429 and 503 come with `Retry-After: 1`. */
  statuses?: number[];
  /** Share of calls (0–1) whose connection is dropped without an answer. */
  networkErrorRate?: number;
  /** Extra delay for every call, in ms: a fixed value or a [min, max] range. */
  latency?: number | [number, number];
  /** Seed for the random choices. Default: `SLICETEST_CHAOS_SEED`, else random. */
  seed?: number;
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
  #fallback?: (call: RecordedCall) => StubResponse | undefined | Promise<StubResponse | undefined>;
  /** Appended to the 501 answer for a call nothing could answer. */
  #hint?: string;
  #chaos?: { opts: ChaosOptions; seed: number; random: () => number; calls: number };
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

  /**
   * Inject faults into this stub's answers for the rest of the scenario:
   * `stub("payments").chaos({ failFirst: 2 })` to test a retry,
   * `chaos({ errorRate: 0.3, latency: [50, 200] })` to test resilience.
   * Calls that fault don't use up `once()` / `times()` routes.
   */
  chaos(opts: ChaosOptions) {
    for (const key of ["errorRate", "networkErrorRate"] as const) {
      const v = opts[key];
      if (v !== undefined && !(v >= 0 && v <= 1)) throw new Error(`slicetest: chaos ${key} must be between 0 and 1, got ${v}`);
    }
    if (opts.statuses && (opts.statuses.length === 0 || opts.statuses.some((s) => !Number.isInteger(s) || s < 400 || s > 599))) {
      throw new Error(`slicetest: chaos statuses must be 4xx/5xx codes, got ${JSON.stringify(opts.statuses)}`);
    }
    const envSeed = Number(process.env.SLICETEST_CHAOS_SEED);
    const seed = opts.seed ?? (Number.isInteger(envSeed) ? envSeed : Math.floor(Math.random() * 2 ** 31));
    this.#chaos = { opts, seed, random: mulberry32(seed), calls: 0 };
    return this;
  }

  /** Calls `chaos()` answered with a fault. */
  faults() {
    return this.#calls.filter((c) => c.fault !== undefined);
  }

  /** The active `chaos()` settings and what they did, for failure output; undefined when off. */
  describeChaos() {
    const c = this.#chaos;
    if (!c) return undefined;
    const settings = Object.entries(c.opts)
      .filter(([k]) => k !== "seed")
      .map(([k, v]) => `${k} ${JSON.stringify(v)}`)
      .join(", ");
    return `chaos on ${this.name}: ${settings}; ${this.faults().length} of ${c.calls} calls faulted. Replay with SLICETEST_CHAOS_SEED=${c.seed}`;
  }

  /** Delay and fault for the next call, consuming the random sequence in a fixed order. */
  async #injectFault(): Promise<{ status: number } | "reset" | undefined> {
    const c = this.#chaos;
    if (!c) return undefined;
    const { opts, random } = c;
    const n = ++c.calls;
    const lat = opts.latency;
    const ms = lat === undefined ? 0 : Array.isArray(lat) ? lat[0] + Math.floor(random() * (lat[1] - lat[0] + 1)) : lat;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    const statuses = opts.statuses ?? [500, 502, 503];
    const pick = () => statuses[Math.floor(random() * statuses.length)]!;
    if (opts.failFirst !== undefined && n <= opts.failFirst) return { status: pick() };
    const roll = random();
    if (roll < (opts.networkErrorRate ?? 0)) return "reset";
    if (roll < (opts.networkErrorRate ?? 0) + (opts.errorRate ?? 0)) return { status: pick() };
    return undefined;
  }

  #fail(call: RecordedCall, req: http.IncomingMessage, res: http.ServerResponse, fault: { status: number } | "reset") {
    call.matched = true;
    if (fault === "reset") {
      call.fault = "reset";
      req.socket.destroy();
      return;
    }
    call.fault = String(fault.status);
    const retry = fault.status === 429 || fault.status === 503 ? { "retry-after": "1" } : undefined;
    this.#send(call, res, { status: fault.status, headers: retry, body: { error: "slicetest chaos", status: fault.status } });
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
    this.#chaos = undefined;
  }

  /**
   * Answer calls that no registered route matches, instead of failing with 501.
   * Return undefined to leave a call unanswered (it then fails the scenario as usual).
   * Kept across scenarios, unlike routes.
   */
  fallback(respond: ((call: RecordedCall) => StubResponse | undefined | Promise<StubResponse | undefined>) | undefined, hint?: string) {
    this.#fallback = respond;
    this.#hint = hint;
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
    // Faults only replace answers the stub would give: an unknown route still fails as unmatched.
    if (route || this.#fallback) {
      const fault = await this.#injectFault();
      if (fault) return this.#fail(call, req, res, fault);
    }
    if (!route) {
      let out: StubResponse | undefined;
      try {
        out = await this.#fallback?.(call);
      } catch (e) {
        res.writeHead(502, { "content-type": "text/plain" }).end((e as Error).message);
        return;
      }
      if (!out) {
        const hint = this.#hint ? ` (${this.#hint})` : "";
        res.writeHead(501, { "content-type": "text/plain" }).end(`slicetest: no stub for ${call.method} ${call.path}${hint}`);
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

/** A small seeded PRNG: the same seed gives the same faults on every run. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
