import { expect } from "vitest";
import { scenario } from "slicetest";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The failing scenario skips afterScenario(), so the next scenario's start has to do that cleanup.

scenario("a scenario leaves state behind and fails", async ({ http, db, stub }) => {
  stub("upstream").on("GET", "/ping").once().reply(200, { from: "failed scenario" });
  stub("upstream").chaos({ failFirst: 1, statuses: [503] });
  await http.get("/login");
  await db.insert("items", { body: "left behind" });
  await http.post("/items/later", { delayMs: 150 });
  throw new Error("failed on purpose");
});

scenario("the next scenario starts clean", async ({ http, db, stub }) => {
  await sleep(400);
  expect(http.cookies.get("sid")).toBeUndefined();
  expect((await http.get("/whoami")).json).toEqual({ cookie: null });
  expect(stub("upstream").calls()).toEqual([]);
  expect(stub("upstream").describeRoutes()).toEqual([]);
  expect(stub("upstream").describeChaos()).toBeUndefined();
  expect(await db.count("items")).toBe(0);
});
