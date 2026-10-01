import { expect } from "vitest";
import { scenario } from "slicetest";

const stripe = { provider: "stripe", secret: "whsec_test" } as const;

scenario("a signed Stripe event is accepted; tampered and replayed ones are not", async ({ http }) => {
  expect(await http.webhook("/webhooks/stripe", { type: "invoice.paid" }, stripe)).toHaveStatus(200);
  expect((await http.webhook("/webhooks/stripe", { type: "x" }, { ...stripe, invalidSignature: true })).json).toEqual({ error: "bad signature" });
  expect((await http.webhook("/webhooks/stripe", { type: "x" }, { ...stripe, stale: true })).json).toEqual({ error: "timestamp outside the tolerance" });
  expect((await http.get("/events")).json).toEqual([{ source: "stripe", type: "invoice.paid" }]);
});

scenario("GitHub deliveries carry the event name", async ({ http }) => {
  expect(await http.webhook("/webhooks/github", { action: "opened" }, { provider: "github", secret: "gh-secret", event: "pull_request" })).toHaveStatus(200);
  expect((await http.get("/events")).json).toEqual([{ source: "github", type: "pull_request" }]);
});
