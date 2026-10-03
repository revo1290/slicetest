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

export type WebhookProvider = "stripe" | "github" | "slack" | "shopify" | "standard" | "line" | "paddle" | "linear" | "gitlab" | "zoom" | "twitch" | HmacScheme;

export interface WebhookOptions {
  provider: WebhookProvider;
  /** The signing secret the app is configured with. For `standard` (Svix), `whsec_<base64>` or the raw key. */
  secret: string;
  /** Event type, sent where the provider puts it: `X-GitHub-Event`, `X-Shopify-Topic`, `X-Gitlab-Event`, `Linear-Event`, `Twitch-Eventsub-Message-Type`. */
  event?: string;
  /** Unix seconds the signature is made for. Default: now. */
  timestamp?: number;
  /** Signed ten minutes ago: an app that rejects replays must refuse it. */
  stale?: boolean;
  /** Signed with a different secret: the app must refuse it. */
  invalidSignature?: boolean;
  /** Message id for `standard` (`webhook-id`, default a random `msg_…`) and `twitch`. */
  id?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

/** The providers `signWebhook` knows by name. */
export const WEBHOOK_PROVIDERS = ["stripe", "github", "slack", "shopify", "standard", "line", "paddle", "linear", "gitlab", "zoom", "twitch"] as const;

const hmac = (algorithm: string, key: string | Buffer, data: string) => createHmac(algorithm, key).update(data);

/**
 * The headers a provider sends with `body`, signed with `secret` the way its
 * SDK verifies them: Stripe's `Stripe-Signature`, GitHub's
 * `X-Hub-Signature-256`, Slack's `v0` signature, Shopify's base64 HMAC,
 * Standard Webhooks (Svix, Resend, Clerk, …), LINE's `X-Line-Signature`,
 * Paddle Billing's `Paddle-Signature`, Linear, GitLab's token, Zoom's `v0`
 * signature and Twitch EventSub.
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
    case "line":
      return { "x-line-signature": hmac("sha256", secret, body).digest("base64") };
    case "paddle":
      return { "paddle-signature": `ts=${ts};h1=${hmac("sha256", secret, `${ts}:${body}`).digest("hex")}` };
    case "linear":
      return {
        "linear-signature": hmac("sha256", secret, body).digest("hex"),
        "linear-delivery": randomUUID(),
        ...(opts.event ? { "linear-event": opts.event } : {}),
      };
    case "gitlab":
      return { "x-gitlab-token": secret, "x-gitlab-event": opts.event ?? "Push Hook", "x-gitlab-event-uuid": randomUUID() };
    case "zoom":
      return { "x-zm-request-timestamp": String(ts), "x-zm-signature": `v0=${hmac("sha256", secret, `v0:${ts}:${body}`).digest("hex")}` };
    case "twitch": {
      const id = opts.id ?? randomUUID();
      const at = new Date(ts * 1000).toISOString();
      return {
        "twitch-eventsub-message-id": id,
        "twitch-eventsub-message-timestamp": at,
        "twitch-eventsub-message-type": opts.event ?? "notification",
        "twitch-eventsub-message-signature": `sha256=${hmac("sha256", secret, `${id}${at}${body}`).digest("hex")}`,
      };
    }
    default:
      throw new Error(`slicetest: unknown webhook provider ${JSON.stringify(p)} (expected ${WEBHOOK_PROVIDERS.join(", ")} or { header, prefix, encoding })`);
  }
}

/** The bytes to send and their content type: objects as JSON, URLSearchParams as a form (Slack commands), strings as-is. */
export function webhookBody(payload: unknown): { body: string; type: string } {
  if (typeof payload === "string") return { body: payload, type: "application/json" };
  if (payload instanceof URLSearchParams) return { body: payload.toString(), type: "application/x-www-form-urlencoded" };
  return { body: JSON.stringify(payload ?? {}), type: "application/json" };
}
