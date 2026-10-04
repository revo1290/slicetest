import { expect, test } from "vitest";
import { loadContainers, nodeTooOldForContainers } from "../src/container-runtime.js";

test.each([
  ["20.20.2", true],
  ["22.21.1", true],
  ["22.22.0", false],
  ["24.13.0", false],
  ["26.0.0", false],
])("Node %s is too old for Testcontainers: %s", (version, old) => {
  expect(nodeTooOldForContainers(version)).toBe(old);
});

test("a container library that won't load on an old Node says so, and where to go instead", async () => {
  const broken = () => Promise.reject(new TypeError("webidl.util.markAsUncloneable is not a function"));

  const err = await loadContainers(broken, "20.20.2").catch((e: Error) => e);

  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("Node.js 20.20.2 can't load the container library (webidl.util.markAsUncloneable is not a function)");
  expect((err as Error).message).toContain("needs Node.js 22.22 or later");
  expect((err as Error).message).toContain("SLICETEST_DATABASE_URL");
});

test("on a current Node the original error and the loaded module pass through untouched", async () => {
  const boom = new Error("Cannot find package");
  await expect(loadContainers(() => Promise.reject(boom), "24.13.0")).rejects.toBe(boom);
  await expect(loadContainers(async () => ({ ok: 1 }), "20.20.2")).resolves.toEqual({ ok: 1 });
});
