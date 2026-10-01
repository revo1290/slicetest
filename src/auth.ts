import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface TokenOptions {
  /** Seconds until the token expires. Default 3600. */
  expiresIn?: number;
  /** A token that expired a minute ago. */
  expired?: boolean;
  /** Signed by a key the issuer doesn't publish: the app must reject it. */
  wrongKey?: boolean;
  /** Override `aud` (default: the configured audience). */
  audience?: string | string[];
  /** Override `iss`, e.g. to test that the app checks it. */
  issuer?: string;
}

export interface AuthOptions {
  /** `aud` of the tokens. Default `"slicetest"`. */
  audience?: string;
  /** Claims every token gets unless the scenario overrides them. */
  claims?: Record<string, unknown>;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

interface Key {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function newKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomUUID();
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

/**
 * An OpenID Connect issuer for the app under test: it publishes a discovery
 * document and a JWKS, so the app verifies tokens exactly as it does in
 * production, and the scenario mints tokens with whatever claims it needs.
 * `POST /token` answers the client-credentials grant for apps that fetch
 * tokens themselves.
 */
export class Issuer {
  #key = newKey();
  /** Never published: tokens signed with it must be rejected. */
  #rogue?: Key;
  #issued = 0;

  private constructor(
    private readonly server: Server,
    readonly url: string,
    private readonly opts: Required<AuthOptions>,
  ) {}

  static async start(opts: AuthOptions = {}) {
    let issuer!: Issuer;
    const server = createServer((req, res) => {
      issuer.#handle(req).then(
        ([status, body]) => {
          res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(body));
        },
        (e) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "server_error", error_description: String(e) }));
        },
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    issuer = new Issuer(server, `http://127.0.0.1:${port}`, { audience: opts.audience ?? "slicetest", claims: opts.claims ?? {} });
    return issuer;
  }

  get audience() {
    return this.opts.audience;
  }

  get jwksUrl() {
    return `${this.url}/.well-known/jwks.json`;
  }

  /** A signed RS256 JWT. `claims` override the defaults (`sub: "user-1"`, `iss`, `aud`, `iat`, `exp`). */
  token(claims: Record<string, unknown> = {}, opts: TokenOptions = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const exp = opts.expired ? now - 60 : now + (opts.expiresIn ?? 3600);
    const key = opts.wrongKey ? (this.#rogue ??= newKey()) : this.#key;
    const payload = {
      iss: opts.issuer ?? this.url,
      aud: opts.audience ?? this.opts.audience,
      sub: "user-1",
      iat: opts.expired ? exp - 3600 : now,
      nbf: opts.expired ? exp - 3600 : now,
      exp,
      jti: `slicetest-${++this.#issued}`,
      ...this.opts.claims,
      ...claims,
    };
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid }));
    const body = b64url(JSON.stringify(payload));
    const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key.privateKey);
    return `${head}.${body}.${b64url(signature)}`;
  }

  /** `{ authorization: "Bearer <token>" }`, for `http.get(path, { headers })`. */
  header(claims?: Record<string, unknown>, opts?: TokenOptions) {
    return { authorization: `Bearer ${this.token(claims, opts)}` };
  }

  /** Rotate the signing key: tokens minted from now on use a new `kid`, and the JWKS publishes only it. */
  rotate() {
    this.#key = newKey();
  }

  reset() {
    this.#issued = 0;
  }

  async #handle(req: IncomingMessage): Promise<[number, unknown]> {
    const path = new URL(req.url ?? "/", this.url).pathname;
    if (req.method === "GET" && path === "/.well-known/openid-configuration") {
      return [
        200,
        {
          issuer: this.url,
          jwks_uri: this.jwksUrl,
          token_endpoint: `${this.url}/token`,
          response_types_supported: ["token"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          grant_types_supported: ["client_credentials"],
        },
      ];
    }
    if (req.method === "GET" && path === "/.well-known/jwks.json") return [200, { keys: [this.#key.jwk] }];
    if (req.method === "POST" && path === "/token") {
      const form = new URLSearchParams(await text(req));
      if (form.get("grant_type") !== "client_credentials") return [400, { error: "unsupported_grant_type" }];
      const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
      const client = form.get("client_id") ?? (basic ? decodeURIComponent(Buffer.from(basic, "base64").toString().split(":")[0]!) : undefined);
      if (!client) return [401, { error: "invalid_client" }];
      const claims: Record<string, unknown> = { sub: client, client_id: client };
      const scope = form.get("scope");
      if (scope) claims.scope = scope;
      const audience = form.get("audience") ?? undefined;
      return [200, { access_token: this.token(claims, { audience }), token_type: "Bearer", expires_in: 3600, ...(scope ? { scope } : {}) }];
    }
    return [404, { error: "not_found", error_description: `slicetest's issuer serves /.well-known/openid-configuration, /.well-known/jwks.json and POST /token, not ${req.method} ${path}` }];
  }

  async close() {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

async function text(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}
