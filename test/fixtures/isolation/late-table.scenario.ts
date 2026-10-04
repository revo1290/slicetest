import { expect } from "vitest";
import { scenario } from "slicetest";

// Order matters: the second scenario relies on the first one's table.

scenario("late table: a scenario creates a table after the run started", async ({ db }) => {
  await db.query("CREATE TABLE late (id INTEGER PRIMARY KEY, note TEXT)");
  await db.query("INSERT INTO late (note) VALUES ('left behind')");
  expect(await db.count("late")).toBe(1);
});

scenario("late table: the next scenario finds that table empty", async ({ db }) => {
  expect(await db.count("late")).toBe(0);
});
