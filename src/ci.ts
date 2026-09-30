import { appendFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * GitHub Actions output. Vitest already annotates failing TypeScript tests;
 * YAML scenarios fail inside slicetest's runtime, so their annotations point at
 * the `.scenario.yaml` line here instead. The OpenAPI coverage table also goes
 * to the job summary.
 */

export const onGitHub = (env = process.env) => env.GITHUB_ACTIONS === "true";

export interface YamlFailure {
  /** Absolute path of the scenario file. */
  file: string;
  line: number;
  scenario: string;
  step: string;
  message: string;
}

/** `::error file=…,line=…,title=…::message`, escaped as the runner expects. */
export function annotation(level: "error" | "warning", message: string, props: { file?: string; line?: number; title?: string } = {}) {
  const prop = (v: string) => v.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
  const data = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const list = Object.entries(props)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${prop(String(v))}`)
    .join(",");
  return `::${level}${list ? ` ${list}` : ""}::${data}`;
}

/** Paths in annotations are relative to the repository checkout. */
export function repoPath(file: string, env = process.env) {
  return path.relative(env.GITHUB_WORKSPACE ?? process.cwd(), file).replace(/\\/g, "/");
}

/** Called in a worker: one JSON line per failed YAML step, printed by the main process at the end. */
export async function recordYamlFailure(dir: string, failure: YamlFailure) {
  await appendFile(path.join(dir, `${process.pid}.jsonl`), `${JSON.stringify(failure)}\n`);
}

export async function yamlFailures(dir: string): Promise<YamlFailure[]> {
  const out: YamlFailure[] = [];
  for (const f of await readdir(dir).catch(() => [])) {
    for (const line of (await readFile(path.join(dir, f), "utf8")).split("\n")) if (line) out.push(JSON.parse(line) as YamlFailure);
  }
  return out;
}

export function failureAnnotations(failures: YamlFailure[], env = process.env) {
  return failures.map((f) => annotation("error", f.message, { file: repoPath(f.file, env), line: f.line, title: `${f.scenario}: ${f.step}` }));
}

export function failureSummary(failures: YamlFailure[], env = process.env) {
  if (failures.length === 0) return "";
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  return [
    `### slicetest: ${failures.length} failed YAML step(s)`,
    "",
    "| Where | Scenario | Step | Error |",
    "|---|---|---|---|",
    ...failures.map((f) => `| \`${repoPath(f.file, env)}:${f.line}\` | ${cell(f.scenario)} | ${cell(f.step)} | ${cell(f.message.split("\n")[0]!.slice(0, 300))} |`),
    "",
  ].join("\n");
}

export async function appendSummary(markdown: string, env = process.env) {
  if (!markdown || !env.GITHUB_STEP_SUMMARY) return;
  await appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n`).catch(() => {});
}
