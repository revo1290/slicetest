import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("an app without a database runs with stubs and gets no DATABASE_URL", async ({ http, stub, app }) => {
  stub("quotes").on("GET", "/quote").reply(200, { text: "hi" });
  expect((await http.get("/env")).json).toEqual({ DATABASE_URL: null });
  expect(app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});

scenario("db.* says the database is off", async ({ db }) => {
  await expect(db.count("anything")).rejects.toThrow("the app has no database (db: false)");
});
