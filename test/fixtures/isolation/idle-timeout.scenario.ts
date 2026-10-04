import { expect } from "vitest";
import { scenario } from "slicetest";

// Not the next scenario that fails: the work leaked from the first one, and the app is restarted.

scenario("starts work that outlives the scenario", async ({ http }) => {
  expect(await http.post("/items/later", { delayMs: 10_000 })).toHaveStatus(202);
});

scenario("the next scenario is not blamed for it", async ({ db }) => {
  expect(await db.count("items")).toBe(0);
});
