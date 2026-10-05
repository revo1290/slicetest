import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { HttpClient } from "../src/http.js";
import "../src/matchers.js";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url?.startsWith("/login")) return res.writeHead(204, { "set-cookie": "sid=abc; Path=/; HttpOnly" }).end();
    if (req.url === "/session") return res.writeHead(303, { location: "/me", "set-cookie": "sid=xyz; Path=/" }).end();
    if (req.url === "/keep") return res.writeHead(307, { location: "/echo" }).end();
    if (req.url === "/moved") return res.writeHead(301, { location: "/whoami" }).end();
    if (req.url === "/found") return res.writeHead(302, { location: "/whoami" }).end();
    if (req.url === "/whoami") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ method: req.method, body }));
    if (req.url === "/away") return res.writeHead(302, { location: "https://example.com/" }).end();
    if (req.url === "/auth/token") return res.writeHead(204, { "set-cookie": ["refresh=r1; Path=/auth/refresh; HttpOnly", "csrf=c1"] }).end();
    if (req.url === "/secure-login") return res.writeHead(204, { "set-cookie": ["sid=s3cr3t; Path=/; HttpOnly; Secure; SameSite=lax; Max-Age=3600", "theme=dark"] }).end();
    if (req.url === "/stale") return res.writeHead(204, { "set-cookie": "late=1; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT" }).end();
    if (req.url === "/endless") return void res.writeHead(200, { "content-type": "text/event-stream" }).write("data: 1\n\n");
    if (req.url === "/slow") return void setTimeout(() => res.writeHead(200).end("late"), 500);
    if (req.url === "/short") return res.writeHead(204, { "set-cookie": ["brief=1; Max-Age=1; Path=/", "dated=1; Path=/; Expires=" + new Date(Date.now() + 1000).toUTCString()] }).end();
    if (req.url === "/logout") return res.writeHead(204, { "set-cookie": "sid=; Max-Age=0; Path=/" }).end();
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null, type: req.headers["content-type"] ?? null, body }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  return new Promise((r) => server.close(r));
});

test("sends objects as JSON and parses JSON responses", async () => {
  const res = await new HttpClient(baseUrl).post("/x", { a: 1 }, { query: { page: 2 } });

  expect(res.status).toBe(200);
  expect(res.json).toMatchObject({ url: "/x?page=2", type: "application/json", body: '{"a":1}' });
});

test("keeps cookies until cleared", async () => {
  const client = new HttpClient(baseUrl);
  await client.post("/login");

  expect((await client.get("/me")).json.cookie).toBe("sid=abc");
  client.clearCookies();
  expect((await client.get("/me")).json.cookie).toBeNull();
});

test("with() adds defaults and shares cookies; form() sends urlencoded fields", async () => {
  const client = new HttpClient(baseUrl, { headers: { "x-a": "1" } });
  const api = client.with({ headers: { authorization: "Bearer t" }, query: { v: 2 } });
  await api.post("/login");

  const res = await client.post("/f", client.form({ name: "あ b", n: 1 }));

  expect(res.json).toMatchObject({ type: "application/x-www-form-urlencoded;charset=UTF-8", body: "name=%E3%81%82+b&n=1", cookie: "sid=abc" });
  expect((await api.get("/q")).json.url).toBe("/q?v=2");
  expect(client.history.map((r) => `${r.method} ${r.url} ${r.status}`)).toEqual(["POST /login?v=2 204", "POST /f 200", "GET /q?v=2 200"]);
});

test("expired cookies are dropped", async () => {
  const client = new HttpClient(baseUrl);
  await client.post("/login");
  await client.post("/logout");

  expect(client.cookies.has("sid")).toBe(false);
});

test("sends a cookie only under its Path, and defaults the Path to the setting request's directory", async () => {
  const client = new HttpClient(baseUrl);
  await client.post("/login");
  await client.post("/auth/token");

  expect((await client.get("/auth/refresh")).json.cookie).toBe("refresh=r1; csrf=c1; sid=abc");
  expect((await client.get("/auth/refresh/x")).json.cookie).toBe("refresh=r1; csrf=c1; sid=abc");
  expect((await client.get("/auth/refreshx")).json.cookie).toBe("csrf=c1; sid=abc");
  expect((await client.get("/me")).json.cookie).toBe("sid=abc");
  // Set by hand: no Path known, so it goes everywhere.
  client.cookies.set("manual", "1");
  expect((await client.get("/me")).json.cookie).toBe("sid=abc; manual=1");
});

test("Max-Age wins over Expires", async () => {
  const client = new HttpClient(baseUrl);
  await client.get("/stale");

  expect(client.cookies.get("late")).toBe("1");
});

test("refuses to send requests (and cookies) anywhere but the app", async () => {
  const client = new HttpClient(baseUrl);

  await expect(client.get("//example.com/x")).rejects.toThrow("only talks to the app under test");
  await expect(client.get("https://example.com/")).rejects.toThrow("only talks to the app under test");
});

test("toHaveStatus shows the response body on failure", async () => {
  const res = await new HttpClient(baseUrl).get("/x");

  expect(res).toHaveStatus(200);
  expect(() => expect(res).toHaveStatus(201)).toThrow(/expected GET \/x to respond 201, got 200\nResponse body:\n {2}\{"url":"\/x"/);
});

test("follow keeps cookies set by each redirect, switches to GET on 303 and keeps the body on 307", async () => {
  const client = new HttpClient(baseUrl);

  const res = await client.post("/session", client.form({ a: 1 }), { follow: true });

  expect(res.json).toMatchObject({ url: "/me", cookie: "sid=xyz", type: null, body: "" });
  expect(res.method).toBe("GET");
  expect((await client.post("/keep", "x", { follow: true })).json).toMatchObject({ url: "/echo", body: "x" });
  expect(client.history.map((r) => `${r.method} ${r.url} ${r.status}`)).toEqual(["POST /session 303", "GET /me 200", "POST /keep 307", "POST /echo 200"]);
});

test("follow turns only a POST into a GET on 301 and 302, as fetch does; PUT and DELETE are repeated", async () => {
  const client = new HttpClient(baseUrl);

  expect((await client.post("/moved", "x", { follow: true })).json).toEqual({ method: "GET", body: "" });
  expect((await client.post("/found", "x", { follow: true })).json).toEqual({ method: "GET", body: "" });
  expect((await client.put("/moved", "x", { follow: true })).json).toEqual({ method: "PUT", body: "x" });
  expect((await client.patch("/found", "x", { follow: true })).json).toEqual({ method: "PATCH", body: "x" });
  expect((await client.delete("/moved", { follow: true })).json).toEqual({ method: "DELETE", body: "" });
});

test("a lower-case method is sent upper-case, also patch, which fetch leaves alone", async () => {
  const client = new HttpClient(baseUrl);

  expect((await client.request("patch", "/whoami", "x")).json).toEqual({ method: "PATCH", body: "x" });
  expect((await client.request("put", "/whoami")).json).toMatchObject({ method: "PUT" });
});

test("follow stops at a redirect away from the app", async () => {
  const res = await new HttpClient(baseUrl).get("/away", { follow: true });

  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("https://example.com/");
});

test("a list in query repeats the parameter", async () => {
  const res = await new HttpClient(baseUrl).get("/q?tag=old", { query: { tag: ["a", "b"], page: 2 } });

  expect(res.json.url).toBe("/q?tag=a&tag=b&page=2");
});

test("timeout fails the request by name; a refused connection says the app isn't listening", async () => {
  const client = new HttpClient(baseUrl, { timeout: 100 });

  await expect(client.get("/slow")).rejects.toThrow("slicetest: GET /slow: no response within 100ms (http timeout)");
  expect((await client.get("/slow", { timeout: 2000 })).text).toBe("late");

  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const port = (closed.address() as AddressInfo).port;
  await new Promise((r) => closed.close(r));
  await expect(new HttpClient(`http://127.0.0.1:${port}`).post("/polls", {})).rejects.toThrow("slicetest: POST /polls: connection refused: the app isn't listening");
});

test("form() repeats keys for lists and uses bracket keys for nested objects, as the stubs read them", async () => {
  const { parseForm } = await import("../src/stub.js");
  const fields = { amount: 2000, to: ["a", "b"], metadata: { order: 7 }, items: [{ price: "p_1" }, { price: "p_2" }], note: null, at: new Date(0) };
  const body = new HttpClient(baseUrl).form(fields);

  expect(decodeURIComponent(String(body))).toBe(
    "amount=2000&to=a&to=b&metadata[order]=7&items[0][price]=p_1&items[1][price]=p_2&at=1970-01-01T00:00:00.000Z",
  );
  expect(parseForm(String(body))).toEqual({
    amount: "2000",
    to: ["a", "b"],
    metadata: { order: "7" },
    items: [{ price: "p_1" }, { price: "p_2" }],
    at: "1970-01-01T00:00:00.000Z",
  });
});

test("a header given again in another case replaces the default instead of joining it", async () => {
  const api = new HttpClient(baseUrl).with({ headers: { Authorization: "Bearer a", "Content-Type": "text/plain" } });

  const res = await api.post("/h", "x", { headers: { authorization: "Bearer b", "content-type": "application/xml" } });

  expect(res.json.type).toBe("application/xml");
});

test("ArrayBuffer and other binary views are sent as bytes, not as JSON", async () => {
  const client = new HttpClient(baseUrl);
  const bytes = new TextEncoder().encode("raw");

  expect((await client.post("/b", bytes.buffer)).json).toMatchObject({ body: "raw", type: null });
  expect((await client.post("/b", new DataView(bytes.buffer))).json).toMatchObject({ body: "raw", type: null });
});

test("toHaveStatus takes a class or a list of statuses", async () => {
  const res = await new HttpClient(baseUrl).get("/x");

  expect(res).toHaveStatus("2xx");
  expect(res).toHaveStatus([201, 200]);
  expect(res).toHaveStatus(["3xx", "2xx"]);
  expect(res).not.toHaveStatus("4xx");
  expect(() => expect(res).toHaveStatus([201, "4xx"])).toThrow("expected GET /x to respond one of 201, 4xx, got 200");
  expect(() => expect(res).toHaveStatus("20x" as never)).toThrow('a status is a code (201), a class ("2xx") or a list of them, got "20x"');
  expect(() => expect(undefined).toHaveStatus(200)).toThrow("toHaveStatus expects a response from http, got undefined");
});

test("toRespondWithin checks the response time", async () => {
  const client = new HttpClient(baseUrl);
  const fast = await client.get("/x");
  const slow = await client.get("/slow");

  expect(fast).toRespondWithin(400);
  expect(slow).not.toRespondWithin(400);
  expect(() => expect(slow).toRespondWithin(400)).toThrow(/expected GET \/slow to respond within 400ms, it took \d+ms/);
  expect(() => expect(fast).toRespondWithin(0)).toThrow("toRespondWithin needs a positive number of milliseconds, got 0");
});

test("toSetCookie checks a cookie the response sets and its attributes", async () => {
  const res = await new HttpClient(baseUrl).post("/secure-login");

  expect(res).toSetCookie("sid", { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 3600 });
  expect(res).toSetCookie("sid", { value: expect.stringMatching(/^s3/) });
  expect(res).toSetCookie("sid", { sameSite: expect.stringMatching(/^lax$/) });
  expect(res).toSetCookie("theme");
  expect(res).not.toSetCookie("theme", { httpOnly: true });
  expect(res).not.toSetCookie("tracking");
  expect(() => expect(res).toSetCookie("theme", { httpOnly: true, sameSite: "Strict" })).toThrow(
    'expected POST /secure-login to set cookie theme with {"httpOnly": true, "sameSite": "Strict"}\nCookies it set:\n  sid=s3cr3t {"httpOnly":true,"secure":true,"path":"/","sameSite":"lax","maxAge":3600}\n  theme=dark {}',
  );
  const plain = await new HttpClient(baseUrl).get("/x");
  expect(() => expect(plain).toSetCookie("sid")).toThrow("It set no cookies.");
});

test("text/event-stream responses come with their events", async () => {
  const { parseEvents } = await import("../src/http.js");

  expect(parseEvents(": ping\n\nevent: message_start\ndata: {\"id\":\"m1\"}\nid: 1\n\ndata: line 1\ndata: line 2\n\ndata: [DONE]\r\n\r\nevent: empty\n\n")).toEqual([
    { event: "message_start", data: { id: "m1" }, id: "1" },
    { data: "line 1\nline 2", id: "1" },
    { data: "[DONE]", id: "1" },
  ]);
  const res = await new HttpClient(baseUrl).get("/x");
  expect(res.events).toBeUndefined();
});

test("a body that doesn't finish within the timeout fails naming the request", async () => {
  const client = new HttpClient(baseUrl);

  await expect(client.get("/endless", { timeout: 200 })).rejects.toThrow(
    "slicetest: GET /endless: answered 200 (text/event-stream) but the body didn't finish within 200ms (http timeout); the event stream has to end for its events to be checked",
  );
  expect(client.history.at(-1)).toMatchObject({ method: "GET", url: "/endless", status: 200 });
});

test("a cookie stops being sent once its Max-Age or Expires has passed, as a browser drops it", async () => {
  const client = new HttpClient(baseUrl);
  await client.get("/short");
  expect((await client.get("/me")).json.cookie).toContain("brief=1");
  await new Promise((r) => setTimeout(r, 2100));
  expect((await client.get("/me")).json.cookie).toBeNull();
  expect(client.cookies.has("brief")).toBe(false);
  expect(client.cookies.has("dated")).toBe(false);
});
