import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("an unrouted call is answered by the real service, or its recording", async ({ http, stub }) => {
  const res = await http.get("/?city=tokyo");

  expect(res.json).toEqual({ city: "tokyo", weather: { city: "tokyo", temp: 21 } });
  expect(stub("weather").calls("GET", "/forecast")).toHaveLength(1);
});

scenario("a registered route still wins over the recording", async ({ http, stub }) => {
  stub("weather").on("GET", "/forecast").reply(200, { city: "tokyo", temp: -5 });

  expect((await http.get("/?city=tokyo")).json.weather.temp).toBe(-5);
});

scenario("errors are recorded too", async ({ http }) => {
  const res = await http.get("/?city=atlantis");

  expect(res.status).toBe(404);
  expect(res.json.weather).toBe("unknown city");
});
