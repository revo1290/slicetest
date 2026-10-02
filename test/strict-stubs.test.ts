import { expect, test } from "vitest";
import { runFailingFixture } from "./run-fixture.js";

test("strictStubs fails scenarios whose stub routes were never called, except optional ones", async () => {
  const output = await runFailingFixture("strict-stubs");
  expect(output).toMatch(/✓ .*a route the app calls passes/);
  expect(output).toMatch(/✓ .*an optional route the app doesn't call passes/);
  expect(output).toMatch(/✓ .*yaml optional route/);
  expect(output).toContain("slicetest: stub routes the app never called (strictStubs):\n  pay: POST /charges\nRemove them");
  expect(output).toContain("  pay: POST /refunds");
  expect(output).toContain("Tests  2 failed | 3 passed");
}, 60_000);
