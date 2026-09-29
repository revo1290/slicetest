import { expect, test } from "vitest";
import { interpolate } from "../src/app.js";

test("replaces placeholders", () => {
  expect(interpolate("{{stub.slack}}/hook", { "stub.slack": "http://127.0.0.1:1" })).toBe("http://127.0.0.1:1/hook");
});

test("rejects unknown placeholders and lists the available ones", () => {
  expect(() => interpolate("{{stub.mail}}", { "app.port": "1" }, "app.command")).toThrow(
    "unknown placeholder {{stub.mail}} in app.command. Available: {{app.port}}",
  );
});
