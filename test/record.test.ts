import { expect, test } from "vitest";
import { parse } from "yaml";
import { buildScenario, type Exchange } from "../src/record.js";
import type { RecordedCall } from "../src/stub.js";
import { parseScenarioFile } from "../src/yaml.js";

const x = (method: string, path: string, status: number, response: unknown, body?: unknown): Exchange => ({
  method,
  path,
  contentType: body === undefined ? undefined : "application/json",
  body: body === undefined ? "" : JSON.stringify(body),
  status,
  responseType: typeof response === "string" ? "text/plain" : "application/json",
  response: typeof response === "string" ? response : JSON.stringify(response),
});

const call = (method: string, path: string, status: number, body: string): RecordedCall =>
  ({ method, path, query: new URLSearchParams(), headers: {}, body: "", json: undefined, params: {}, matched: false, fallback: true, response: { status, headers: { "content-type": "application/json" }, body } }) as RecordedCall;

test("a session becomes stubs, requests with loosened expectations, captures, received calls and change counts", () => {
  const id = "0b7e6c1e-5f2a-4c7e-9a51-3f1d2e4c5b6a";
  const { yaml, summary } = buildScenario(
    [
      x("POST", "/orders", 201, { id, createdAt: "2026-10-01T08:00:00Z", total: 1200 }, { sku: "A-1" }),
      x("GET", "/assets/app.js", 200, "console.log(1)"),
      x("POST", `/orders/${id}/pay`, 200, "paid", { token: "tok_visa" }),
      x("GET", `/orders/${id}`, 200, { id, status: "paid" }),
    ],
    { stripe: [call("POST", "/v1/charges", 200, '{"id":"ch_1"}'), call("POST", "/v1/charges", 402, '{"error":"declined"}')], mail: [] },
    { orders: { inserted: [{ id }], updated: [{ key: { id }, before: {}, after: {}, changed: [] }], deleted: [] } },
    { name: "checkout", now: new Date("2026-10-01T00:00:00Z") },
  );
  expect(summary).toEqual({ requests: 3, skippedAssets: 1, stubs: 1, tables: ["orders"], unanswered: [] });
  expect(yaml).toMatch(/^# Recorded with `npx slicetest record` on 2026-10-01/);
  expect(parse(yaml).scenarios[0]).toEqual({
    name: "checkout",
    steps: [
      { stub: "stripe", on: "POST /v1/charges", sequence: [{ status: 200, body: { id: "ch_1" } }, { status: 402, body: { error: "declined" } }] },
      {
        request: "POST /orders",
        json: { sku: "A-1" },
        expect: { status: 201, json: { id: { $type: "string" }, createdAt: { $type: "string" }, total: 1200 } },
        capture: { id: "json.id" },
      },
      { request: "POST /orders/{{id}}/pay", json: { token: "tok_visa" }, expect: { status: 200, text: "paid" } },
      { request: "GET /orders/{{id}}", expect: { status: 200, json: { id: { $type: "string" }, status: "paid" } } },
      { received: "stripe", call: "POST /v1/charges", times: 2 },
      { changes: { orders: { inserted: 1, updated: 1 } } },
    ],
  });
  // What record writes is a valid scenario file.
  expect(() => parseScenarioFile(yaml, "recorded.scenario.yaml")).not.toThrow();
});

test("calls no stub answered are listed for the user instead of recorded", () => {
  const { yaml, summary } = buildScenario([x("POST", "/signup", 502, { error: "upstream" }, { email: "a@b.c" })], { crm: [call("POST", "/contacts", 501, "")] }, {});
  expect(summary.unanswered).toEqual(["crm: POST /contacts"]);
  expect(yaml).toContain("# - These calls got no answer while recording (register a route, or give the stub an upstream / autoReply): crm: POST /contacts");
  expect(parse(yaml).scenarios[0].steps.some((s: Record<string, unknown>) => "stub" in s)).toBe(false);
});
