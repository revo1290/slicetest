import { expect, test } from "vitest";
import { requestUrl } from "../src/request-url.js";

test("a request target starting with // is a path on the base, not a host", () => {
  expect(requestUrl("//users/42?x=1", "http://127.0.0.1:9").href).toBe("http://127.0.0.1:9//users/42?x=1");
  expect(requestUrl("/\\evil.test/x", "http://127.0.0.1:9").origin).toBe("http://127.0.0.1:9");
  expect(requestUrl("/a", new URL("http://127.0.0.1:9/base/")).href).toBe("http://127.0.0.1:9/a");
});

test("a proxy-style absolute target and a missing one keep their meaning", () => {
  expect(requestUrl("http://api.test/v1?x=1", "http://127.0.0.1:9").href).toBe("http://api.test/v1?x=1");
  expect(requestUrl(undefined, "http://127.0.0.1:9").href).toBe("http://127.0.0.1:9/");
});
