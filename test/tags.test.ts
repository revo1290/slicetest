import { expect, test } from "vitest";
import { scenario, tagsSelected } from "../src/scenario.js";
import { parseScenarioFile } from "../src/yaml.js";

test("a tag filter selects any of its tags and leaves out !tags", () => {
  expect(tagsSelected([], undefined)).toBe(true);
  expect(tagsSelected(["smoke"], "smoke")).toBe(true);
  expect(tagsSelected(["slow"], "smoke, payments")).toBe(false);
  expect(tagsSelected([], "smoke")).toBe(false);
  expect(tagsSelected(["payments"], "smoke payments")).toBe(true);
  expect(tagsSelected(["smoke", "slow"], "smoke,!slow")).toBe(false);
  expect(tagsSelected([], "!slow")).toBe(true);
});

// Registered while SLICETEST_TAGS leaves them out: they must be skipped, not run (running needs the plugin's runtime).
const saved = process.env.SLICETEST_TAGS;
process.env.SLICETEST_TAGS = "smoke,!slow";
scenario("an untagged scenario is skipped under a tag filter", () => {
  throw new Error("should have been skipped");
});
scenario("an excluded tag is skipped", () => {
  throw new Error("should have been skipped");
}, { tags: ["smoke", "slow"] });
scenario.each([1])("each rows take tags too %s", () => {
  throw new Error("should have been skipped");
}, { tags: ["slow"] });
if (saved === undefined) delete process.env.SLICETEST_TAGS;
else process.env.SLICETEST_TAGS = saved;

test("YAML scenarios take tags, checked when parsed", () => {
  const doc = parseScenarioFile("scenarios:\n  - name: s\n    tags: [smoke, payments]\n    steps: [{ checkpoint: true }]\n", "s.scenario.yaml");
  expect(doc.scenarios[0]!.tags).toEqual(["smoke", "payments"]);
  expect(() => parseScenarioFile("scenarios:\n  - name: s\n    tags: [\"!x\"]\n    steps: [{ checkpoint: true }]\n", "s.scenario.yaml")).toThrow("s.scenario.yaml:3: `tags` must be a list of words");
});
