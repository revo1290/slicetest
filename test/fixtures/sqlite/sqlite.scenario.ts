import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("the app and the test share one SQLite file", async ({ http, db }) => {
  const [author] = await db.insert("authors", { name: "ada" });
  expect(author).toEqual({ id: 1, name: "ada" });
  await db.checkpoint();

  const res = await http.post("/posts", { author: "ada", title: "Hello" });
  expect(res).toHaveStatus(201);
  expect(await db.changes()).toEqual({
    posts: { inserted: [{ id: 1, author_id: 1, title: "Hello", published: 0 }], updated: [], deleted: [] },
  });
  expect((await http.get("/posts")).json).toEqual([{ id: 1, author: "ada", title: "Hello" }]);
});

scenario("tables are emptied between scenarios and AUTOINCREMENT ids start over", async ({ http, db }) => {
  expect(await db.count("posts")).toBe(0);
  await db.insert("authors", [{ name: "grace" }, { name: "linus" }]);
  expect(await db.rows("authors", { name: ["grace", "linus"] }, { orderBy: "id" })).toEqual([
    { id: 1, name: "grace" },
    { id: 2, name: "linus" },
  ]);
  expect((await http.get("/")).json).toEqual({ site: "blog" });
});

scenario("the app's foreign keys still hold after resets, and booleans bind as 0/1", async ({ http, db }) => {
  expect(await http.post("/posts", { author: "nobody", title: "x" })).toHaveStatus(422);
  await db.insert("authors", { name: "ada" });
  await db.insert("posts", { author_id: 1, title: "t", published: true });
  await expect(db).toHaveRow("posts", { published: 1 }, 1);
  await expect(db.insert("posts", { author_id: 99, title: "orphan" })).rejects.toThrow(/FOREIGN KEY/);
});
