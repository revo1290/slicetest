import { expect } from "vitest";
import { scenario } from "slicetest";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Order matters: each pair relies on the first scenario leaving state for the second.

scenario("cache: the first scenario fills the app's cache", async ({ http, db }) => {
  await db.insert("items", [{ body: "a" }, { body: "b" }]);
  expect((await http.get("/count")).json).toEqual({ count: 2 });
});

scenario("cache: the next scenario starts from an empty database, and so does the app's view of it", async ({ http, db }) => {
  expect(await db.count("items")).toBe(0);
  expect((await http.get("/count")).json).toEqual({ count: 0 });
});

scenario("delayed write: a scenario schedules a write and ends before it happens", async ({ http }) => {
  expect(await http.post("/items/later", { delayMs: 1500 })).toHaveStatus(202);
});

// Polled, not one look after a fixed sleep: the write landed 2.4 s after it was scheduled on a Windows runner.
scenario("delayed write: the next scenario doesn't receive the previous one's write", async ({ db }) => {
  for (const start = Date.now(); Date.now() - start < 5000 && (await db.count("items")) === 0; ) await sleep(50);
  expect(await db.count("items")).toBe(0);
}, 15_000);
