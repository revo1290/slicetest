import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("response body breaks the schema", async ({ http }) => {
  expect(await http.get("/users/1")).toHaveStatus(200);
});

scenario("undocumented status and path", async ({ http }) => {
  await http.get("/users/3");
  await http.get("/secret");
});

scenario("the app sends a bad request to a stub, and the stub replies in a way the real service wouldn't", async ({ http, stub }) => {
  stub("mail").on("POST", "/v3/mail/send").reply(200, { ok: true });
  await http.post("/signup");
});

scenario("traffic that matches the specs passes", async ({ http }) => {
  expect(await http.get("/users/2")).toHaveStatus(200);
});
