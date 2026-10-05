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

test("lists only the files the config's include selects, as a run does", async () => {
  const root = await project();
  await mkdir(path.join(root, "drafts"));
  await writeFile(path.join(root, "drafts/wip.scenario.yaml"), "scenarios:\n  - name: wip\n    steps: [{ checkpoint: true }]\n");
  const listed = await listScenarios(root, { include: ["scenarios/**/*.scenario.yaml"] });
  expect([...new Set(listed.scenarios.map((s) => s.file))]).toEqual(["scenarios/polls.scenario.yaml"]);
  expect((await listScenarios(root)).scenarios.map((s) => s.file)).toContain("drafts/wip.scenario.yaml");
});

test("-t matches the titles each row runs under, and only leaves out the rest of its file", async () => {
  const root = await project();
  const byRow = await listScenarios(root, { name: "vote b" });
  expect(byRow.scenarios.find((s) => s.line === 7)).toMatchObject({ status: "run", rows: 1 });
  await writeFile(
    path.join(root, "scenarios/focus.scenario.yaml"),
    "scenarios:\n  - name: a\n    steps: [{ checkpoint: true }]\n  - name: b\n    only: true\n    steps: [{ checkpoint: true }]\n",
  );
  const focused = await listScenarios(root, { filters: ["focus"] });
  expect(focused.scenarios.map((s) => [s.name, s.status])).toEqual([["a", "filtered"], ["b", "only"]]);
});
