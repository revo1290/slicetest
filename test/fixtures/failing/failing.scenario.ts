import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("unmatched stub call", async ({ http, stub }) => {
  stub("mail").on("POST", "/other").reply(200);
  const res = await http.post("/notify");
  expect(res.status).toBe(501);
});

scenario("app crash", async ({ http }) => {
  await http.get("/crash").catch(() => {});
});

scenario("the next scenario gets a restarted app", async ({ http }) => {
  expect((await http.get("/")).text).toBe("ok");
});

scenario("a failing assertion prints requests and this scenario's app output", async ({ http }) => {
  await http.get("/log-something");
  expect((await http.get("/")).status).toBe(418);
});

scenario("a service crash fails the scenario", async ({ http }) => {
  await http.get("/kill-sidecar");
});

scenario("the crashed service is restarted on the same port", async ({ http }) => {
  expect((await http.get("/sidecar")).text).toBe("sidecar ok");
});
