import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("db.migrate.env and {{db.*}} in the command reach a tool that doesn't read DATABASE_URL", async ({ db }) => {
  await db.insert("notes", { body: "hi" });
  expect(await db.rows("notes")).toEqual([{ id: 1, body: "hi" }]);
});
