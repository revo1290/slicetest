import { createPublicKey, createVerify } from "node:crypto";
import http from "node:http";

// Verifies RS256 JWTs the way a production app does: discovery, then the JWKS, refetched on an unknown kid.
const issuer = process.env.OIDC_ISSUER;
let keys = new Map();

async function loadKeys() {
  const config = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
  const { keys: list } = await (await fetch(config.jwks_uri)).json();
  keys = new Map(list.map((k) => [k.kid, createPublicKey({ key: k, format: "jwk" })]));
}

async function verify(header) {
  const token = /^Bearer (.+)$/.exec(header ?? "")?.[1];
  if (!token) throw new Error("no token");
  const [h, p, s] = token.split(".");
  const { kid, alg } = JSON.parse(Buffer.from(h, "base64url"));
  if (alg !== "RS256") throw new Error("alg");
  if (!keys.has(kid)) await loadKeys();
  const key = keys.get(kid);
  if (!key || !createVerify("RSA-SHA256").update(`${h}.${p}`).verify(key, Buffer.from(s, "base64url"))) throw new Error("signature");
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  if (claims.iss !== issuer) throw new Error("issuer");
  if (claims.aud !== process.env.OIDC_AUDIENCE) throw new Error("audience");
  if (claims.exp <= Date.now() / 1000) throw new Error("expired");
  return claims;
}

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://app");
    if (url.pathname === "/me") {
      try {
        const claims = await verify(req.headers.authorization);
        return send(res, 200, { sub: claims.sub, roles: claims.roles ?? [], tenant: claims.tenant });
      } catch (e) {
        return send(res, 401, { error: e.message });
      }
    }
    if (url.pathname === "/machine-token") {
      // The app's own client-credentials call, as a backend calling another API would make it.
      const config = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
      const r = await fetch(config.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from("billing-worker:secret").toString("base64")}` },
        body: "grant_type=client_credentials&scope=invoices:read",
      });
      const { access_token } = await r.json();
      const claims = await verify(`Bearer ${access_token}`);
      return send(res, 200, { sub: claims.sub, scope: claims.scope });
    }
    send(res, 404, {});
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("app ready"));
