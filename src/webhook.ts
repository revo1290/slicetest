import { createHmac, randomUUID } from "node:crypto";

/** A custom HMAC scheme: `header: prefix + hmac(secret, body)`. */
export interface HmacScheme {
  header: string;
  /** Default `sha256`. */
  algorithm?: string;
  /** Default `hex`. */
  encoding?: "hex" | "base64";
  /** Prepended to the digest, e.g. `sha256=`. */
  prefix?: string;
}

export type WebhookProvider = "stripe" | "github" | "slack" | "shopify" | "standard" | HmacScheme;

export interface WebhookOptions {
  provider: WebhookProvider;
  /** The signing secret the app is configured with. For `standard` (Svix), `whsec_<base64>` or the raw key. */
  secret: string;
  /** Event type, sent where the provider puts it: `X-GitHub-Event`, `X-Shopify-Topic`. */
  event?: string;
  /** Unix seconds the signature is made for. Default: now. */
  timestamp?: number;
  /** Signed ten minutes ago: an app that rejects replays must refuse it. */
  stale?: boolean;
  /** Signed with a different secret: the app must refuse it. */
  invalidSignature?: boolean;
  /** Message id for `standard` (`webhook-id`). Default: a random `msg_…`. */
  id?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

const hmac = (algorithm: string, key: string | Buffer, data: string) => createHmac(algorithm, key).update(data);

/**
 * The headers a provider sends with `body`, signed with `secret` the way its
 * SDK verifies them: Stripe's `Stripe-Signature`, GitHub's
 * `X-Hub-Signature-256`, Slack's `v0` signature, Shopify's base64 HMAC and
 * Standard Webhooks (Svix, Resend, Clerk, …).
 */
export function signWebhook(body: string, opts: WebhookOptions): Record<string, string> {
  const now = Math.floor(Date.now() / 1000);
  const ts = opts.timestamp ?? (opts.stale ? now - 600 : now);
  const secret = opts.invalidSignature ? `${opts.secret}-not-the-real-secret` : opts.secret;
  const p = opts.provider;
  if (typeof p === "object") {
    if (!p.header) throw new Error("slicetest: a custom webhook provider needs `header`, e.g. { header: \"X-Signature\", prefix: \"sha256=\" }");
    return { [p.header]: `${p.prefix ?? ""}${hmac(p.algorithm ?? "sha256", secret, body).digest(p.encoding ?? "hex")}` };
  }
  switch (p) {
    case "stripe":
      return { "stripe-signature": `t=${ts},v1=${hmac("sha256", secret, `${ts}.${body}`).digest("hex")}` };
    case "github":
      return {
        "x-hub-signature-256": `sha256=${hmac("sha256", secret, body).digest("hex")}`,
        "x-github-event": opts.event ?? "ping",
        "x-github-delivery": randomUUID(),
      };
    case "slack":
      return { "x-slack-request-timestamp": String(ts), "x-slack-signature": `v0=${hmac("sha256", secret, `v0:${ts}:${body}`).digest("hex")}` };
    case "shopify":
      return {
        "x-shopify-hmac-sha256": hmac("sha256", secret, body).digest("base64"),
        ...(opts.event ? { "x-shopify-topic": opts.event } : {}),
        "x-shopify-webhook-id": randomUUID(),
      };
    case "standard": {
      const id = opts.id ?? `msg_${randomUUID().replace(/-/g, "")}`;
      const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret);
      return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${hmac("sha256", key, `${id}.${ts}.${body}`).digest("base64")}` };
    }
    default:
      throw new Error(`slicetest: unknown webhook provider ${JSON.stringify(p)} (expected stripe, github, slack, shopify, standard or { header, prefix, encoding })`);
  }
}

/** The bytes to send and their content type: objects as JSON, URLSearchParams as a form (Slack commands), strings as-is. */
export function webhookBody(payload: unknown): { body: string; type: string } {
  if (typeof payload === "string") return { body: payload, type: "application/json" };
  if (payload instanceof URLSearchParams) return { body: payload.toString(), type: "application/x-www-form-urlencoded" };
  return { body: JSON.stringify(payload ?? {}), type: "application/json" };
}
