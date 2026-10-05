import { expect, test } from "vitest";
import type { HttpResponse } from "../src/http.js";
import "../src/matchers.js";

const res = (status: number) => ({ method: "POST", url: "/book", status, headers: new Headers(), text: "", json: undefined, durationMs: 1 }) as HttpResponse;
const all = [201, 409, 409, 429, 503].map(res);

test("toHaveStatuses counts exact codes and classes; each response under its code if listed, else its class", () => {
  expect(all).toHaveStatuses({ 201: 1, 409: 2, 429: 1, 503: 1 });
  expect(all).toHaveStatuses({ "2xx": 1, "4xx": 3, "5xx": 1 });
  expect(all).toHaveStatuses({ 201: 1, 409: 2, "4xx": 1, "5xx": 1 });
  expect(all).not.toHaveStatuses({ "2xx": 1, "4xx": 3 });
  expect(() => expect(all).toHaveStatuses({ "2xx": 1, 409: 2, "5xx": 1 })).toThrow("expected 5 responses to have statuses { 2xx: 1, 409: 2, 5xx: 1 }, got { 2xx: 1, 409: 2, 429: 1, 5xx: 1 }");
  expect(() => expect(all).toHaveStatuses({ "2XX": 1, "4xx": 3, "5xx": 1 } as never)).not.toThrow();
  expect(() => expect(all).toHaveStatuses({ "6xx": 1 } as never)).toThrow('a status is a code (201) or a class ("2xx"), got "6xx"');
});
