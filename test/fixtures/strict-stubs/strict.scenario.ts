import { scenario } from "slicetest";

scenario("a route the app calls passes", async ({ http, stub }) => {
  stub("pay").on("POST", "/charges").reply(201);
  await http.get("/order?amount=5");
});

scenario("an optional route the app doesn't call passes", async ({ http, stub }) => {
  stub("pay").on("POST", "/charges").optional().reply(201);
  await http.get("/order?amount=0");
});

scenario("FAILS: a route the app never called", async ({ http, stub }) => {
  stub("pay").on("POST", "/charges").reply(201);
  await http.get("/order?amount=0");
});
