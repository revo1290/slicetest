import http from "node:http";
import type { AddressInfo } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { describeGraphQL, graphqlErrors, graphqlOf, type GraphQLCall } from "./graphql.js";
import { timeline } from "./timeline.js";

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** Parsed JSON body, or undefined when the body isn't JSON. */
  json: any;
  /**
   * Fields of an `application/x-www-form-urlencoded` body (Stripe, Twilio, OAuth token requests),
   * with bracket keys nested as the providers read them: `metadata[order]=7&items[0][price]=p_1`
   * is `{ metadata: { order: "7" }, items: [{ price: "p_1" }] }`. For `multipart/form-data`, the
   * fields with files as `{ filename, type, size, text }`. Undefined for other bodies.
   */
  form?: Record<string, unknown>;
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
  /** The GraphQL operation, when the call is a GraphQL request. */
  graphql?: GraphQLCall;
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
  /** Strings and bytes (`Uint8Array`, `ArrayBuffer`) are sent as they are; anything else as JSON. */
  body?: unknown;
}

/** One server-sent event: `[event, data]`, or `{ event, data, id }`. Data that isn't a string is sent as JSON. */
export type ServerSentEvent = [event: string, data: unknown] | { event?: string; data: unknown; id?: string };

/**
 * A streaming reply in Server-Sent Events format, as LLM APIs stream (Anthropic, OpenAI):
 * `stub("anthropic").on("POST", "/v1/messages").reply(sse([["message_start", {...}], ...]))`.
 */
export function sse(events: ServerSentEvent[], init: Omit<StubResponse, "body"> = {}): StubResponse {
  const body = events
    .map((e) => {
      const { event, data, id } = Array.isArray(e) ? { event: e[0], data: e[1], id: undefined } : e;
      const text = typeof data === "string" ? data : JSON.stringify(data);
      const lines = [...(id !== undefined ? [`id: ${id}`] : []), ...(event ? [`event: ${event}`] : []), ...text.split("\n").map((l) => `data: ${l}`)];
      return `${lines.join("\n")}\n\n`;
    })
    .join("");
  return { status: init.status ?? 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...init.headers }, body };
}

export type Responder = StubResponse | ((call: RecordedCall) => StubResponse | Promise<StubResponse>);

/**
 * Extra conditions a call must meet for a route to answer it. Plain values are
 * compared exactly (`json` as a subset); RegExps test strings; functions and
 * `expect.*` asymmetric matchers receive the actual value.
 */
export interface MatchOptions {
  /** A list matches a repeated parameter's values in order: `{ ids: ["1", "2"] }` for `?ids=1&ids=2`. */
  query?: Record<string, Matcher | Matcher[]>;
  headers?: Record<string, Matcher>;
  json?: unknown;
  /** Subset of a form-encoded body's fields (`call.form`). Numbers and booleans compare as the strings sent. */
  form?: Record<string, unknown>;
  body?: Matcher;
  /** A GraphQL request for this operation (its name, or a RegExp), with `variables` as a subset. */
  graphql?: { operation?: string | RegExp; variables?: unknown };
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
  /** Shown instead of `method path` in diagnostics. */
  label?: string;
  /** Not reported when never called. */
  optional?: boolean;
}

/** Builder returned by `stub.on()`. Finish it with `reply()` or `networkError()`. */
export interface RouteBuilder {
  /** Answer only the next `n` matching calls; later calls fall through to other routes. */
  times(n: number): RouteBuilder;
  once(): RouteBuilder;
  /** Wait before answering, e.g. to exercise the app's timeouts. */
  delay(ms: number): RouteBuilder;
  /** The app may or may not call this route: it isn't reported as unused (`strictStubs`). */
  optional(): RouteBuilder;
  reply(status: number, body?: unknown, headers?: Record<string, string>): Stub;
  reply(response: Responder): Stub;
  /** Answer each matching call with the next response in the list; the last one repeats. */
  replySequence(responses: StubResponse[]): Stub;
  /** Drop the connection without answering. */
  networkError(): Stub;
}

/** Builder returned by `stub.graphql()`: `reply()` as usual, or `data()` / `errors()` for a GraphQL answer. */
export interface GraphQLRouteBuilder extends RouteBuilder {
  times(n: number): GraphQLRouteBuilder;
  once(): GraphQLRouteBuilder;
  delay(ms: number): GraphQLRouteBuilder;
  optional(): GraphQLRouteBuilder;
  /** Answer `{ data }` (a function receives the call, with `call.graphql.variables`). */
  data(data: (call: RecordedCall) => unknown): Stub;
  data(data: unknown): Stub;
  /** Answer `{ errors, data }` with status 200, as GraphQL servers report resolver errors. */
  errors(errors: (string | { message: string; [k: string]: unknown })[], data?: unknown): Stub;
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
  /** Reply functions (and fallbacks) that threw: the app got a 500 / 502, the scenario must fail with the error. */
  #errors: { call: RecordedCall; error: unknown }[] = [];
  url = "";

  private constructor(readonly name: string) {
    this.#server = http.createServer((req, res) => {
      // An aborted request rejects while reading the body; don't let that crash the worker.
      this.#handle(req, res).catch(() => res.destroy());
    });
  }

  /** Serve a connection that arrived elsewhere, e.g. TLS the intercepting proxy terminated. */
  attach(socket: import("node:net").Socket) {
    this.#server.emit("connection", socket);
  }

  get port() {
    return Number(new URL(this.url).port);
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
   * A query in `path` (`/search?q=tea`) is a condition on those parameters; others may come along.
   */
  on(method: string, path: string | RegExp, match: MatchOptions = {}): RouteBuilder {
    return this.#on(method, path, match);
  }

  /**
   * Answer a GraphQL operation, whatever path the app posts it to:
   * `stub("github").graphql("CreateIssue", { variables: { title: "Bug" } }).data({ createIssue: { issue: { number: 1 } } })`.
   * The operation is `operationName`, or the name in the document when the client sends none.
   */
  graphql(operation: string | RegExp, match: Omit<MatchOptions, "graphql"> & { variables?: unknown; path?: string | RegExp } = {}): GraphQLRouteBuilder {
    const { variables, path, ...rest } = match;
    const builder = this.#on("*", path ?? /.*/, { ...rest, graphql: { operation, variables } }, `GraphQL ${operation}${path ? ` at ${path}` : ""}`);
    const gql: GraphQLRouteBuilder = {
      ...builder,
      times: (n) => (builder.times(n), gql),
      once: () => (builder.once(), gql),
      delay: (ms) => (builder.delay(ms), gql),
      optional: () => (builder.optional(), gql),
      data: (data: unknown) => builder.reply(async (call) => ({ status: 200, body: { data: typeof data === "function" ? await data(call) : data } })),
      errors: (errors, data) => builder.reply({ status: 200, body: { errors: graphqlErrors(errors), ...(data === undefined ? {} : { data }) } }),
    };
    return gql;
  }

  #on(method: string, fullPath: string | RegExp, fullMatch: MatchOptions, label?: string): RouteBuilder {
    const { path, match } = splitQuery(fullPath, fullMatch);
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
      label,
    };
    const add = (respond: Responder, extra: Partial<Route> = {}) => {
      this.#routes.unshift({ ...route, ...extra, respond });
      return this;
    };
    const builder: RouteBuilder = {
      times: (n) => ((route.remaining = n), builder),
      once: () => builder.times(1),
      delay: (ms) => ((route.delayMs = ms), builder),
      optional: () => ((route.optional = true), builder),
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
  calls(method?: string, fullPath?: string | RegExp, fullMatch: MatchOptions = {}): RecordedCall[] {
    const { path, match } = fullPath === undefined ? { path: undefined, match: fullMatch } : splitQuery(fullPath, fullMatch);
    const compiled = path === undefined ? undefined : compilePath(path);
    return this.#calls.filter(
      (c) =>
        (!method || method === "*" || c.method === method.toUpperCase()) &&
        (!compiled || matchPath(path!, compiled.pattern, c.path) !== undefined) &&
        matchConditions(match, c),
    );
  }

  /** Calls whose reply function or fallback threw, with the error; the app got a 500 (502 for a fallback). */
  handlerErrors() {
    return this.#errors;
  }

  unmatched() {
    return this.#calls.filter((c) => !c.matched);
  }

  /** Routes registered in this scenario that no call reached, except `optional()` ones. */
  unusedRoutes() {
    return this.#routes.filter((r) => r.hits === 0 && !r.optional).map((r) => r.label ?? `${r.method} ${r.path}`).reverse();
  }

  /** Human-readable list of registered routes, for diagnostics. */
  describeRoutes() {
    return this.#routes.map((r) => {
      const limit = Number.isFinite(r.remaining + r.hits) ? ` (${r.hits}/${r.remaining + r.hits} used)` : "";
      const keys = Object.keys(r.match).filter((k) => !(k === "graphql" && r.label));
      const cond = keys.length ? ` + ${keys.join("/")} conditions` : "";
      return `${r.label ?? `${r.method} ${r.path}`}${cond}${limit}`;
    });
  }

  /**
   * Why `call` wasn't answered, measured against the registered route it came closest to:
   * `closest route POST /v1/charges: json.amount: expected 100, got "100"`. Undefined without routes.
   */
  explain(call: RecordedCall): string | undefined {
    let best: { route: Route; reasons: string[]; score: number } | undefined;
    for (const route of this.#routes) {
      const reasons: string[] = [];
      let score = 0;
      if (route.method !== "*" && route.method !== call.method) {
        reasons.push(`method is ${call.method}, the route takes ${route.method}`);
        score += 1;
      }
      if (!matchPath(route.path, route.pattern, call.path, route.paramNames)) {
        reasons.push(pathHint(route.path, call.path));
        score += 2 + (typeof route.path === "string" ? Math.min(distance(route.path, call.path) / 4, 3) : 1);
      }
      const why = conditionMismatch(route.match, call);
      if (why) {
        reasons.push(why);
        score += 1;
      }
      if (reasons.length === 0 && route.remaining <= 0) {
        reasons.push(`the route already answered its ${route.hits} call(s) (once() / times())`);
        score += 0.5;
      }
      if (!best || score < best.score) best = { route, reasons, score };
    }
    if (!best) return undefined;
    const label = best.route.label ?? `${best.route.method} ${best.route.path}`;
    return `closest route ${label}: ${best.reasons.join("; ") || "matches now (registered after the call arrived?)"}`;
  }

  reset() {
    this.#routes = [];
    this.#calls = [];
    this.#chaos = undefined;
    this.#errors = [];
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
    const start = performance.now();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const body = raw.toString("utf8");
    const contentType = req.headers["content-type"] ?? "";
    const url = new URL(req.url ?? "/", this.url);
    const call: RecordedCall = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body,
      json: parseJson(body),
      form: isForm(contentType) ? parseForm(body) : /^multipart\/form-data/i.test(contentType) ? await parseMultipart(raw, contentType) : undefined,
      params: {},
      matched: false,
    };
    call.graphql = graphqlOf(call);
    timeline.set(call, { start });
    res.once("close", () => (timeline.get(call)!.end = performance.now()));
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
        this.#errors.push({ call, error: e });
        res.writeHead(502, { "content-type": "text/plain" }).end((e as Error).message);
        return;
      }
      if (!out) {
        const hint = this.#hint ? ` (${this.#hint})` : "";
        const what = call.graphql ? `${describeGraphQL(call.graphql)} (${call.method} ${call.path})` : `${call.method} ${call.path}`;
        res.writeHead(501, { "content-type": "text/plain" }).end(`slicetest: no stub for ${what}${hint}`);
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
      this.#errors.push({ call, error: e });
      res.writeHead(500).end(`slicetest: stub handler threw: ${e}`);
    }
  }

  #send(call: RecordedCall, res: http.ServerResponse, out: StubResponse) {
    if (out.body instanceof ArrayBuffer || (ArrayBuffer.isView(out.body) && !(out.body instanceof Uint8Array))) {
      const view = out.body as ArrayBuffer | ArrayBufferView;
      out = { ...out, body: view instanceof ArrayBuffer ? new Uint8Array(view) : new Uint8Array(view.buffer, view.byteOffset, view.byteLength) };
    }
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

/** `/search?q=tea` is the path `/search` with the query condition `q: "tea"`; `match.query` wins over the path's. */
function splitQuery(path: string | RegExp, match: MatchOptions) {
  if (typeof path !== "string" || !path.includes("?")) return { path, match };
  const [bare, search] = [path.slice(0, path.indexOf("?")), path.slice(path.indexOf("?") + 1)];
  const params = new URLSearchParams(search);
  const query: Record<string, Matcher | Matcher[]> = Object.fromEntries([...new Set(params.keys())].map((k) => [k, params.getAll(k).length > 1 ? params.getAll(k) : params.get(k)!]));
  return { path: bare || "/", match: { ...match, query: { ...query, ...match.query } } };
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
  names.forEach((n, i) => (params[n] = decodeSegment(m[i + 1]!)));
  return params;
}

/** A path segment decoded, or as sent when it isn't valid percent-encoding (`%zz`), instead of dropping the call. */
function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function matchConditions(match: MatchOptions, call: RecordedCall) {
  for (const [k, m] of Object.entries(match.query ?? {})) {
    if (!testQuery(m, call.query, k)) return false;
  }
  for (const [k, m] of Object.entries(match.headers ?? {})) {
    const v = call.headers[k.toLowerCase()];
    if (!test(m, Array.isArray(v) ? v.join(", ") : v)) return false;
  }
  if (match.body !== undefined && !test(match.body, call.body)) return false;
  if (match.json !== undefined && !subset(match.json, call.json)) return false;
  if (match.form !== undefined && !subset(formExpectation(match.form, call.form), call.form)) return false;
  if (match.graphql) {
    const g = call.graphql;
    if (!g) return false;
    const { operation, variables } = match.graphql;
    if (operation !== undefined && !(operation instanceof RegExp ? g.operation !== undefined && operation.test(g.operation) : g.operation === operation)) return false;
    if (variables !== undefined && !subset(variables, g.variables)) return false;
  }
  return true;
}

/** The first condition of `match` that `call` fails, described; undefined when it meets them all. */
function conditionMismatch(match: MatchOptions, call: RecordedCall): string | undefined {
  for (const [k, m] of Object.entries(match.query ?? {})) {
    if (testQuery(m, call.query, k)) continue;
    const all = call.query.getAll(k);
    const got = all.length === 0 ? "nothing" : Array.isArray(m) || all.length > 1 ? JSON.stringify(all) : JSON.stringify(all[0]);
    return `query ${k}: expected ${Array.isArray(m) ? `[${m.map(show).join(", ")}]` : show(m)}, got ${got}`;
  }
  for (const [k, m] of Object.entries(match.headers ?? {})) {
    const raw = call.headers[k.toLowerCase()];
    const v = Array.isArray(raw) ? raw.join(", ") : raw;
    if (!test(m, v)) return `header ${k.toLowerCase()}: expected ${show(m)}, got ${v === undefined ? "nothing" : JSON.stringify(v)}`;
  }
  if (match.body !== undefined && !test(match.body, call.body)) return `body: expected ${show(match.body)}, got ${JSON.stringify(call.body.slice(0, 100))}`;
  if (match.json !== undefined) {
    if (call.json === undefined) return `json: expected a JSON body, got ${call.body ? JSON.stringify(call.body.slice(0, 100)) : "an empty body"}`;
    const diff = difference(match.json, call.json, "json");
    if (diff) return diff;
  }
  if (match.form !== undefined) {
    if (call.form === undefined) return `form: expected a form-encoded body, got ${call.body ? `${call.headers["content-type"] ?? "no content type"}: ${JSON.stringify(call.body.slice(0, 100))}` : "an empty body"}`;
    const diff = difference(formExpectation(match.form, call.form), call.form, "form");
    if (diff) return diff;
  }
  if (match.graphql) {
    const g = call.graphql;
    if (!g) return "graphql: the call isn't a GraphQL request";
    const { operation, variables } = match.graphql;
    if (operation !== undefined && !(operation instanceof RegExp ? g.operation !== undefined && operation.test(g.operation) : g.operation === operation)) {
      return `graphql operation: expected ${show(operation)}, got ${g.operation ?? "an anonymous operation"}`;
    }
    if (variables !== undefined) {
      const diff = difference(variables, g.variables, "variables");
      if (diff) return diff;
    }
  }
  return undefined;
}

/** Where `actual` first stops containing `expected` (the rules of `subset`), as `json.items.0.sku: expected "a", got "b"`. */
function difference(expected: unknown, actual: unknown, at: string): string | undefined {
  if (subset(expected, actual)) return undefined;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return `${at}: expected ${expected.length} item(s), got ${actual.length}`;
    for (const [i, e] of expected.entries()) {
      const d = difference(e, actual[i], `${at}.${i}`);
      if (d) return d;
    }
  }
  if (expected && typeof expected === "object" && !Array.isArray(expected) && !isAsymmetric(expected) && !(expected instanceof RegExp) && actual && typeof actual === "object" && !Array.isArray(actual)) {
    for (const [k, v] of Object.entries(expected)) {
      if (!(k in actual)) return `${at}.${k}: expected ${show(v)}, got nothing`;
      const d = difference(v, (actual as Record<string, unknown>)[k], `${at}.${k}`);
      if (d) return d;
    }
  }
  return `${at}: expected ${show(expected)}, got ${short(actual)}`;
}

function show(m: unknown): string {
  if (isAsymmetric(m)) return (m as { toAsymmetricMatcher?: () => string }).toAsymmetricMatcher?.() ?? String(m);
  if (m instanceof RegExp) return String(m);
  if (typeof m === "function") return "a value the given function accepts";
  return short(m);
}

function short(v: unknown) {
  const s = v === undefined ? "nothing" : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

/** What is off about the path: a trailing slash, letter case, a prefix, or just a different path. */
function pathHint(expected: string | RegExp, actual: string) {
  if (typeof expected !== "string") return `path ${actual} doesn't match ${expected}`;
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  if (trim(expected) === trim(actual)) return `path is ${actual}, the route is ${expected} (trailing slash)`;
  if (expected.toLowerCase() === actual.toLowerCase()) return `path is ${actual}, the route is ${expected} (letter case)`;
  if (actual.endsWith(expected)) return `path is ${actual}, the route is ${expected}: is the base URL's path (${actual.slice(0, -expected.length)}) in the env value?`;
  if (expected.endsWith(actual)) return `path is ${actual}, the route is ${expected}: the base URL the app was given may lack ${expected.slice(0, -actual.length)}`;
  return `path is ${actual}, the route is ${expected}`;
}

/** Levenshtein distance, to find the route whose path is nearest. */
function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** A query condition: one matcher for the first value, or a list for every value of a repeated parameter, in order. */
function testQuery(m: Matcher | Matcher[], query: URLSearchParams, key: string) {
  if (!Array.isArray(m)) return test(m, query.get(key) ?? undefined);
  const values = query.getAll(key);
  return values.length === m.length && m.every((x, i) => test(x, values[i]));
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

function isForm(contentType: string | undefined) {
  return !!contentType && contentType.split(";")[0]!.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

/** Keys kept as plain fields rather than nested into, so a body can't reach `Object.prototype`. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * A form body as nested fields, the way Rack, PHP and Stripe read bracket keys: `a[b]=1` is
 * `{ a: { b: "1" } }`, `a[]=1&a[]=2` and `a[0]=1&a[1]=2` are arrays, and a plain key sent
 * twice (`to=1&to=2`) becomes an array too.
 */
export function parseForm(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const m = /^([^[\]]+)((?:\[[^\]]*\])*)$/.exec(key);
    const path = m?.[2] ? [m[1]!, ...[...m[2].matchAll(/\[([^\]]*)\]/g)].map((x) => x[1]!)] : undefined;
    // `__proto__[x]=1` is sent by whatever the app forwards; it must not reach Object.prototype.
    if (!path || path.some((seg) => UNSAFE_KEYS.has(seg))) {
      const prev = Object.hasOwn(out, key) ? out[key] : undefined;
      Object.defineProperty(out, key, { value: prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value], enumerable: true, writable: true, configurable: true });
      continue;
    }
    let node: Record<string, unknown> | unknown[] = out;
    for (let i = 0; i < path.length; i++) {
      const seg = path[i]!;
      const last = i === path.length - 1;
      const nextIsIndex = !last && (path[i + 1] === "" || /^\d+$/.test(path[i + 1]!));
      if (Array.isArray(node)) {
        const index = seg === "" ? node.length : Number(seg);
        if (last) node[index] = value;
        else node = (node[index] ??= nextIsIndex ? [] : {}) as Record<string, unknown> | unknown[];
      } else {
        if (last) node[seg] = value;
        else {
          const child = node[seg];
          node = (child && typeof child === "object" ? child : (node[seg] = nextIsIndex ? [] : {})) as Record<string, unknown> | unknown[];
        }
      }
    }
  }
  return out;
}

/**
 * Form values arrive as strings: compare `amount: 2000` and `capture: true` with what was sent.
 * Only where a string was sent, so an uploaded file's `size` stays a number.
 */
function formExpectation(expected: unknown, actual: unknown): unknown {
  if ((typeof expected === "number" || typeof expected === "boolean") && typeof actual === "string") return String(expected);
  if (Array.isArray(expected)) return expected.map((e, i) => formExpectation(e, Array.isArray(actual) ? actual[i] : undefined));
  if (expected && typeof expected === "object" && !isAsymmetric(expected) && !(expected instanceof RegExp)) {
    const at = (k: string) => (actual && typeof actual === "object" ? (actual as Record<string, unknown>)[k] : undefined);
    return Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, formExpectation(v, at(k))]));
  }
  return expected;
}

/** A file in a multipart body, as `call.form` shows it. `text` only for text, JSON, XML and CSV files. */
export interface UploadedFile {
  filename: string;
  type: string;
  size: number;
  text?: string;
}

const TEXTUAL = /^(text\/|application\/(json|xml|csv|x-ndjson|yaml|javascript)|[^;]*\+(json|xml))/i;

/** Fields of a `multipart/form-data` body, files as `{ filename, type, size, text }`. Undefined if it can't be parsed. */
async function parseMultipart(raw: Buffer, contentType: string): Promise<Record<string, unknown> | undefined> {
  let data: FormData;
  try {
    data = await new Response(new Uint8Array(raw), { headers: { "content-type": contentType } }).formData();
  } catch {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of data) {
    const v: unknown =
      typeof value === "string"
        ? value
        : ({
            filename: value.name,
            type: value.type,
            size: value.size,
            ...(TEXTUAL.test(value.type) ? { text: await value.text() } : {}),
          } satisfies UploadedFile);
    const prev = out[key];
    out[key] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
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
