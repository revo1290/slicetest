import { afterEach, beforeEach, expect, test } from "vitest";
import { Stub } from "../src/stub.js";
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
