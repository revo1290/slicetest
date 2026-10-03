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

scenario("db.make fills required columns and creates the parent rows foreign keys need", async ({ db }) => {
  const post = await db.make("posts", { title: "Made" });
  expect(post).toEqual({ id: 1, author_id: 1, title: "Made", published: 0 });
  expect(await db.rows("authors")).toEqual([{ id: 1, name: "name-2" }]);

  const [a, b] = await db.makeMany("authors", 2, (i) => ({ name: `writer ${i}` }));
  expect([a!.name, b!.name]).toEqual(["writer 0", "writer 1"]);
  await expect(db.make("posts", { body: "x" })).rejects.toThrow(/there is no column "body"/);
});

scenario("app.build ran once before the app started", async () => {
  const { readFile, stat } = await import("node:fs/promises");
  const stamp = Number(await readFile(new URL(".build-stamp", import.meta.url), "utf8"));
  expect(Date.now() - stamp).toBeLessThan(120_000);
  expect((await stat(new URL(".build-stamp", import.meta.url))).isFile()).toBe(true);
});

scenario("http.submit picks the form by its button and says what's on the page otherwise", async ({ http }) => {
  const page = await http.get("/signup");

  const res = await http.submit(page, { button: "Sign up", fields: { name: "linus" } });
  expect(res).toHaveStatus(303);
  expect(res.headers.get("location")).toBe("/authors/1");
  expect((await http.submit(page, { button: "Search", fields: { q: "a b" } })).url).toBe("/search?q=a+b");
  await expect(http.submit(page)).rejects.toThrow("the page has 2 forms");
  await expect(http.submit(res)).rejects.toThrow("(the page: POST /signup → 303, a redirect to /authors/1; request it with follow: true)");
});

scenario("db.changes({ ignore }) leaves out columns and whole tables", async ({ db }) => {
  await db.insert("authors", { name: "ada" });
  await db.insert("posts", { author_id: 1, title: "draft" });
  await db.query("UPDATE posts SET published = 1 WHERE id = 1");

  // The update only touched an ignored column, so the post reads as inserted with no later update.
  expect(await db.changes({ ignore: ["published", "authors.*"] })).toEqual({
    posts: { inserted: [{ id: 1, author_id: 1, title: "draft" }], updated: [], deleted: [] },
  });
  await db.checkpoint();
  await db.query("UPDATE posts SET published = 0, title = 'final' WHERE id = 1");
  expect((await db.changes({ ignore: ["posts.published"] })).posts!.updated).toEqual([
    { key: { id: 1 }, before: { id: 1, author_id: 1, title: "draft" }, after: { id: 1, author_id: 1, title: "final" }, changed: ["title"] },
  ]);
  await db.checkpoint();
  await db.query("UPDATE posts SET published = 1 WHERE id = 1");
  expect(await db.changes({ ignore: ["published"] })).toEqual({});
});
