import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Interceptor } from "../src/intercept.js";
import { Authority } from "../src/x509.js";

const exec = promisify(execFile);

// Answers with what it was asked, so a test sees the host and path the client used.
const stub = http.createServer((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ host: req.headers.host, path: req.url })));
let interceptor: Interceptor;

beforeAll(async () => {
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const port = (stub.address() as net.AddressInfo).port;
  interceptor = await Interceptor.start(new Map([["api.weather.test", { attach: (s: net.Socket) => stub.emit("connection", s), port }]]));
});
afterAll(async () => {
  await interceptor.close();
  stub.close();
});

/** Runs a client in a child process with the environment the app would get. Async: the proxy lives in this process. */
async function client(cmd: string, args: string[]) {
  const { stdout } = await exec(cmd, args, { env: { ...process.env, ...interceptor.env() }, timeout: 60_000 });
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}
const available = async (cmd: string, args: string[]) => exec(cmd, args).then(() => true, () => false);

test("the CA and host certificates pass strict verification", () => {
  const ca = new Authority();
  const caCert = new X509Certificate(ca.pem);
  const leaf = new X509Certificate(ca.leaf("api.github.com").pem);

  expect(caCert.ca).toBe(true);
  expect(leaf.checkIssued(caCert) && leaf.verify(caCert.publicKey)).toBe(true);
  expect(leaf.checkHost("api.github.com")).toBe("api.github.com");
  expect(leaf.checkHost("github.com")).toBeUndefined();
  expect(ca.leaf("api.github.com")).toBe(ca.leaf("api.github.com"));
});

test("Node's fetch reaches the stub for an intercepted host, over HTTPS and plain HTTP", async () => {
  const fetchIt = (url: string) => client(process.execPath, ["-e", `fetch(${JSON.stringify(url)}).then(r => r.text()).then(console.log)`]);

  expect(await fetchIt("https://api.weather.test/v1/now?city=tokyo")).toEqual({ host: "api.weather.test", path: "/v1/now?city=tokyo" });
  expect(await fetchIt("http://api.weather.test/v1/now")).toEqual({ host: "api.weather.test", path: "/v1/now" });
});

test.runIf(await available("python3", ["--version"]))("Python's urllib trusts the test CA through SSL_CERT_FILE", async () => {
  const py = "import urllib.request; print(urllib.request.urlopen('https://api.weather.test/v1/now').read().decode())";
  expect(await client("python3", ["-c", py])).toEqual({ host: "api.weather.test", path: "/v1/now" });
});

test.runIf(await available("java", ["-version"]))("the JVM goes through the proxy and trusts the PKCS#12 store, with HttpURLConnection and HttpClient", async () => {
  const dir = path.join(os.tmpdir(), `slicetest-java-${process.pid}`);
  const source = path.join(dir, "Probe.java");
  await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
  await (await import("node:fs/promises")).writeFile(
    source,
    `import java.net.*; import java.net.http.*;
public class Probe { public static void main(String[] a) throws Exception {
  var u = URI.create("https://api.weather.test/v1/now");
  var c = (HttpURLConnection) u.toURL().openConnection();
  String one = new String(c.getInputStream().readAllBytes());
  String two = HttpClient.newHttpClient().send(HttpRequest.newBuilder(u).build(), HttpResponse.BodyHandlers.ofString()).body();
  System.out.println(one.equals(two) ? two : "different: " + one + " / " + two);
} }`,
  );
  expect(await client("java", [source])).toEqual({ host: "api.weather.test", path: "/v1/now" });
});

test("other hosts are tunnelled untouched and listed", async () => {
  // A TLS server standing in for some real API on the internet.
  const ca = new Authority();
  const real = tls.createServer({ key: ca.leaf("localhost").key.export({ type: "pkcs8", format: "pem" }), cert: ca.leaf("localhost").pem }, (s) => s.end("real"));
  await new Promise<void>((r) => real.listen(0, "127.0.0.1", r));
  const port = (real.address() as net.AddressInfo).port;

  const proxy = net.connect(Number(new URL(interceptor.url).port), "127.0.0.1");
  proxy.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  await new Promise((r) => proxy.once("data", r));
  const secure = tls.connect({ socket: proxy, servername: "localhost", ca: ca.pem });
  const body = await new Promise<string>((resolve) => secure.on("data", (d) => resolve(String(d))));

  expect(body).toBe("real");
  expect(secure.getPeerCertificate().subject.CN).toBe("localhost");
  expect([...interceptor.passedThrough]).toContain("127.0.0.1");
  secure.destroy();
  real.close();
});

test("the environment covers the common runtimes, keeps an existing JAVA_TOOL_OPTIONS and bypasses localhost", async () => {
  const env = interceptor.env({ JAVA_TOOL_OPTIONS: "-Xmx256m" });

  expect(env).toMatchObject({ HTTPS_PROXY: interceptor.url, https_proxy: interceptor.url, NODE_USE_ENV_PROXY: "1", NO_PROXY: "localhost,127.0.0.1,::1" });
  expect(env.JAVA_TOOL_OPTIONS).toMatch(/^-Xmx256m -Dhttp\.proxyHost=127\.0\.0\.1 /);
  expect(env.JAVA_TOOL_OPTIONS).toContain(`-Djavax.net.ssl.trustStore=${interceptor.files.trustStore}`);
  const bundle = await readFile(env.SSL_CERT_FILE!, "utf8");
  expect(bundle.startsWith(await readFile(env.NODE_EXTRA_CA_CERTS!, "utf8"))).toBe(true);
  expect(bundle.match(/BEGIN CERTIFICATE/g)!.length).toBe(tls.rootCertificates.length + 1);
});

test("*.domain covers every subdomain but not the domain; exact names win", async () => {
  const { lookupHost } = await import("../src/intercept.js");
  const map = new Map([["*.connpass.com", "groups"], ["connpass.com", "site"], ["api.connpass.com", "api"]]);

  expect(lookupHost(map, "findy.connpass.com")).toBe("groups");
  expect(lookupHost(map, "a.b.Connpass.com")).toBe("groups");
  expect(lookupHost(map, "connpass.com")).toBe("site");
  expect(lookupHost(map, "api.connpass.com")).toBe("api");
  expect(lookupHost(map, "connpass.com.evil.test")).toBeUndefined();
  expect(lookupHost(new Map([["*.connpass.com", 1]]), "connpass.com")).toBeUndefined();
});

test("offline refuses hosts no stub answers, over CONNECT and plain HTTP, and lists them", async () => {
  interceptor.offline = true;
  try {
    const port = Number(new URL(interceptor.url).port);
    const proxy = net.connect(port, "127.0.0.1");
    proxy.write("CONNECT api.real.test:443 HTTP/1.1\r\nHost: api.real.test:443\r\n\r\n");
    expect(String(await new Promise((r) => proxy.once("data", r)))).toMatch(/^HTTP\/1\.1 403/);
    proxy.destroy();

    const plain = await new Promise<http.IncomingMessage>((resolve) => http.get({ host: "127.0.0.1", port, path: "http://plain.real.test/x" }, resolve));
    expect(plain.statusCode).toBe(403);
    // Stubbed hosts still work.
    expect(await client(process.execPath, ["-e", "fetch('https://api.weather.test/ok').then(r => r.text()).then(console.log)"])).toEqual({ host: "api.weather.test", path: "/ok" });
    expect([...interceptor.blocked]).toEqual(["api.real.test", "plain.real.test"]);
  } finally {
    interceptor.offline = false;
    interceptor.blocked.clear();
  }
});
