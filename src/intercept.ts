/**
 * Catching calls to hosts the app has hard-coded (`https://api.github.com`), so
 * stubs can answer them without the app reading a base URL from its environment.
 *
 * The app is started with the usual proxy variables pointing at this proxy and a
 * throwaway CA in the trust settings each runtime reads (Node, Python, Ruby, Go,
 * curl, the JVM). For an intercepted host the proxy terminates TLS with a
 * certificate from that CA and hands the connection to the stub's HTTP server;
 * every other host is tunnelled through untouched.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { Authority, pemBundle, pemToDer, pkcs12TrustStore } from "./x509.js";

/** Where an intercepted host's calls go: its stub's server (TLS connections) and port (plain HTTP). */
export interface Route {
  attach: (socket: net.Socket) => void;
  port: number;
}

let authority: Authority | undefined;

/** preload/node-proxy.cjs, from src/ and dist/ alike. */
const PRELOAD = fileURLToPath(new URL("../preload/node-proxy.cjs", import.meta.url));

/**
 * The entry of `map` for `host`: an exact name, else the closest `*.domain` pattern
 * (which covers every subdomain, at any depth, but not the domain itself).
 */
export function lookupHost<T>(map: ReadonlyMap<string, T>, host: string): T | undefined {
  host = host.toLowerCase();
  const exact = map.get(host);
  if (exact !== undefined) return exact;
  for (let i = host.indexOf("."); i >= 0; i = host.indexOf(".", i + 1)) {
    const wildcard = map.get(`*${host.slice(i)}`);
    if (wildcard !== undefined) return wildcard;
  }
  return undefined;
}

export class Interceptor {
  /** Hosts the app reached that no stub intercepts, in the order first seen. */
  readonly passedThrough = new Set<string>();
  /** With `offline`, hosts the app tried to reach and was refused. */
  readonly blocked = new Set<string>();
  /** Refuse hosts no stub intercepts instead of passing calls through. */
  offline = false;
  readonly #server: http.Server;
  readonly #sockets = new Set<net.Socket>();
  readonly #contexts = new Map<string, tls.SecureContext>();

  private constructor(
    server: http.Server,
    readonly routes: ReadonlyMap<string, Route>,
    readonly files: { dir: string; ca: string; bundle: string; trustStore: string },
  ) {
    this.#server = server;
  }

  get url() {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  /** `routes` maps lower-case host names to the stub that answers for them. */
  static async start(routes: ReadonlyMap<string, Route>) {
    authority ??= new Authority();
    const dir = await mkdtemp(path.join(os.tmpdir(), "slicetest-intercept-"));
    const files = { dir, ca: path.join(dir, "ca.pem"), bundle: path.join(dir, "ca-bundle.pem"), trustStore: path.join(dir, "truststore.p12") };
    await writeFile(files.ca, authority.pem);
    await writeFile(files.bundle, pemBundle(tls.rootCertificates, authority.pem));
    const roots = tls.rootCertificates.flatMap((pem, i) => {
      const der = pemToDer(pem);
      return der ? [{ alias: `root-${i}`, der }] : [];
    });
    await writeFile(files.trustStore, pkcs12TrustStore([{ alias: "slicetest-ca", der: authority.der }, ...roots]));

    const server = http.createServer();
    const interceptor = new Interceptor(server, routes, files);
    server.on("request", (req, res) => interceptor.#plain(req, res));
    server.on("connect", (req, socket, head) => interceptor.#tunnel(req, socket as net.Socket, head));
    server.on("connection", (s) => {
      interceptor.#sockets.add(s);
      s.on("close", () => interceptor.#sockets.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return interceptor;
  }

  /**
   * The environment that sends a process's outbound HTTP(S) through the proxy and
   * makes it trust the CA. Calls to localhost (the stubs' own URLs, the database) bypass it.
   */
  env(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const { port } = new URL(this.url);
    const local = "localhost,127.0.0.1,::1";
    const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
    const java = [
      `-Dhttp.proxyHost=127.0.0.1`,
      `-Dhttp.proxyPort=${port}`,
      `-Dhttps.proxyHost=127.0.0.1`,
      `-Dhttps.proxyPort=${port}`,
      `-Dhttp.nonProxyHosts=localhost|127.0.0.1|[::1]`,
      quote(`-Djavax.net.ssl.trustStore=${this.files.trustStore}`),
      `-Djavax.net.ssl.trustStoreType=PKCS12`,
    ];
    return {
      HTTP_PROXY: this.url,
      HTTPS_PROXY: this.url,
      http_proxy: this.url,
      https_proxy: this.url,
      NO_PROXY: local,
      no_proxy: local,
      // Node 22.21+ / 24.5+ honour the proxy variables for fetch and the default agents with this set;
      // the preload extends that to agents libraries make themselves.
      NODE_USE_ENV_PROXY: "1",
      NODE_OPTIONS: [base.NODE_OPTIONS, `--require ${quote(PRELOAD)}`].filter(Boolean).join(" "),
      NODE_EXTRA_CA_CERTS: this.files.ca,
      // OpenSSL-based runtimes (Python, Ruby, PHP), Go, requests and curl replace their
      // default roots with these files, so the bundle also holds the public roots.
      SSL_CERT_FILE: this.files.bundle,
      REQUESTS_CA_BUNDLE: this.files.bundle,
      CURL_CA_BUNDLE: this.files.bundle,
      JAVA_TOOL_OPTIONS: [base.JAVA_TOOL_OPTIONS, ...java].filter(Boolean).join(" "),
    };
  }

  #context(host: string) {
    let ctx = this.#contexts.get(host);
    if (!ctx) {
      const leaf = authority!.leaf(host);
      ctx = tls.createSecureContext({ key: leaf.key.export({ type: "pkcs8", format: "pem" }), cert: leaf.pem });
      this.#contexts.set(host, ctx);
    }
    return ctx;
  }

  /** `CONNECT host:443`: TLS to a stub for intercepted hosts, a plain tunnel for the rest. */
  #tunnel(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    // "host:port" or "[::1]:port". (Not via URL, which drops a default port such as 80.)
    const at = (req.url ?? "").lastIndexOf(":");
    const host = (req.url ?? "").slice(0, at).replace(/^\[|\]$/g, "").toLowerCase();
    const port = (req.url ?? "").slice(at + 1);
    socket.on("error", () => {});
    const route = lookupHost(this.routes, host);
    if (route) {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.unshift(head);
      // Some clients tunnel plain HTTP too (Node does with NODE_USE_ENV_PROXY): port 80 stays plain.
      if (port === "80") return route.attach(socket);
      const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: this.#context(host), ALPNProtocols: ["http/1.1"] });
      secure.on("error", () => socket.destroy());
      route.attach(secure);
      return;
    }
    if (this.offline) {
      this.blocked.add(host);
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    this.passedThrough.add(host);
    const upstream = net.connect(Number(port) || 443, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
    upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  }

  /** A plain-HTTP proxy request (`GET http://host/path`). */
  #plain(req: http.IncomingMessage, res: http.ServerResponse) {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("slicetest proxy: expected an absolute URL");
      return;
    }
    const host = target.hostname.toLowerCase();
    const route = lookupHost(this.routes, host);
    if (!route && this.offline) {
      this.blocked.add(host);
      res.writeHead(403, { "content-type": "text/plain" }).end(`slicetest: offline, ${host} is not stubbed`);
      return;
    }
    if (!route) this.passedThrough.add(host);
    const forward = http.request(
      {
        method: req.method,
        path: target.pathname + target.search,
        headers: req.headers,
        ...(route ? { host: "127.0.0.1", port: route.port } : { host, port: Number(target.port || 80) }),
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    forward.on("error", () => res.headersSent || res.writeHead(502).end());
    req.pipe(forward);
  }

  async close() {
    for (const s of this.#sockets) s.destroy();
    await new Promise((resolve) => this.#server.close(resolve));
    await rm(this.files.dir, { recursive: true, force: true });
  }
}
