import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { importHar, toRecording } from "../src/har.js";
import { Recorder } from "../src/recording.js";
import type { RecordedCall } from "../src/stub.js";

const entry = (method: string, url: string, status: number, body?: unknown, extra: Record<string, unknown> = {}) => ({
  request: { method, url, ...(body !== undefined ? { postData: { mimeType: "application/json", text: JSON.stringify(body) } } : {}) },
  response: {
    status,
    headers: [{ name: "Content-Type", value: "application/json" }, { name: "Set-Cookie", value: "secret=1" }, { name: "Date", value: "x" }],
    content: { mimeType: "application/json", text: JSON.stringify({ ok: status < 400 }) },
  },
  ...extra,
});

const har = {
  log: {
    entries: [
      entry("GET", "https://api.example.com/v2/users/1?b=2&a=1", 200),
      entry("POST", "https://api.example.com/v2/charges", 402, { amount: 5 }),
      entry("OPTIONS", "https://api.example.com/v2/charges", 204),
      entry("GET", "https://api.example.com/v1/old", 200),
      entry("GET", "https://cdn.example.com/logo.png", 200),
      entry("GET", "https://cdn.example.com/app.js", 200),
      { request: { method: "GET", url: "https://api.example.com/v2/avatar" }, response: { status: 200, content: { mimeType: "image/png", encoding: "base64", text: "iVBORw0KGgo=" } } },
      { request: { method: "GET", url: "https://api.example.com/v2/readme" }, response: { status: 200, content: { mimeType: "text/plain", encoding: "base64", text: Buffer.from("hello").toString("base64") } } },
    ],
  },
};

test("entries under the upstream become recordings, without its path prefix or noisy headers", () => {
  expect(toRecording(har.log.entries[0] as never, "https://api.example.com/v2")).toEqual({
    request: { method: "GET", path: "/users/1", query: { a: "1", b: "2" } },
    response: { status: 200, headers: { "content-type": "application/json" }, json: { ok: true } },
  });
  expect(toRecording(har.log.entries[3] as never, "https://api.example.com/v2")).toBe("elsewhere");
  expect(toRecording(har.log.entries[2] as never, "https://api.example.com/v2")).toBe("skipped");
});

test("importHar writes the stub's recordings file, which the stub then replays", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slicetest-har-"));
  const file = path.join(dir, "session.har");
  await writeFile(file, JSON.stringify(har));
  const target = { name: "api", upstream: "https://api.example.com/v2", file: path.join(dir, "recordings/api.yaml") };

  const result = await importHar(file, [target]);

  expect(result.written).toEqual([{ name: "api", file: target.file, count: 3 }]);
  expect(result.skipped).toBe(2);
  // /v1/old is on the same host but outside the upstream's path, so it is listed too.
  expect(result.others).toEqual([["https://cdn.example.com", 2], ["https://api.example.com", 1]]);
  const yaml = await readFile(target.file, "utf8");
  expect(yaml).toMatch(/^# Imported by slicetest from session\.har \(https:\/\/api\.example\.com\/v2\)\./);
  expect(yaml).not.toContain("secret=1");
  expect(yaml).toContain("body: hello");

  const recorder = await Recorder.load("api", target.file, target.upstream, false);
  const call = { method: "POST", path: "/charges", query: new URLSearchParams(), headers: {}, body: '{"amount":5}', json: { amount: 5 }, params: {}, matched: false } as RecordedCall;
  expect(await recorder.answer(call)).toEqual({ status: 402, headers: { "content-type": "application/json" }, body: { ok: false } });

  // Importing again adds nothing that is already there.
  await importHar(file, [target]);
  expect(await readFile(target.file, "utf8")).toBe(yaml);
});

test("a file that isn't a HAR says so", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slicetest-har-"));
  await writeFile(path.join(dir, "x.har"), "{}");
  await expect(importHar(path.join(dir, "x.har"), [])).rejects.toThrow("is not a HAR file (no log.entries)");
});
