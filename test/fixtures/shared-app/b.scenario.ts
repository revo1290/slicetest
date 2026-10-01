import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("the app was started once for both files of the worker", async ({ http }) => {
  const starts = readFileSync(new URL("starts.log", import.meta.url), "utf8").trim().split("\n");
  expect(starts).toEqual([String((await http.get("/")).json.pid)]);
});

scenario("the database is still reset between scenarios", async ({ db }) => {
  expect(await db.count("notes")).toBe(0);
  await db.insert("notes", { body: "x" });
});
