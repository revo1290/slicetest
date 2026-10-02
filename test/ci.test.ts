import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { annotation, failureAnnotations, failureSummary } from "../src/ci.js";
import { runFailingFixture } from "./run-fixture.js";

test("annotations escape what the runner would otherwise misread", () => {
  expect(annotation("error", "50% done\nnext line", { file: "a,b.yaml", line: 3, title: "x: y" })).toBe("::error file=a%2Cb.yaml,line=3,title=x%3A y::50%25 done%0Anext line");
  expect(annotation("warning", "plain")).toBe("::warning::plain");
});

test("failed YAML steps become annotations on their line and a table in the job summary", () => {
  const failures = [{ file: "/repo/scenarios/a.scenario.yaml", line: 12, scenario: "votes | counts", step: "step 2: GET /", message: "expected 200\ngot 500" }];
  const env = { GITHUB_WORKSPACE: "/repo" };
  expect(failureAnnotations(failures, env)).toEqual(["::error file=scenarios/a.scenario.yaml,line=12,title=votes | counts%3A step 2%3A GET /::expected 200%0Agot 500"]);
  expect(failureSummary(failures, env)).toContain("| `scenarios/a.scenario.yaml:12` | votes \\| counts | step 2: GET / | expected 200 |");
  expect(failureSummary([], env)).toBe("");
});

test("on GitHub Actions, a failing YAML scenario is annotated at its file and line, and summarised", async () => {
  const summary = path.join(await mkdtemp(path.join(os.tmpdir(), "slicetest-summary-")), "summary.md");
  const root = path.join(import.meta.dirname, "..");
  const output = await runFailingFixture("failing", { GITHUB_ACTIONS: "true", GITHUB_WORKSPACE: root, GITHUB_STEP_SUMMARY: summary });
  expect(output).toMatch(/^::error file=test\/fixtures\/failing\/failing\.scenario\.yaml,line=4,title=yaml wrong status%3A step 1%3A GET \/::.*expected GET \/ to respond 201, got 200/m);
  const md = await readFile(summary, "utf8");
  expect(md).toContain("failed YAML step(s)");
  expect(md).toContain("`test/fixtures/failing/failing.scenario.yaml:4`");
  // Every failed scenario, TypeScript or YAML, with a sequence diagram of what it did.
  expect(md).toContain("<details><summary>✗ yaml wrong status <code>failing.scenario.yaml</code>: what happened</summary>\n\n```mermaid\nsequenceDiagram");
}, 120_000);

test("the OpenAPI coverage table has a Markdown form for the job summary", async () => {
  const { OpenApiSpec, formatCoverage } = await import("../src/openapi.js");
  const spec = await OpenApiSpec.load(path.join(import.meta.dirname, "../examples/openapi.yaml"), "openapi.yaml");
  const [first, ...rest] = spec.responseKeys();
  const report = formatCoverage(spec, new Set([first!]));
  expect(report.markdown).toContain(`### slicetest: OpenAPI coverage ${report.percent}%`);
  expect(report.markdown).toContain(`1 of ${rest.length + 1} documented responses in \`openapi.yaml\``);
  expect(report.markdown).toMatch(/\| `\w+ \/\S*` \| ✅ \d{3}/);
  expect(report.markdown).toContain("❌");
});
