import { expect, test } from "vitest";
import { mask } from "../src/trace.js";

test("mask replaces dates and UUIDs at any depth, and leaves everything else alone", () => {
  const value = {
    id: 7,
    created_at: new Date(),
    sent: "2026-09-30T10:00:00.123Z",
    day: "2026-09-30",
    local: "2026-09-30 10:00:00+09:00",
    ref: "4f9d2c1e-8b3a-4c6d-9e2f-1a2b3c4d5e6f",
    nested: [{ at: "2026-09-30T10:00:00Z", text: "2026 was a year" }],
    big: 10n,
    none: null,
  };
  expect(mask(value)).toEqual({
    id: 7,
    created_at: "[date]",
    sent: "[date]",
    day: "[date]",
    local: "[date]",
    ref: "[uuid]",
    nested: [{ at: "[date]", text: "2026 was a year" }],
    big: "10",
    none: null,
  });
});

test("mask also hides chosen keys and patterns", () => {
  expect(mask({ token: "abc", user: { token: "def", name: "x" }, empty: { token: null }, key: "tok_123" }, { keys: ["token"], patterns: [/^tok_\w+$/g] })).toEqual({
    token: "[masked]",
    user: { token: "[masked]", name: "x" },
    empty: { token: null },
    key: "[masked]",
  });
});
