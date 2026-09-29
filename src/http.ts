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

export interface RequestOptions {
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** Follow redirects instead of returning the 3xx response. Default false. */
  follow?: boolean;
}

/** Per-scenario state shared by a client and every client derived from it with `with()`. */
class Session {
  cookies = new Map<string, string>();
  history: HttpResponse[] = [];
}

const HISTORY = 20;

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

  /** Strings, URLSearchParams, FormData, Blob and byte arrays are sent as-is; anything else is sent as JSON. */
  async request(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<HttpResponse> {
    const opts = merge(this.defaults, options);
    const url = new URL(path, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new Error(`slicetest: http only talks to the app under test; "${path}" resolves to ${url.origin}`);
    }
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const headers = new Headers(opts.headers);
    if (this.#session.cookies.size > 0 && !headers.has("cookie")) {
      headers.set("cookie", [...this.#session.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
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
      res = await fetch(url, { method, headers, body: payload, redirect: opts.follow ? "follow" : "manual" });
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      this.#record({ method, url: url.pathname + url.search, status: 0, headers: new Headers(), text: `${e}${cause ? ` (${cause})` : ""}`, json: undefined, durationMs: Math.round(performance.now() - started) });
      throw e;
    }
    for (const cookie of res.headers.getSetCookie()) this.#storeCookie(cookie);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {}
    const out: HttpResponse = {
      method,
      url: url.pathname + url.search,
      status: res.status,
      headers: res.headers,
      text,
      json,
      durationMs: Math.round(performance.now() - started),
    };
    this.#record(out);
    return out;
  }

  #record(res: HttpResponse) {
    this.#session.history.push(res);
    if (this.#session.history.length > HISTORY) this.#session.history.shift();
  }

  /** Cookies the app has set during this scenario. Mutations are sent with later requests. */
  get cookies() {
    return this.#session.cookies;
  }

  clearCookies() {
    this.#session.cookies.clear();
  }

  /** Requests made during the current scenario, oldest first (last 20). */
  get history(): readonly HttpResponse[] {
    return this.#session.history;
  }

  /** Start a new scenario: forget cookies and history. */
  reset() {
    this.#session.cookies.clear();
    this.#session.history = [];
  }

  #storeCookie(header: string) {
    const [pair, ...attrs] = header.split(";");
    const eq = pair!.indexOf("=");
    if (eq <= 0) return;
    const name = pair!.slice(0, eq).trim();
    const expired = attrs.some((a) => {
      const [k, v = ""] = a.split("=").map((s) => s.trim());
      if (k!.toLowerCase() === "max-age") return Number(v) <= 0;
      if (k!.toLowerCase() === "expires") return Date.parse(v) <= Date.now();
      return false;
    });
    if (expired) this.#session.cookies.delete(name);
    else this.#session.cookies.set(name, pair!.slice(eq + 1).trim());
  }
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
