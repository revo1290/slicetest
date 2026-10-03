import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { tagsSelected } from "./scenario.js";
import { parseScenarioFile } from "./yaml.js";

export interface ListedScenario {
  file: string;
  line: number;
  name: string;
  tags: string[];
  /** `skip`, `only`, or what `--tag` / `-t` leave out. */
  status: "run" | "skip" | "only" | "filtered";
  /** Rows of `each`: the scenario runs once per row. */
  rows: number;
  steps: number;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", "vendor", ".venv", "venv"]);

async function scenarioFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await scenarioFiles(path.join(dir, entry.name), out);
    } else if (/\.scenario\.ya?ml$/.test(entry.name)) out.push(path.join(dir, entry.name));
  }
  return out.sort();
}

/**
 * The YAML scenarios under `root`, without starting anything: for a quick look at what a run
 * would do, which `--tag` / `-t` select, and for tools (`--json`). Files that don't parse are
 * reported in `errors` with their line, as a run would report them.
 */
export async function listScenarios(root: string, opts: { filters?: string[]; name?: string; tags?: string } = {}) {
  const scenarios: ListedScenario[] = [];
  const errors: string[] = [];
  const pattern = opts.name ? new RegExp(opts.name) : undefined;
  for (const file of await scenarioFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (opts.filters?.length && !opts.filters.some((f) => rel.includes(f))) continue;
    try {
      const doc = parseScenarioFile(await readFile(file, "utf8"), rel);
      for (const sc of doc.scenarios) {
        const tags = sc.tags ?? [];
        const selected = tagsSelected(tags, opts.tags) && (!pattern || pattern.test(sc.name));
        scenarios.push({
          file: rel,
          line: sc.line,
          name: sc.name,
          tags,
          status: sc.skip ? "skip" : !selected ? "filtered" : sc.only ? "only" : "run",
          rows: sc.each?.length ?? 1,
          steps: doc.setup.length + sc.steps.length,
        });
      }
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { scenarios, errors };
}

/** One line per scenario, grouped by file. */
export function formatList({ scenarios, errors }: Awaited<ReturnType<typeof listScenarios>>) {
  const lines: string[] = [];
  let file = "";
  for (const s of scenarios) {
    if (s.file !== file) {
      file = s.file;
      lines.push(file);
    }
    const mark = { run: "  ", only: "▶ ", skip: "- ", filtered: "· " }[s.status];
    const rows = s.rows > 1 ? ` ×${s.rows}` : "";
    const tags = s.tags.length ? `  [${s.tags.join(", ")}]` : "";
    lines.push(`  ${mark}${s.name}${rows}${tags}  (line ${s.line}, ${s.steps} steps)`);
  }
  const runs = scenarios.filter((s) => s.status === "run" || s.status === "only").reduce((n, s) => n + s.rows, 0);
  lines.push("", `${scenarios.length} scenario(s) in ${new Set(scenarios.map((s) => s.file)).size} file(s); ${runs} run(s) selected.`);
  if (errors.length) lines.push("", "Files with mistakes:", ...errors.map((e) => `  ${e.split("\n")[0]}`));
  return `${lines.join("\n")}\n`;
}
