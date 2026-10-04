import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { signWebhook } from "../src/webhook.js";

// Vectors from the providers' own documentation.
test("GitHub: X-Hub-Signature-256 matches GitHub's documented example", () => {
  const headers = signWebhook("Hello, World!", { provider: "github", secret: "It's a Secret to Everybody", event: "push" });
  expect(headers["x-hub-signature-256"]).toBe("sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17");
  expect(headers["x-github-event"]).toBe("push");
});

test("Slack: v0 signature matches Slack's documented example", () => {
  const body =
    "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
  const headers = signWebhook(body, { provider: "slack", secret: "8f742231b10e8888abcd99yyyzzz85a5", timestamp: 1531420618 });
  expect(headers).toEqual({ "x-slack-request-timestamp": "1531420618", "x-slack-signature": "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503" });
});

test("Standard Webhooks: matches the reference libraries' test vector", () => {
  const headers = signWebhook('{"test": 2432232314}', {
    provider: "standard",
    secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
    timestamp: 1614265330,
  });
  expect(headers["webhook-signature"]).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
});

test("Stripe: t=<timestamp>,v1=HMAC of `<timestamp>.<body>`; stale and invalid variants", () => {
  const now = Math.floor(Date.now() / 1000);
  const sig = (o: object) => signWebhook("{}", { provider: "stripe", secret: "whsec_x", ...o })["stripe-signature"]!;
  expect(sig({ timestamp: 1700000000 })).toBe(`t=1700000000,v1=${createHmac("sha256", "whsec_x").update("1700000000.{}").digest("hex")}`);
  expect(Number(/t=(\d+)/.exec(sig({ stale: true }))![1])).toBeLessThanOrEqual(now - 600);
  expect(sig({ timestamp: 1, invalidSignature: true })).not.toBe(sig({ timestamp: 1 }));
});

test("custom schemes and unknown providers", () => {
  expect(signWebhook("x", { provider: { header: "X-Sig", prefix: "sha1=", algorithm: "sha1" }, secret: "k" })).toEqual({
    "X-Sig": `sha1=${createHmac("sha1", "k").update("x").digest("hex")}`,
  });
  expect(() => signWebhook("x", { provider: "paypal" as never, secret: "k" })).toThrow("unknown webhook provider");
});

test("LINE, Paddle, Linear, GitLab, Zoom and Twitch sign the way their SDKs verify", () => {
  const body = '{"events":[]}';
  const mac = (algo: string, data: string, enc: "hex" | "base64" = "hex") => createHmac(algo, "s3cret").update(data).digest(enc);
  const sign = (provider: string, o: object = {}) => signWebhook(body, { provider: provider as "line", secret: "s3cret", timestamp: 1700000000, ...o });

  expect(sign("line")).toEqual({ "x-line-signature": mac("sha256", body, "base64") });
  expect(sign("paddle")).toEqual({ "paddle-signature": `ts=1700000000;h1=${mac("sha256", `1700000000:${body}`)}` });
  expect(sign("linear", { event: "Issue" })).toMatchObject({ "linear-signature": mac("sha256", body), "linear-event": "Issue" });
  expect(sign("gitlab", { event: "Merge Request Hook" })).toMatchObject({ "x-gitlab-token": "s3cret", "x-gitlab-event": "Merge Request Hook" });
  expect(sign("gitlab", { invalidSignature: true })["x-gitlab-token"]).not.toBe("s3cret");
  expect(sign("zoom")).toEqual({ "x-zm-request-timestamp": "1700000000", "x-zm-signature": `v0=${mac("sha256", `v0:1700000000:${body}`)}` });
  expect(sign("twitch", { id: "m-1" })).toEqual({
    "twitch-eventsub-message-id": "m-1",
    "twitch-eventsub-message-timestamp": "2023-11-14T22:13:20.000Z",
    "twitch-eventsub-message-type": "notification",
    "twitch-eventsub-message-signature": `sha256=${mac("sha256", `m-12023-11-14T22:13:20.000Z${body}`)}`,
  });
});

test("Typeform, Notion, Bitbucket and Intercom sign the raw body the way their docs describe", () => {
  const body = '{"form_response":{}}';
  const mac = (algo: string, enc: "hex" | "base64") => createHmac(algo, "s3cret").update(body).digest(enc);
  const sign = (provider: string, o: object = {}) => signWebhook(body, { provider: provider as "typeform", secret: "s3cret", ...o });

  expect(sign("typeform")).toEqual({ "typeform-signature": `sha256=${mac("sha256", "base64")}` });
  expect(sign("notion")).toEqual({ "x-notion-signature": `sha256=${mac("sha256", "hex")}` });
  expect(sign("bitbucket")).toEqual({ "x-hub-signature": `sha256=${mac("sha256", "hex")}` });
  expect(sign("intercom")).toEqual({ "x-hub-signature": `sha1=${mac("sha1", "hex")}` });
  expect(sign("notion")["x-notion-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  expect(sign("typeform", { invalidSignature: true })["typeform-signature"]).not.toBe(sign("typeform")["typeform-signature"]);
});

test("Twilio: matches the example in Twilio's security docs, and posts objects as a form", async () => {
  const { webhookBody } = await import("../src/webhook.js");
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
  const { body, type } = webhookBody(params, "twilio");
  expect(type).toBe("application/x-www-form-urlencoded");
  expect(signWebhook(body, { provider: "twilio", secret: "12345", url: "https://mycompany.com/myapp.php?foo=1&bar=2" })).toEqual({
    "x-twilio-signature": "0/KCTR6DLpKmkAf8muzZqo1nDgQ=",
  });
  expect(() => signWebhook(body, { provider: "twilio", secret: "12345" })).toThrow("signed over its URL");
});
