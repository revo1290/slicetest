import { afterEach, expect, test } from "vitest";
import type { TestProject } from "vitest/node";
import { partialRun } from "../src/global-setup.js";

function project({ pattern, shard, files = 2, ran = 2 }: { pattern?: RegExp; shard?: object; files?: number; ran?: number }) {
  return {
    name: "p",
    vitest: { config: { testNamePattern: pattern, shard }, state: { getFiles: () => Array.from({ length: ran }, () => ({ projectName: "p" })) } },
    globTestFiles: async () => ({ testFiles: Array.from({ length: files }, (_, i) => `f${i}`) }),
  } as unknown as TestProject;
}

afterEach(() => {
  delete process.env.SLICETEST_TAGS;
});

test("a run is partial with a name filter, tags, a shard or fewer files than the project has", async () => {
  expect(await partialRun(project({}))).toBeUndefined();
  expect(await partialRun(project({ pattern: /voting/ }))).toBe("only scenarios matching /voting/");
  expect(await partialRun(project({ shard: { index: 1, count: 2 } }))).toBe("one shard");
  expect(await partialRun(project({ files: 3, ran: 1 }))).toBe("1 of 3 files");
  process.env.SLICETEST_TAGS = "smoke";
  expect(await partialRun(project({}))).toBe("only tags smoke");
});

test("a Vitest without these APIs counts as a full run", async () => {
  expect(await partialRun({} as TestProject)).toBeUndefined();
});
