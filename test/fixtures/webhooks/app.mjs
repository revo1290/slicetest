import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

// Verifies deliveries the way Stripe's and GitHub's SDKs do: HMAC over the raw body, with a timestamp tolerance for Stripe.
const events = [];
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function stripe(req, body) {
  const parts = Object.fromEntries((req.headers["stripe-signature"] ?? "").split(",").map((kv) => kv.split("=")));
  if (!parts.t || !parts.v1) return "missing signature";
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return "timestamp outside the tolerance";
  const expected = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET).update(`${parts.t}.${body}`).digest("hex");
  return same(expected, parts.v1) ? null : "bad signature";
}

function github(req, body) {
  const expected = `sha256=${createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`;
  return same(expected, req.headers["x-hub-signature-256"] ?? "") ? null : "bad signature";
}

// @line/bot-sdk's validateSignature: base64 HMAC-SHA256 of the body with the channel secret.
function line(req, body) {
  const expected = createHmac("sha256", process.env.LINE_CHANNEL_SECRET).update(body).digest("base64");
  return same(expected, req.headers["x-line-signature"] ?? "") ? null : "bad signature";
}

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const send = (status, json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const verifier = { "/webhooks/stripe": stripe, "/webhooks/github": github, "/webhooks/line": line }[req.url];
    if (req.method === "POST" && verifier) {
      const error = verifier(req, body);
      if (error) return send(400, { error });
      const event = JSON.parse(body);
      events.push({ source: req.url.split("/")[2], type: event.type ?? event.events?.[0]?.type ?? req.headers["x-github-event"] });
      return send(200, { received: true });
    }
    if (req.url === "/events") return send(200, events.splice(0));
    send(404, {});
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("app ready"));
