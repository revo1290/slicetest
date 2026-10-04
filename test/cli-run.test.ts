import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { packageVersion, parseCliArgs, runOptions } from "../src/cli-run.js";

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

test("--version and -v are options, and the version is the package's", async () => {
  const { values } = parseCliArgs(["-v"]);
  expect(values.version).toBe(true);
  expect(parseCliArgs(["--version"]).values.version).toBe(true);
  expect(await packageVersion()).toBe(JSON.parse(await readFile(path.join(import.meta.dirname, "../package.json"), "utf8")).version);
});

test("an unknown option is named, with the nearest one, instead of node's wording", () => {
  expect(() => parseCliArgs(["--tags", "smoke"])).toThrow("slicetest: unknown option --tags; did you mean --tag? (see npx slicetest --help)");
  expect(() => parseCliArgs(["--reporters", "junit"])).toThrow("did you mean --reporter?");
  expect(() => parseCliArgs(["--zzzzzz"])).toThrow("slicetest: unknown option --zzzzzz (see npx slicetest --help)");
  expect(() => parseCliArgs(["--config"])).toThrow(/^slicetest: .*argument missing/);
});
