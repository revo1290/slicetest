import { formRequest, type SubmitOptions } from "./form.js";
import { lookupHost } from "./intercept.js";
import { timeline } from "./timeline.js";
import { signWebhook, webhookBody, type WebhookOptions } from "./webhook.js";

export interface HttpResponse {
  method: string;
  url: string;
  status: number;
  headers: Headers;
  text: string;
  /** Parsed JSON body, or undefined when the body isn't JSON. */
  json: any;
  /** Wall-clock time of the request in milliseconds. */
  durationMs: number;
}

type QueryValue = string | number | boolean;

export interface RequestOptions {
  headers?: Record<string, string>;
  /** A list repeats the parameter: `{ tag: ["a", "b"] }` is `?tag=a&tag=b`. */
  query?: Record<string, QueryValue | QueryValue[] | undefined>;
  /** Follow redirects instead of returning the 3xx response. Default false. */
  follow?: boolean;
  /** Fail the request when the app hasn't answered within this many ms, naming it, instead of the whole test timing out. */
  timeout?: number;
}

/** Per-scenario state shared by a client and every client derived from it with `with()`. */
class Session {
  /** Stub base URLs of intercepted hosts, which redirects may lead to (an OAuth provider's login page). */
  external = new Map<string, string>();
  cookies = new Map<string, string>();
  /** The Path each cookie was set for; a cookie without one (added by hand) goes everywhere. */
  cookiePaths = new Map<string, string>();
  history: HttpResponse[] = [];
  listeners: ((res: HttpResponse) => void)[] = [];
}

const HISTORY = 20;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A redirected request that lost its body must not keep claiming a content type. */
function withoutContentType(headers: Record<string, string> | undefined, body: unknown) {
  if (body !== undefined || !headers) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== "content-type"));
}

/** HTTP client bound to the app under test. Keeps cookies for the duration of a scenario. */
export class HttpClient {
  #session: Session;

  constructor(
    readonly baseUrl: string,
    private readonly defaults: RequestOptions = {},
    session = new Session(),
  ) {
    this.#session = session;
  }

  /** A client that adds `opts` (e.g. an auth header) to every request, sharing this one's cookies. */
  with(opts: RequestOptions) {
    return new HttpClient(this.baseUrl, merge(this.defaults, opts), this.#session);
  }

  /** Wrap fields to be sent as `application/x-www-form-urlencoded`. */
  form(fields: Record<string, string | number | boolean>) {
    return new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)]));
  }

  get(path: string, opts?: RequestOptions) {
    return this.request("GET", path, undefined, opts);
  }
  head(path: string, opts?: RequestOptions) {
    return this.request("HEAD", path, undefined, opts);
  }
  delete(path: string, opts?: RequestOptions) {
    return this.request("DELETE", path, undefined, opts);
  }
  post(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request("POST", path, body, opts);
  }
  put(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request("PUT", path, body, opts);
  }
  patch(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request("PATCH", path, body, opts);
  }

  /**
   * Submit a form of `page` (a response from the app) as a browser with JavaScript off would:
   * hidden fields such as CSRF tokens or a Next.js server action's id are sent along,
   * plus the pressed button and the values you type.
   * `http.submit(await http.get("/signup"), { button: "Sign up", fields: { email: "a@b.test" } })`.
   */
  async submit(page: HttpResponse, opts: SubmitOptions & RequestOptions = {}): Promise<HttpResponse> {
    const { button, form, fields, ...request } = opts;
    let built: ReturnType<typeof formRequest>;
    try {
      built = formRequest(page.text, { button, form, fields });
    } catch (e) {
      // A redirect or an error page is the usual reason there is no such form.
      (e as Error).message += `\n(the page: ${page.method} ${page.url} → ${page.status}${REDIRECTS.has(page.status) ? `, a redirect to ${page.headers.get("location")}; request it with follow: true` : ""})`;
      throw e;
    }
    const { method, action, body } = built;
    const target = new URL(action, new URL(page.url, this.baseUrl));
    target.hash = "";
    return this.request(method, target.pathname + target.search, body, request);
  }

  /**
   * POST `payload` to the app as `provider` would deliver it, signed with `secret`:
   * `http.webhook("/webhooks/stripe", event, { provider: "stripe", secret: "whsec_test" })`.
   * `{ invalidSignature: true }` and `{ stale: true }` make deliveries the app must refuse.
   */
  webhook(path: string, payload: unknown, opts: WebhookOptions) {
    const { body, type } = webhookBody(payload);
    return this.request("POST", path, body, { headers: { "content-type": type, ...signWebhook(body, opts), ...opts.headers } });
  }

  /**
   * Send a GraphQL operation to the app: `http.graphql("query { poll(id: 1) { title } }")`,
   * `http.graphql(CREATE_POLL, { title: "Tea?" })`. Posts `{ query, variables, operationName }` to
   * `/graphql` (`path` for another endpoint). Pair with `toHaveGraphQLData()`, since GraphQL
   * servers answer errors with status 200.
   */
  graphql(query: string, variables?: Record<string, unknown>, opts: RequestOptions & { path?: string; operationName?: string } = {}) {
    const { path = "/graphql", operationName, ...request } = opts;
    return this.request("POST", path, { query, ...(variables ? { variables } : {}), ...(operationName ? { operationName } : {}) }, request);
  }

  /**
   * Run `send` `n` times at once and wait for every response, to provoke races
   * (double bookings, lost updates). Pair with `toHaveStatuses({ 201: 1, 409: n - 1 })`
   * and a check of the database. Requests are released together once all are prepared.
   */
  async concurrently(n: number, send: (i: number) => Promise<HttpResponse>): Promise<HttpResponse[]> {
    if (!Number.isInteger(n) || n < 1) throw new Error(`slicetest: concurrently() needs a positive number of requests, got ${n}`);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const all = Promise.all(Array.from({ length: n }, (_, i) => gate.then(() => send(i))));
    release();
    return all;
  }

  /**
   * Strings, URLSearchParams, FormData, Blob and byte arrays are sent as-is; anything else is sent as JSON.
   * With `follow`, redirects are followed here rather than by fetch, so cookies set along the way are kept
   * (a login answering 302 + Set-Cookie) and nothing is sent outside the app: a redirect elsewhere is returned.
   */
  async request(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<HttpResponse> {
    const opts = merge(this.defaults, options);
    let url = new URL(path, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new Error(`slicetest: http only talks to the app under test; "${path}" resolves to ${url.origin}`);
    }
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        url.searchParams.delete(k);
        for (const item of v) url.searchParams.append(k, String(item));
      } else url.searchParams.set(k, String(v));
    }

    let res = await this.#send(method, url, body, opts);
    for (let hops = 0; opts.follow && REDIRECTS.has(res.status) && hops < 20; hops++) {
      const location = res.headers.get("location");
      if (!location) break;
      const next = new URL(location, url);
      // Like a browser: on to the app, or to a host a stub stands in for; anywhere else is returned.
      if (next.origin !== new URL(this.baseUrl).origin && lookupHost(this.#session.external, next.hostname) === undefined) break;
      // 307/308 repeat the request as it was; the others turn it into a GET without a body, like browsers do.
      if (res.status !== 307 && res.status !== 308 && method !== "HEAD") {
        method = "GET";
        body = undefined;
      }
      url = next;
      res = await this.#send(method, url, body, { ...opts, headers: withoutContentType(opts.headers, body) });
    }
    return res;
  }

  async #send(method: string, url: URL, body: unknown, opts: RequestOptions): Promise<HttpResponse> {
    const headers = new Headers(opts.headers);
    const stub = url.origin === new URL(this.baseUrl).origin ? undefined : lookupHost(this.#session.external, url.hostname);
    // The app's cookies stay with the app; the stub is reached at its own address.
    const target = stub ? new URL(url.pathname + url.search, stub) : url;
    if (!stub && !headers.has("cookie")) {
      const cookie = this.#cookieHeader(url.pathname);
      if (cookie) headers.set("cookie", cookie);
    }
    let payload: BodyInit | undefined;
    if (
      body === undefined ||
      typeof body === "string" ||
      body instanceof URLSearchParams ||
      body instanceof FormData ||
      body instanceof Blob ||
      body instanceof Uint8Array
    ) {
      payload = body as BodyInit | undefined;
    } else {
      payload = JSON.stringify(body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }

    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(target, { method, headers, body: payload, redirect: "manual", signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined });
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      const failed: HttpResponse = { method, url: url.pathname + url.search, status: 0, headers: new Headers(), text: `${e}${cause ? ` (${cause})` : ""}`, json: undefined, durationMs: Math.round(performance.now() - started) };
      timeline.set(failed, { start: started, end: performance.now() });
      this.#record(failed);
      throw new Error(`slicetest: ${method} ${failed.url}: ${requestFailure(e, cause, opts.timeout)}`, { cause: e });
    }
    if (!stub) for (const cookie of res.headers.getSetCookie()) this.#storeCookie(cookie, url.pathname);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {}
    const out: HttpResponse = {
      method,
      url: stub ? url.href : url.pathname + url.search,
      status: res.status,
      headers: res.headers,
      text,
      json,
      durationMs: Math.round(performance.now() - started),
    };
    timeline.set(out, { start: started, end: performance.now() });
    this.#record(out);
    // Listeners (contract checks, coverage) are about the app's responses only.
    if (!stub) for (const listener of this.#session.listeners) listener(out);
    return out;
  }

  /** Call `fn` with every response this client (or one derived with `with()`) receives. */
  onResponse(fn: (res: HttpResponse) => void) {
    this.#session.listeners.push(fn);
  }

  #record(res: HttpResponse) {
    this.#session.history.push(res);
    if (this.#session.history.length > HISTORY) this.#session.history.shift();
  }

  /** Let redirects to `host` continue to the stub at `stubUrl`, as they would to the real host in a browser. */
  intercept(host: string, stubUrl: string) {
    this.#session.external.set(host.toLowerCase(), stubUrl);
  }

  /** Cookies the app has set during this scenario. Mutations are sent with later requests. */
  get cookies() {
    return this.#session.cookies;
  }

  clearCookies() {
    this.#session.cookies.clear();
    this.#session.cookiePaths.clear();
  }

  /** Requests made during the current scenario, oldest first (last 20). */
  get history(): readonly HttpResponse[] {
    return this.#session.history;
  }

  /** Start a new scenario: forget cookies and history. */
  reset() {
    this.clearCookies();
    this.#session.history = [];
  }

  /** Cookies whose Path covers `requestPath`, longest Path first as browsers send them (RFC 6265 5.4). */
  #cookieHeader(requestPath: string) {
    const { cookies, cookiePaths } = this.#session;
    return [...cookies]
      .map(([name, value]) => ({ name, value, path: cookiePaths.get(name) ?? "/" }))
      .filter((c) => pathMatches(requestPath, c.path))
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  #storeCookie(header: string, requestPath: string) {
    const [pair, ...attrs] = header.split(";");
    const eq = pair!.indexOf("=");
    if (eq <= 0) return;
    const name = pair!.slice(0, eq).trim();
    let maxAge: number | undefined;
    let expires: number | undefined;
    let cookiePath: string | undefined;
    for (const a of attrs) {
      const i = a.indexOf("=");
      const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? "" : a.slice(i + 1).trim();
      if (k === "max-age") maxAge = Number(v);
      else if (k === "expires") expires = Date.parse(v);
      else if (k === "path" && v.startsWith("/")) cookiePath = v;
    }
    // Max-Age wins over Expires whichever comes first.
    const expired = maxAge !== undefined && !Number.isNaN(maxAge) ? maxAge <= 0 : expires !== undefined && expires <= Date.now();
    // Keyed by name alone: a second cookie of the same name under another Path replaces the first.
    if (expired) {
      this.#session.cookies.delete(name);
      this.#session.cookiePaths.delete(name);
    } else {
      this.#session.cookies.set(name, pair!.slice(eq + 1).trim());
      this.#session.cookiePaths.set(name, cookiePath ?? defaultCookiePath(requestPath));
    }
  }
}

/** RFC 6265 5.1.4: the request path's directory, e.g. "/auth" for "/auth/login". */
function defaultCookiePath(requestPath: string) {
  const slash = requestPath.lastIndexOf("/");
  return slash <= 0 ? "/" : requestPath.slice(0, slash);
}

/** RFC 6265 5.1.4: "/api" covers "/api" and "/api/x" but not "/apix". */
function pathMatches(requestPath: string, cookiePath: string) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

/** Why a request got no response, in terms of what to look at. */
function requestFailure(e: unknown, code: string | undefined, timeout: number | undefined) {
  if ((e as Error).name === "TimeoutError") return `no response within ${timeout}ms (http timeout); the app may be waiting on a stub with a delay, a lock or a slow query`;
  if (code === "ECONNREFUSED") return "connection refused: the app isn't listening (it may have crashed; its output is below)";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "the app closed the connection without answering (did it crash or exit?)";
  return `${(e as Error).message}${code ? ` (${code})` : ""}`;
}

function merge(a: RequestOptions, b: RequestOptions): RequestOptions {
  return {
    ...a,
    ...b,
    headers: { ...a.headers, ...b.headers },
    query: { ...a.query, ...b.query },
  };
}

/** One line per request, for failure output. */
export function formatHistory(history: readonly HttpResponse[]) {
  return history
    .map((r) => {
      const snippet = r.text.length > 120 ? `${r.text.slice(0, 120)}…` : r.text;
      return `  ${r.method} ${r.url} → ${r.status || "failed"} (${r.durationMs}ms)${snippet ? `  ${snippet.replace(/\s+/g, " ")}` : ""}`;
    })
    .join("\n");
}
