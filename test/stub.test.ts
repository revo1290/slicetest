import http from "node:http";
import { afterEach, beforeEach, expect, test } from "vitest";
import { sse, Stub } from "../src/stub.js";
import "../src/matchers.js";

let stub: Stub;
beforeEach(async () => (stub = await Stub.start("svc")));
afterEach(() => stub.close());

test("replies with JSON and records the call", async () => {
  stub.on("POST", "/users").reply(201, { id: 7 });

  const res = await fetch(`${stub.url}/users?dry=1`, { method: "POST", body: JSON.stringify({ name: "a" }) });

  expect(res.status).toBe(201);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(await res.json()).toEqual({ id: 7 });
  const [call] = stub.calls("POST", "/users");
  expect(call).toMatchObject({ method: "POST", path: "/users", json: { name: "a" }, matched: true });
  expect(call!.query.get("dry")).toBe("1");
});

test("later routes win, and RegExp paths and * methods match", async () => {
  stub.on("*", /^\/items\/\d+$/).reply(200, "first");
  stub.on("GET", /^\/items\/\d+$/).reply(200, "second");

  expect(await (await fetch(`${stub.url}/items/3`)).text()).toBe("second");
  expect(await (await fetch(`${stub.url}/items/3`, { method: "DELETE" })).text()).toBe("first");
});

test("a function responder sees the call", async () => {
  stub.on("POST", "/echo").reply((call) => ({ status: 200, body: { got: call.json } }));

  const res = await fetch(`${stub.url}/echo`, { method: "POST", body: '{"x":1}' });

  expect(await res.json()).toEqual({ got: { x: 1 } });
});

test("unmatched calls get 501 and are reported; reset clears everything", async () => {
  const res = await fetch(`${stub.url}/nope`);

  expect(res.status).toBe(501);
  expect(stub.unmatched().map((c) => c.path)).toEqual(["/nope"]);
  stub.reset();
  expect(stub.calls()).toEqual([]);
});

test(":name segments capture params, and calls() accepts the same pattern", async () => {
  stub.on("GET", "/repos/:owner/:repo").reply((call) => ({ body: call.params }));

  const res = await fetch(`${stub.url}/repos/acme/a%20b`);

  expect(await res.json()).toEqual({ owner: "acme", repo: "a b" });
  expect(stub.calls("GET", "/repos/:owner/:repo")).toHaveLength(1);
  expect(stub.calls("GET", "/repos/:owner")).toHaveLength(0);
});

test("query, header and JSON conditions pick the route", async () => {
  stub.on("POST", "/charge").reply(400, { error: "fallback" });
  stub
    .on("POST", "/charge", {
      query: { expand: "customer" },
      headers: { Authorization: /^Bearer / },
      json: { amount: expect.any(Number), currency: "jpy" },
    })
    .reply(200, { id: "ch_1" });
  const send = (qs: string, auth: string, body: unknown) =>
    fetch(`${stub.url}/charge${qs}`, { method: "POST", headers: { authorization: auth }, body: JSON.stringify(body) });

  expect((await send("?expand=customer", "Bearer t", { amount: 10, currency: "jpy", extra: 1 })).status).toBe(200);
  expect((await send("", "Bearer t", { amount: 10, currency: "jpy" })).status).toBe(400);
  expect((await send("?expand=customer", "Basic x", { amount: 10, currency: "jpy" })).status).toBe(400);
  expect((await send("?expand=customer", "Bearer t", { amount: "10", currency: "jpy" })).status).toBe(400);
  expect(stub.calls("POST", "/charge", { json: { amount: 10 } })).toHaveLength(3);
});

test("once() answers one call and then falls through; replySequence() repeats its last answer", async () => {
  stub.on("GET", "/flaky").reply(200, "ok");
  stub.on("GET", "/flaky").once().reply(503);
  stub.on("GET", "/seq").replySequence([{ status: 500 }, { status: 201 }]);

  const statuses = async (p: string, n: number) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await fetch(`${stub.url}${p}`)).status);
    return out;
  };
  expect(await statuses("/flaky", 3)).toEqual([503, 200, 200]);
  expect(await statuses("/seq", 3)).toEqual([500, 201, 201]);
});

test("delay() holds the answer and networkError() drops the connection", async () => {
  stub.on("GET", "/slow").delay(150).reply(200);
  stub.on("GET", "/down").networkError();

  await expect(fetch(`${stub.url}/slow`, { signal: AbortSignal.timeout(50) })).rejects.toThrow();
  await expect(fetch(`${stub.url}/down`)).rejects.toThrow();
  expect(stub.calls("GET", "/down")[0]?.matched).toBe(true);
});

test("describeRoutes() lists routes for diagnostics", () => {
  stub.on("POST", "/a", { json: { x: 1 } }).times(2).reply(200);
  stub.on("GET", /^\/b/).reply(200);

  expect(stub.describeRoutes()).toEqual(["GET /^\\/b/", "POST /a + json conditions (0/2 used)"]);
});

test("multi-byte bodies survive chunking, and Buffer replies are sent raw", async () => {
  stub.on("POST", "/echo").reply((call) => ({ body: Buffer.from(call.body) }));
  const text = "あ".repeat(50_000);

  const res = await fetch(`${stub.url}/echo`, { method: "POST", body: text });

  expect(res.headers.get("content-type")).toBeNull();
  expect(await res.text()).toBe(text);
});

test("stub matchers report the calls that were received", async () => {
  stub.on("POST", "/hook").reply(200);
  await fetch(`${stub.url}/hook`, { method: "POST", body: '{"text":"hi"}' });

  expect(stub).toHaveReceived("POST", "/hook", { json: { text: "hi" } });
  expect(stub).toHaveReceivedTimes(1, "POST", "/hook");
  expect(stub).not.toHaveReceived("GET", "/hook");
  expect(() => expect(stub).toHaveReceived("POST", "/hook", { json: { text: "bye" } })).toThrow(
    /to have received POST \/hook with[\s\S]*Calls received:\n {2}POST \/hook {2}\{"text":"hi"\}/,
  );
});

test("chaos failFirst fails the first calls without using up a once() route", async () => {
  stub.on("POST", "/charge").once().reply(201, { id: "ch_1" });
  stub.chaos({ failFirst: 2, statuses: [503] });

  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await fetch(`${stub.url}/charge`, { method: "POST" })).status);

  expect(statuses).toEqual([503, 503, 201]);
  expect(stub.faults().map((c) => c.fault)).toEqual(["503", "503"]);
  expect(stub.calls("POST", "/charge")[0]!.response?.headers["retry-after"]).toBe("1");
});

test("chaos with a seed injects the same faults on every run, and reports the seed", async () => {
  const run = async () => {
    stub.reset();
    stub.on("GET", "/x").reply(200);
    stub.chaos({ errorRate: 0.5, seed: 42 });
    const out = [];
    for (let i = 0; i < 12; i++) out.push((await fetch(`${stub.url}/x`)).status);
    return out;
  };
  const first = await run();
  expect(await run()).toEqual(first);
  expect(first).toContain(200);
  expect(first.some((s) => s >= 500)).toBe(true);
  expect(stub.describeChaos()).toMatch(/chaos on svc: errorRate 0\.5; \d+ of 12 calls faulted\. Replay with SLICETEST_CHAOS_SEED=42/);
});

test("chaos networkErrorRate drops connections; unknown routes still fail as unmatched", async () => {
  stub.on("GET", "/x").reply(200);
  stub.chaos({ networkErrorRate: 1 });
  await expect(fetch(`${stub.url}/x`)).rejects.toThrow();
  expect((await fetch(`${stub.url}/nope`)).status).toBe(501);
  expect(stub.unmatched()).toHaveLength(1);
  expect(() => stub.chaos({ errorRate: 2 })).toThrow("between 0 and 1");
});

test("chaos latency delays every call, and reset() turns chaos off", async () => {
  stub.on("GET", "/x").reply(200);
  stub.chaos({ latency: 80 });
  const started = performance.now();
  await fetch(`${stub.url}/x`);
  expect(performance.now() - started).toBeGreaterThanOrEqual(75);
  stub.reset();
  expect(stub.describeChaos()).toBeUndefined();
});

test("sse() replies with a Server-Sent Events stream: event lines, JSON data, multi-line data, ids", async () => {
  stub.on("POST", "/v1/messages").reply(sse([["message_start", { type: "message_start" }], { data: "line 1\nline 2", id: "7" }, ["ping", "{}"]]));

  const res = await fetch(`${stub.url}/v1/messages`, { method: "POST" });

  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(await res.text()).toBe('event: message_start\ndata: {"type":"message_start"}\n\nid: 7\ndata: line 1\ndata: line 2\n\nevent: ping\ndata: {}\n\n');
});

test("explain() names the closest route and what kept it from answering", async () => {
  stub.on("GET", "/v1/customers/:id").reply(200);
  stub.on("POST", "/v1/charges", { json: { amount: 100, items: [{ sku: "a" }] }, headers: { authorization: /^Bearer / } }).reply(201);
  const post = (path: string, body: unknown, headers: Record<string, string> = { authorization: "Bearer x" }) =>
    fetch(`${stub.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  await post("/v1/charges", { amount: "100", items: [{ sku: "a" }] });
  await post("/v1/charges", { amount: 100, items: [{ sku: "b" }] });
  await post("/v1/charges", { amount: 100, items: [{ sku: "a" }] }, {});
  await post("/v1/charges/", { amount: 100, items: [{ sku: "a" }] });
  await post("/api/v1/charges", { amount: 100, items: [{ sku: "a" }] });
  await fetch(`${stub.url}/v1/charges`);

  expect(stub.unmatched().map((c) => stub.explain(c))).toEqual([
    'closest route POST /v1/charges: json.amount: expected 100, got "100"',
    'closest route POST /v1/charges: json.items.0.sku: expected "a", got "b"',
    "closest route POST /v1/charges: header authorization: expected /^Bearer /, got nothing",
    "closest route POST /v1/charges: path is /v1/charges/, the route is /v1/charges (trailing slash)",
    "closest route POST /v1/charges: path is /api/v1/charges, the route is /v1/charges: is the base URL's path (/api) in the env value?",
    "closest route POST /v1/charges: method is GET, the route takes POST; header authorization: expected /^Bearer /, got nothing",
  ]);
});

test("explain() says when a once() route was used up", async () => {
  stub.on("GET", "/token").once().reply(200);
  await fetch(`${stub.url}/token`);
  await fetch(`${stub.url}/token`);
  expect(stub.explain(stub.unmatched()[0]!)).toBe("closest route GET /token: the route already answered its 1 call(s) (once() / times())");
});

test("form-encoded bodies are parsed with nested bracket keys and matched with form", async () => {
  stub.on("POST", "/v1/payment_intents", { form: { amount: 2000, metadata: { order: "7" }, capture: true } }).reply(200, { id: "pi_1" });
  const post = (body: string) =>
    fetch(`${stub.url}/v1/payment_intents`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, body });

  const ok = await post("amount=2000&currency=jpy&capture=true&metadata[order]=7&items[0][price]=p_1&items[1][price]=p_2&expand[]=customer&to=a&to=b");
  const wrong = await post("amount=1999&metadata[order]=7&capture=true");

  expect(ok.status).toBe(200);
  expect(wrong.status).toBe(501);
  expect(stub.calls()[0]!.form).toEqual({
    amount: "2000",
    currency: "jpy",
    capture: "true",
    metadata: { order: "7" },
    items: [{ price: "p_1" }, { price: "p_2" }],
    expand: ["customer"],
    to: ["a", "b"],
  });
  expect(stub.explain(stub.unmatched()[0]!)).toBe('closest route POST /v1/payment_intents: form.amount: expected "2000", got "1999"');
  expect(stub).toHaveReceived("POST", "/v1/payment_intents", { form: { items: [{ price: "p_1" }, { price: expect.stringMatching(/^p_/) }] } });
});

test("form conditions explain a body that isn't form-encoded", async () => {
  stub.on("POST", "/token", { form: { grant_type: "client_credentials" } }).reply(200, {});

  await fetch(`${stub.url}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"grant_type":"client_credentials"}' });

  expect(stub.calls()[0]!.form).toBeUndefined();
  expect(stub.explain(stub.unmatched()[0]!)).toBe('closest route POST /token: form: expected a form-encoded body, got application/json: "{\\"grant_type\\":\\"client_credentials\\"}"');
});

test("a param with invalid percent-encoding is passed as sent instead of dropping the call", async () => {
  stub.on("GET", "/files/:name").reply((call) => ({ body: call.params }));

  const res = await fetch(`${stub.url}/files/100%zz`);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ name: "100%zz" });
});

test("multipart bodies are read into form, with files as filename, type, size and text", async () => {
  stub.on("POST", "/files", { form: { kind: "avatar", file: { filename: "a.png", size: 3 } } }).reply(201);
  const send = (size: number) => {
    const body = new FormData();
    body.append("kind", "avatar");
    body.append("file", new Blob([new Uint8Array(size)], { type: "image/png" }), "a.png");
    body.append("notes", new Blob(['{"a":1}'], { type: "application/json" }), "n.json");
    return fetch(`${stub.url}/files`, { method: "POST", body });
  };

  expect((await send(3)).status).toBe(201);
  expect((await send(4)).status).toBe(501);
  expect(stub.calls()[0]!.form).toEqual({
    kind: "avatar",
    file: { filename: "a.png", type: "image/png", size: 3 },
    notes: { filename: "n.json", type: "application/json", size: 7, text: '{"a":1}' },
  });
  expect(stub.explain(stub.unmatched()[0]!)).toBe("closest route POST /files: form.file.size: expected 3, got 4");
});

test("form bodies with __proto__ or constructor keys stay plain fields and leave Object.prototype alone", async () => {
  const { parseForm } = await import("../src/stub.js");

  const form = parseForm("__proto__[polluted]=1&constructor[prototype][p2]=2&a[b]=3");

  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(({} as Record<string, unknown>).p2).toBeUndefined();
  expect(form["__proto__[polluted]"]).toBe("1");
  expect(form["constructor[prototype][p2]"]).toBe("2");
  expect(form.a).toEqual({ b: "3" });
});

test("replies with an ArrayBuffer or DataView body send the bytes", async () => {
  const bytes = new TextEncoder().encode("%PDF");
  stub.on("GET", "/a").reply(200, bytes.buffer, { "content-type": "application/pdf" });
  stub.on("GET", "/d").reply(200, new DataView(bytes.buffer, 1, 2));

  expect(await (await fetch(`${stub.url}/a`)).text()).toBe("%PDF");
  const d = await fetch(`${stub.url}/d`);
  expect(await d.text()).toBe("PD");
  expect(d.headers.get("content-type")).toBeNull();
});

test("a query in a route's path is a condition on those parameters, also for calls()", async () => {
  stub.on("GET", "/search?q=tea&page=2").reply(200, { hits: 1 });
  stub.on("GET", "/users/:id?expand=org", { query: { expand: "team" } }).reply(200, { team: true });

  expect((await fetch(`${stub.url}/search?page=2&q=tea&lang=ja`)).status).toBe(200);
  expect((await fetch(`${stub.url}/search?q=coffee&page=2`)).status).toBe(501);
  expect(await (await fetch(`${stub.url}/users/7?expand=team`)).json()).toEqual({ team: true });
  expect(stub.calls("GET", "/search?q=tea")).toHaveLength(1);
  expect(stub).toHaveReceived("GET", "/users/:id?expand=team");
  expect(stub.explain(stub.unmatched()[0]!)).toContain('query q: expected "tea", got "coffee"');
});

test("a list in a query condition matches a repeated parameter's values in order", async () => {
  stub.on("GET", "/items", { query: { ids: ["1", /^\d+$/] } }).reply(200, { ok: 1 });
  stub.on("GET", "/tags?t=a&t=b").reply(200, { ok: 2 });

  expect((await fetch(`${stub.url}/items?ids=1&ids=22`)).status).toBe(200);
  expect((await fetch(`${stub.url}/items?ids=1`)).status).toBe(501);
  expect((await fetch(`${stub.url}/tags?t=a&t=b`)).status).toBe(200);
  expect((await fetch(`${stub.url}/tags?t=b&t=a`)).status).toBe(501);
  expect(stub.calls("GET", "/items", { query: { ids: ["1", "22"] } })).toHaveLength(1);
  expect(stub.explain(stub.unmatched()[0]!)).toContain('query ids: expected ["1", /^\\d+$/], got ["1"]');
});

test("a reply function that throws answers 500 and is kept for the scenario's failure", async () => {
  stub.on("POST", "/charge").reply(() => {
    throw new TypeError("Cannot read properties of undefined (reading 'amount')");
  });

  expect((await fetch(`${stub.url}/charge`, { method: "POST" })).status).toBe(500);
  expect(stub.handlerErrors().map((e) => [e.call.path, (e.error as Error).message])).toEqual([["/charge", "Cannot read properties of undefined (reading 'amount')"]]);
  stub.reset();
  expect(stub.handlerErrors()).toEqual([]);
});

test("a path starting with // (a base URL's trailing slash plus a leading one) is recorded as sent", async () => {
  stub.on("GET", "/users/:id").reply(200, "ok");

  const res = await new Promise<number>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: stub.port, path: "//users/42" }, (r) => (r.resume(), resolve(r.statusCode!)));
    req.end();
  });

  expect(res).toBe(501);
  expect(stub.unmatched().map((c) => c.path)).toEqual(["//users/42"]);
});

test("a route path with spaces or non-ASCII characters matches the percent-encoded request", async () => {
  stub.on("GET", "/検索/:word").reply(200, "found");
  stub.on("POST", "/a b").reply(200, "space");

  expect(await (await fetch(`${stub.url}/${encodeURIComponent("検索")}/x`)).text()).toBe("found");
  expect(await (await fetch(`${stub.url}/a%20b`, { method: "POST" })).text()).toBe("space");
  expect(stub.calls("GET", "/検索/:word")).toHaveLength(1);
  expect(stub.calls("POST", "/a b")).toHaveLength(1);
});

test("a * segment matches the rest of the path, slashes included, and is captured as params['*']", async () => {
  stub.on("PUT", "/bucket/*").reply(200, "stored");
  stub.on("GET", "/v1/*/items").reply((call) => ({ status: 200, body: { scope: call.params["*"] } }));

  expect(await (await fetch(`${stub.url}/bucket/photos/2026/a%20b.png`, { method: "PUT" })).text()).toBe("stored");
  expect((await (await fetch(`${stub.url}/v1/org/7/items`)).json()).scope).toBe("org/7");
  expect(stub.calls("PUT", "/bucket/*")[0]!.params["*"]).toBe("photos/2026/a b.png");
  expect((await fetch(`${stub.url}/bucket/`, { method: "PUT" })).status).toBe(501);
  expect(stub.calls("PUT", "/bucket/*")).toHaveLength(1);
});

test("multipart fields named like Object's own properties are read as sent", async () => {
  stub.on("POST", "/files").reply(201);
  const body = new FormData();
  body.append("constructor", "a");
  body.append("toString", "b");
  body.append("__proto__", new Blob(["x"], { type: "text/plain" }), "p.txt");
  await fetch(`${stub.url}/files`, { method: "POST", body });

  const form = stub.calls()[0]!.form!;
  expect(Object.keys(form)).toEqual(["constructor", "toString", "__proto__"]);
  expect(form.constructor).toBe("a");
  expect(form.toString).toBe("b");
  expect(Object.getOwnPropertyDescriptor(form, "__proto__")?.value).toEqual({ filename: "p.txt", type: "text/plain", size: 1, text: "x" });
  expect(Object.getPrototypeOf(form)).toBe(Object.prototype);
});
