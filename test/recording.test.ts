import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { mergeRecordings, readRecordings, Recorder } from "../src/recording.js";
import { Stub } from "../src/stub.js";

const exec = promisify(execFile);
let upstream: http.Server;
let upstreamUrl = "";
const seen: { url: string; auth?: string; host?: string; body: string }[] = [];
let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "slicetest-rec-test-"));
  upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({ url: req.url!, auth: req.headers.authorization, host: req.headers.host, body });
    const url = new URL(req.url!, "http://x");
    if (url.searchParams.get("city") === "atlantis") return res.writeHead(404, { "content-type": "text/plain", "set-cookie": "s=1" }).end("unknown city");
    res.writeHead(200, { "content-type": "application/json", date: "Tue, 29 Sep 2026 00:00:00 GMT", "x-request-id": "abc" });
    res.end(JSON.stringify(url.pathname.endsWith("/counter") ? { n: seen.length } : { city: url.searchParams.get("city"), temp: 21 }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
  await rm(dir, { recursive: true, force: true });
});

async function stubWith(recorder: Recorder) {
  const stub = await Stub.start("svc");
  stub.fallback((call) => recorder.answer(call), recorder.hint());
  return stub;
}

test("in record mode, unrouted calls go to the upstream (under its path prefix) and are recorded without noisy headers", async () => {
  const recorder = await Recorder.load("svc", path.join(dir, "a.yaml"), `${upstreamUrl}/v2`, true);
  const stub = await stubWith(recorder);
  try {
    const res = await fetch(`${stub.url}/forecast?city=osaka&b=2`, { headers: { authorization: "Bearer t" } });
    expect(await res.json()).toEqual({ city: "osaka", temp: 21 });
    expect(seen.at(-1)).toMatchObject({ url: "/v2/forecast?city=osaka&b=2", auth: "Bearer t", host: new URL(upstreamUrl).host });
    expect(recorder.added()).toEqual([
      {
        request: { method: "GET", path: "/forecast", query: { b: "2", city: "osaka" } },
        response: { status: 200, headers: { "content-type": "application/json" }, json: { city: "osaka", temp: 21 } },
      },
    ]);
  } finally {
    await stub.close();
  }
});

test("replay answers from the recordings, in order for identical requests, and explains a miss", async () => {
  const file = path.join(dir, "b.yaml");
  await mergeRecordings(file, upstreamUrl, [
    { request: { method: "POST", path: "/counter", json: { a: 1, b: 2 } }, response: { status: 200, json: { n: 1 } } },
    { request: { method: "POST", path: "/counter", json: { a: 1, b: 2 } }, response: { status: 200, json: { n: 2 } } },
  ]);
  const recorder = await Recorder.load("svc", file, upstreamUrl, false);
  const stub = await stubWith(recorder);
  const post = (json: unknown) => fetch(`${stub.url}/counter`, { method: "POST", body: JSON.stringify(json) }).then((r) => r.json());
  try {
    const before = seen.length;
    // Key order in the JSON body doesn't matter.
    expect(await post({ b: 2, a: 1 })).toEqual({ n: 1 });
    expect(await post({ a: 1, b: 2 })).toEqual({ n: 2 });
    expect(await post({ a: 1, b: 2 })).toEqual({ n: 2 });
    recorder.reset();
    expect(await post({ a: 1, b: 2 })).toEqual({ n: 1 });
    expect(seen.length).toBe(before);

    const miss = await fetch(`${stub.url}/counter`, { method: "POST", body: "{}" });
    expect(miss.status).toBe(501);
    expect(await miss.text()).toBe(`slicetest: no stub for POST /counter (no recording in ${file} either; run with SLICETEST_RECORD=svc to record it from ${upstreamUrl})`);
  } finally {
    await stub.close();
  }
});

test("merging skips exact duplicates and writes a commented YAML list", async () => {
  const file = path.join(dir, "c.yaml");
  const e = { request: { method: "GET", path: "/x" }, response: { status: 204 } };
  await mergeRecordings(file, upstreamUrl, [e]);
  await mergeRecordings(file, upstreamUrl, [e, { ...e, response: { status: 200, body: "hi" } }]);
  expect(await readRecordings(file)).toEqual([e, { ...e, response: { status: 200, body: "hi" } }]);
  expect(await readFile(file, "utf8")).toMatch(/^# Recorded by slicetest from http/);

  await writeFile(file, "just: a map\n");
  await expect(readRecordings(file)).rejects.toThrow(`${file} is not a recordings file`);
});

test("a fixture records against the real service once, then replays with the service gone", async () => {
  const root = path.join(import.meta.dirname, "..");
  const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
  const config = path.join(import.meta.dirname, "fixtures/recording/vitest.config.ts");
  const file = path.join(dir, "weather.yaml");
  const run = (env: Record<string, string>) =>
    exec(process.execPath, [vitest, "run", "--config", config], { cwd: root, env: { ...process.env, RECORDINGS_FILE: file, ...env } });

  const recorded = await run({ SLICETEST_RECORD: "weather", UPSTREAM_URL: upstreamUrl });
  expect(recorded.stdout).toContain(`slicetest: recorded 2 call(s) to ${upstreamUrl}`);
  const saved = await readFile(file, "utf8");
  expect(saved).not.toMatch(/real-token|set-cookie|x-request-id|date:/i);
  const entries = await readRecordings(file);
  expect(entries).toHaveLength(2);
  expect(entries).toEqual(
    expect.arrayContaining([
      { request: { method: "GET", path: "/forecast", query: { city: "atlantis" } }, response: { status: 404, headers: { "content-type": "text/plain" }, body: "unknown city" } },
      { request: { method: "GET", path: "/forecast", query: { city: "tokyo" } }, response: { status: 200, headers: { "content-type": "application/json" }, json: { city: "tokyo", temp: 21 } } },
    ]),
  );

  const before = seen.length;
  // No upstream now (the default points at a closed port): everything comes from the file.
  const replayed = await run({ UPSTREAM_URL: "" });
  expect(replayed.stdout).not.toContain("recorded");
  expect(seen.length).toBe(before);
  expect(await readFile(file, "utf8")).toBe(saved);
}, 120_000);
