import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("the provider's errors reach the app like the real ones", async ({ http, stub }) => {
  stub("weather").on("GET", "/v1/now").reply(503, { error: "maintenance" });

  expect(await http.get("/weather?city=Osaka")).toHaveStatus(502);
  expect((await http.get("/weather?city=Osaka")).json).toEqual({ error: "weather service answered 503" });
});

scenario("the redirect to the provider is recorded with its full URL; cookies stay with the app", async ({ http, stub }) => {
  stub("provider")
    .on("GET", "/authorize")
    .reply((call) => ({ status: 302, headers: { location: `${call.query.get("redirect_uri")}?code=c&state=s-123`, "set-cookie": "provider=1; Path=/" } }));
  stub("provider").on("POST", "/token").reply(200, { access_token: "t" });

  await http.get("/login", { follow: true });

  expect(http.history.map((r) => `${r.method} ${r.url.split("?")[0]} ${r.status}`)).toEqual([
    "GET /login 302",
    "GET https://id.provider.test/authorize 302",
    "GET /callback 303",
    "GET /me 200",
  ]);
  expect([...http.cookies.keys()]).toEqual(["session"]);
});
