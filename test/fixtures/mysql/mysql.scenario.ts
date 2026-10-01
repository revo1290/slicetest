import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("rows come back typed like Postgres's: numbers, booleans, generated columns", async ({ http, db }) => {
  const res = await http.post("/posts", { authorId: 1, title: "Hello World" });

  expect(res).toHaveStatus(201);
  expect(await db.one("posts", { id: res.json.id })).toEqual({ id: 1, author_id: 1, title: "Hello World", published: false, slug: "hello-world" });
  await expect(db).toHaveRow("audit", { message: "post 1" });
});

scenario("the reset restarts AUTO_INCREMENT and re-applies the seed", async ({ http, db }) => {
  expect((await http.post("/posts", { authorId: 1, title: "again" })).json).toEqual({ id: 1 });
  expect(await db.rows("authors")).toEqual([{ id: 1, name: "Ada" }]);
});

scenario("keep leaves reference data alone", async ({ db }) => {
  expect(await db.rows("categories")).toEqual([{ code: "news", label: "News" }]);
});

scenario("db.insert returns the stored row, and db.changes reports updates by key", async ({ http, db }) => {
  const [post] = await db.insert("posts", { author_id: 1, title: "Draft" });
  expect(post).toMatchObject({ id: 1, published: false, slug: "draft" });
  await db.checkpoint();

  await http.post(`/posts/${post!.id}/publish`);

  expect(await db.changes()).toEqual({
    posts: { inserted: [], updated: [{ key: { id: 1 }, before: expect.objectContaining({ published: false }), after: expect.objectContaining({ published: true }), changed: ["published"] }], deleted: [] },
  });
  expect((await http.get("/feed")).json).toEqual([{ id: 1, title: "Draft", author: "Ada" }]);
});

scenario("filters, counts and the sql tag use MySQL placeholders", async ({ db }) => {
  await db.insert("authors", [{ name: "Grace" }, { name: "Linus" }]);

  expect(await db.count("authors", { name: ["Ada", "Grace"] })).toBe(2);
  expect(await db.count("authors", { name: [] })).toBe(0);
  expect(await db.sql`SELECT name FROM authors WHERE id > ${1} ORDER BY id`).toEqual([{ name: "Grace" }, { name: "Linus" }]);
  expect(await db.rows("authors", {}, { orderBy: "-id", limit: 1 })).toEqual([{ id: 3, name: "Linus" }]);
});

scenario("db.make fills required columns and creates the parent rows foreign keys need", async ({ db }) => {
  const post = await db.make("posts");
  expect(post).toEqual({ id: 1, author_id: 2, title: "title-1", published: false, slug: "title-1" });
  expect(await db.one("authors", { id: 2 })).toEqual({ id: 2, name: "name-2" });
});

scenario("db.queries records the app's statements through the MySQL protocol", async ({ http, db }) => {
  const queries = await db.queries(() => http.post("/posts", { authorId: 1, title: "q" }));
  expect(queries.some((q) => /^INSERT INTO posts/i.test(q.sql.trim()))).toBe(true);
  expect((await db.queries()).length).toBeGreaterThanOrEqual(queries.length);
});
