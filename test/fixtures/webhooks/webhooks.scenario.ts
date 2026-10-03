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

scenario("http.webhook signs Twilio deliveries over the app's URL and sends them as a form", async ({ http }) => {
  expect(await http.webhook("/webhooks/twilio", { MessageSid: "SM9", SmsStatus: "sent" }, { provider: "twilio", secret: "tw-token" })).toHaveStatus(200);
  expect(await http.webhook("/webhooks/twilio", { SmsStatus: "x" }, { provider: "twilio", secret: "tw-token", invalidSignature: true })).toHaveStatus(400);
});
