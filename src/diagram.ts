import type { Changes } from "./db.js";
import { describeGraphQL } from "./graphql.js";
import type { HttpResponse } from "./http.js";
import type { Mailbox } from "./mail.js";
import type { RecordedCall, Stub } from "./stub.js";
import { timeline } from "./timeline.js";

/**
 * A Mermaid sequence diagram of what a scenario did: each request to the app,
 * the stub calls the app made while answering it, the mail it sent and the
 * database tables it changed. GitHub, GitLab and most Markdown viewers render it.
 */
export function sequenceDiagram(history: readonly HttpResponse[], stubs: Iterable<Stub>, changes: Changes | undefined, mailbox?: Mailbox): string {
  type Event = { at: number; order: number; line: string };
  const events: Event[] = [];
  const participants = new Map<string, string>();
  const id = (name: string, label: string) => {
    const key = `s_${name.replace(/[^A-Za-z0-9_]/g, "_")}`;
    if (!participants.has(key)) participants.set(key, label);
    return key;
  };
  let order = 0;
  const add = (at: number, line: string) => events.push({ at, order: order++, line });

  for (const res of history) {
    const t = timeline.get(res) ?? { start: Infinity, end: Infinity };
    const external = /^https?:/.test(res.url);
    const target = external ? id(`ext_${new URL(res.url).host}`, new URL(res.url).host) : "app";
    const path = external ? new URL(res.url).pathname : res.url;
    add(t.start, `test->>+${target}: ${text(`${res.method} ${path}`)}`);
    add(t.end ?? t.start, `${target}-->>-test: ${res.status || "failed"}${summary(res)}`);
  }
  for (const stub of stubs) {
    for (const call of stub.calls()) {
      const t = timeline.get(call) ?? { start: Infinity };
      const s = id(stub.name, `${stub.name} (stub)`);
      add(t.start, `app->>+${s}: ${text(describeCall(call))}`);
      const reply = call.fault === "reset" ? "connection dropped" : call.response ? `${call.response.status}${call.fault ? " (chaos)" : ""}` : call.matched ? "no answer" : "501 no stub";
      add(t.end ?? t.start, `${s}-->>-app: ${reply}`);
    }
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order);

  const lines = ["sequenceDiagram", "  participant test as scenario", "  participant app"];
  for (const [key, label] of participants) lines.push(`  participant ${key} as ${text(label)}`);
  if (mailbox && mailbox.messages().length) lines.push("  participant mail");
  const tables = Object.entries(changes ?? {}).filter(([, c]) => c.inserted.length || c.updated.length || c.deleted.length);
  if (tables.length) lines.push("  participant db as database");
  for (const e of events) lines.push(`  ${e.line}`);
  for (const m of mailbox?.messages() ?? []) lines.push(`  app->>mail: ${text(`${m.subject} to ${m.to.join(", ")}`)}`);
  if (tables.length) {
    const counts = tables.map(([table, c]) => `${table} ${[c.inserted.length && `+${c.inserted.length}`, c.updated.length && `~${c.updated.length}`, c.deleted.length && `-${c.deleted.length}`].filter(Boolean).join(" ")}`);
    lines.push(`  Note over app,db: ${text(counts.join(", "))}`);
  }
  return lines.join("\n");
}

function describeCall(call: RecordedCall) {
  if (call.graphql) return describeGraphQL(call.graphql);
  return `${call.method} ${call.path}`;
}

/** A short hint of the response: a JSON error message or the id it created. */
function summary(res: HttpResponse) {
  const j = res.json;
  if (j && typeof j === "object" && !Array.isArray(j)) {
    for (const key of ["error", "message", "id"]) {
      const v = (j as Record<string, unknown>)[key];
      if (typeof v === "string" || typeof v === "number") return ` ${text(`${key}: ${v}`)}`;
    }
  }
  return "";
}

/** Mermaid ends a message at `;` and reads `#…;` as an entity, so both are escaped; long text is cut. */
function text(s: string, max = 70) {
  const cut = s.length > max ? `${s.slice(0, max - 1)}…` : s;
  return cut.replace(/[\r\n]+/g, " ").replace(/[#;]/g, (c) => (c === "#" ? "#35;" : "#59;"));
}

/** Scenario diagrams per test file, for `SLICETEST_DIAGRAMS` / `--diagrams`: one Markdown page per file, in run order. */
const pages = new Map<string, { title: string; sections: Map<string, string> }>();

export function diagramPage(file: string, title: string, scenario: string, diagram: string, failed: boolean) {
  const page = pages.get(file) ?? { title, sections: new Map() };
  pages.set(file, page);
  page.sections.set(scenario, [`## ${scenario}${failed ? " (failed)" : ""}`, "", "```mermaid", diagram, "```", ""].join("\n"));
  return [`# ${page.title}`, "", `Sequence diagrams of the scenarios in \`${page.title}\`, written by slicetest. Regenerated on every run.`, "", ...page.sections.values()].join("\n");
}

/** A collapsed section for the GitHub Actions job summary. */
export function failureDiagram(where: string, scenario: string, diagram: string) {
  const name = scenario.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
  return [`<details><summary>✗ ${name} <code>${where}</code>: what happened</summary>`, "", "```mermaid", diagram, "```", "", "</details>", ""].join("\n");
}
