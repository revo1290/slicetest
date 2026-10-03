import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { formatList, listScenarios } from "../src/list.js";

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "slicetest-list-"));
  await mkdir(path.join(root, "scenarios"));
  await mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
  await writeFile(
    path.join(root, "scenarios/polls.scenario.yaml"),
    `setup:\n  - checkpoint: true\nscenarios:\n  - name: create\n    tags: [smoke]\n    steps: [{ request: POST /polls }]\n  - name: vote {{c}}\n    each: [{ c: a }, { c: b }]\n    steps: [{ request: POST /v }]\n  - name: later\n    skip: true\n    steps: [{ checkpoint: true }]\n`,
  );
  await writeFile(path.join(root, "scenarios/broken.scenario.yaml"), "scenarios:\n  - name: x\n    steps:\n      - reqest: GET /\n");
  await writeFile(path.join(root, "node_modules/pkg/x.scenario.yaml"), "scenarios: []\n");
  return root;
}

test("lists scenarios with their line, tags, rows and status, and the files that don't parse", async () => {
  const root = await project();
  const listed = await listScenarios(root, { tags: "smoke" });

  expect(listed.scenarios).toEqual([
    { file: "scenarios/polls.scenario.yaml", line: 4, name: "create", tags: ["smoke"], status: "run", rows: 1, steps: 2 },
    { file: "scenarios/polls.scenario.yaml", line: 7, name: "vote {{c}}", tags: [], status: "filtered", rows: 2, steps: 2 },
    { file: "scenarios/polls.scenario.yaml", line: 10, name: "later", tags: [], status: "skip", rows: 1, steps: 2 },
  ]);
  expect(listed.errors).toEqual([expect.stringContaining("scenarios/broken.scenario.yaml:4")]);
  expect(formatList(listed)).toContain("  · vote {{c}} ×2  (line 7, 2 steps)");
  expect(formatList(listed)).toContain("3 scenario(s) in 1 file(s); 1 run(s) selected.");
});

test("filters by file and name like a run does", async () => {
  const root = await project();
  const listed = await listScenarios(root, { filters: ["polls"], name: "^vote" });
  expect(listed.scenarios.map((s) => [s.name, s.status])).toEqual([["create", "filtered"], ["vote {{c}}", "run"], ["later", "skip"]]);
  expect(listed.errors).toEqual([]);
});
