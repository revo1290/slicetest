import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("the app reaches another service through {{service.<name>}}", async ({ http }) => {
  const res = await http.get("/quote");
  expect(res.json).toEqual({ item: "book", price: 1200 });
});

scenario("waitForLog waits for a worker's asynchronous effect", async ({ db, service }) => {
  await db.insert("jobs", { name: "resize" });

  expect(await service("worker").waitForLog(/job 1 \(resize\) done/)).toBe("job 1 (resize) done");
  expect(await db.one("jobs", { id: 1 })).toMatchObject({ done: true });
});

scenario("waitForLog only sees this scenario's output", async ({ service }) => {
  await expect(service("worker").waitForLog("resize", 200)).rejects.toThrow("service worker printed no line matching /resize/ within 200ms");
});

scenario("a service's URL and port are exposed", async ({ service }) => {
  const pricing = service("pricing");
  expect(pricing.url).toBe(`http://127.0.0.1:${pricing.port}`);
  expect(pricing.scenarioLogs()).toBe("");
});

scenario("an autoReply stub answers from the provider's spec without any routes", async ({ http, stub }) => {
  const res = await http.post("/signup");

  expect(res.json).toEqual({ status: 202, sent: { messageId: "msg_123" }, user: { id: 0, email: "user@example.com" } });
  expect(stub("mailer").calls("POST", "/v3/mail/send")[0]).toMatchObject({ fallback: true, json: { subject: "Welcome" } });
});

scenario("a registered route still wins over autoReply", async ({ http, stub }) => {
  stub("mailer").on("GET", "/v3/users/:id").reply((call) => ({ body: { id: Number(call.params.id), email: "real@example.com" } }));

  expect((await http.post("/signup")).json.user).toEqual({ id: 42, email: "real@example.com" });
});
