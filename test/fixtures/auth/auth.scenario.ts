import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("the app verifies minted tokens against the issuer's JWKS", async ({ http, auth }) => {
  const res = await http.get("/me", { headers: auth.header({ sub: "alice", roles: ["admin"] }) });
  expect(res).toHaveStatus(200);
  expect(res.json).toEqual({ sub: "alice", roles: ["admin"], tenant: "acme" });
});

scenario("expired, foreign-signed and wrong-audience tokens are rejected", async ({ http, auth }) => {
  const me = (opts: Parameters<typeof auth.header>[1]) => http.get("/me", { headers: auth.header({}, opts) });
  expect((await me({ expired: true })).json).toEqual({ error: "expired" });
  expect((await me({ wrongKey: true })).json).toEqual({ error: "signature" });
  expect((await me({ audience: "api://other" })).json).toEqual({ error: "audience" });
  expect((await me({ issuer: "https://evil.example" })).json).toEqual({ error: "issuer" });
});

scenario("after a key rotation the app picks up the new key from the JWKS", async ({ http, auth }) => {
  expect(await http.get("/me", { headers: auth.header() })).toHaveStatus(200);
  auth.rotate();
  expect(await http.get("/me", { headers: auth.header() })).toHaveStatus(200);
});

scenario("the app's own client-credentials grant gets a token for its client id", async ({ http }) => {
  expect((await http.get("/machine-token")).json).toEqual({ sub: "billing-worker", scope: "invoices:read" });
});
