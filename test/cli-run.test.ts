import path from "node:path";
import { expect, test } from "vitest";
import { runOptions } from "../src/cli-run.js";

test("run flags become Vitest options, with the output file taken from where the command runs", () => {
  const cwd = path.resolve("/work");
  expect(runOptions({}, cwd)).toEqual({});
  expect(runOptions({ update: true, reporter: ["junit", "default"], "output-file": "out/junit.xml", shard: "2/3" }, cwd)).toEqual({
    update: true,
    reporters: ["junit", "default"],
    outputFile: path.join(cwd, "out/junit.xml"),
    shard: "2/3",
  });
});

test.each(["x", "0/3", "4/3", "1/"])("rejects --shard %s", (shard) => {
  expect(() => runOptions({ shard })).toThrow(`--shard takes <index>/<count> with 1 ≤ index ≤ count, e.g. --shard 1/3, got "${shard}"`);
});
