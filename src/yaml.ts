import { isMap, isSeq, LineCounter, parseDocument, type Node } from "yaml";

/**
 * YAML scenarios: the same things a TypeScript scenario can do, written as
 * data so teams that don't use JavaScript can write them. This module parses
 * and validates a file (in the Vitest main process, where line numbers are
 * known); yaml-runtime.ts runs the result inside a worker.
 */

export interface YamlFile {
  file: string;
  /** Steps run at the start of every scenario in the file. */
  setup: Step[];
  scenarios: YamlScenario[];
}

export interface YamlScenario {
  name: string;
  line: number;
  each?: Record<string, unknown>[];
  skip?: boolean;
  only?: boolean;
  timeout?: number;
  steps: Step[];
}

export type Step = (StubStep | RequestStep | InsertStep | SqlStep | DbStep | ReceivedStep) & { line: number; name?: string };

export interface StubStep {
  stub: string;
  on: string;
  when?: Conditions;
  reply?: { status?: number; headers?: Record<string, string>; body?: unknown };
  sequence?: { status?: number; headers?: Record<string, string>; body?: unknown }[];
  networkError?: boolean;
  times?: number;
  delay?: number;
}

export interface Conditions {
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  json?: unknown;
  body?: unknown;
}

export interface RequestStep {
  request: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  json?: unknown;
  form?: Record<string, unknown>;
  body?: string;
  follow?: boolean;
  expect?: { status?: number; headers?: Record<string, unknown>; json?: unknown; text?: unknown };
  capture?: Record<string, string>;
}

export interface InsertStep {
  insert: string;
  rows: Record<string, unknown> | Record<string, unknown>[];
  capture?: Record<string, string>;
}

export interface SqlStep {
  sql: string;
  params?: unknown[];
  expect?: { rows?: unknown[]; count?: number };
  capture?: Record<string, string>;
}

export interface DbStep {
  db: string;
  where?: Record<string, unknown>;
  orderBy?: string | string[];
  expect?: { rows?: unknown[]; count?: number };
  capture?: Record<string, string>;
}

export interface ReceivedStep {
  received: string;
  call?: string;
  when?: Conditions;
  /** Exact number of matching calls. Default: at least one. */
  times?: number;
}

const KINDS = {
  stub: ["on", "when", "reply", "sequence", "networkError", "times", "delay"],
  request: ["headers", "query", "json", "form", "body", "follow", "expect", "capture"],
  insert: ["rows", "capture"],
  sql: ["params", "expect", "capture"],
  db: ["where", "orderBy", "expect", "capture"],
  received: ["call", "when", "times"],
} as const;
type Kind = keyof typeof KINDS;

const EXPECT_KEYS: Record<string, string[]> = {
  request: ["status", "headers", "json", "text"],
  sql: ["rows", "count"],
  db: ["rows", "count"],
};
const CONDITION_KEYS = ["query", "headers", "json", "body"];
const RESPONSE_KEYS = ["status", "headers", "body"];
const SCENARIO_KEYS = ["name", "steps", "each", "skip", "only", "timeout"];
const CALL = /^([A-Za-z]+|\*)\s+(\/\S*)$/;

export class YamlScenarioError extends Error {}

export function parseScenarioFile(text: string, file: string): YamlFile {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: true });
  const [syntax] = doc.errors;
  if (syntax) throw new YamlScenarioError(`${file}:${syntax.linePos?.[0]?.line ?? "?"}: ${syntax.message}`);

  const lineOf = (node: unknown) => (node && typeof node === "object" && "range" in node && (node as Node).range ? lines.linePos((node as Node).range![0]).line : 0);
  const fail = (node: unknown, msg: string): never => {
    throw new YamlScenarioError(`${file}:${lineOf(node)}: ${msg}`);
  };

  const root = doc.contents;
  if (!isMap(root)) return fail(root, "expected a mapping with a `scenarios:` list");
  const top = doc.toJS() as Record<string, unknown>;
  for (const key of Object.keys(top)) if (key !== "scenarios" && key !== "setup") fail(root, `unknown top-level key "${key}" (expected scenarios, setup)`);

  const stepsOf = (seqNode: unknown, what: string): Step[] => {
    if (!isSeq(seqNode)) return fail(seqNode, `${what} must be a list of steps`);
    return seqNode.items.map((item) => parseStep(item, fail, lineOf));
  };

  const scenariosNode = root.get("scenarios", true);
  if (!isSeq(scenariosNode) || scenariosNode.items.length === 0) return fail(scenariosNode ?? root, "`scenarios:` must be a non-empty list");
  const setupNode = root.get("setup", true);

  return {
    file,
    setup: setupNode ? stepsOf(setupNode, "setup") : [],
    scenarios: scenariosNode.items.map((node) => {
      if (!isMap(node)) return fail(node, "each scenario must be a mapping with `name` and `steps`");
      const raw = (node as { toJSON(): Record<string, unknown> }).toJSON();
      for (const key of Object.keys(raw)) if (!SCENARIO_KEYS.includes(key)) fail(node, `unknown scenario key "${key}" (expected ${SCENARIO_KEYS.join(", ")})`);
      if (typeof raw.name !== "string" || !raw.name) fail(node, "scenario needs a `name`");
      if (raw.each !== undefined && (!Array.isArray(raw.each) || raw.each.some((r) => !r || typeof r !== "object"))) {
        fail(node.get("each", true), "`each` must be a list of mappings");
      }
      if (raw.timeout !== undefined && typeof raw.timeout !== "number") fail(node, "`timeout` must be a number of milliseconds");
      return {
        name: raw.name as string,
        line: lineOf(node),
        each: raw.each as Record<string, unknown>[] | undefined,
        skip: raw.skip === true,
        only: raw.only === true,
        timeout: raw.timeout as number | undefined,
        steps: stepsOf(node.get("steps", true), `scenario "${raw.name}": steps`),
      };
    }),
  };
}

function parseStep(node: unknown, fail: (node: unknown, msg: string) => never, lineOf: (node: unknown) => number): Step {
  if (!isMap(node)) return fail(node, "a step must be a mapping, e.g. `- request: GET /health`");
  const raw = node.toJSON() as Record<string, unknown>;
  const kinds = (Object.keys(KINDS) as Kind[]).filter((k) => k in raw);
  if (kinds.length !== 1) {
    fail(node, kinds.length === 0 ? `a step needs one of: ${Object.keys(KINDS).join(", ")}` : `a step can only be one of ${kinds.join(" / ")}`);
  }
  const kind = kinds[0]!;
  const at = (key: string) => node.get(key, true) ?? node;
  const allowed = new Set<string>([kind, "name", ...KINDS[kind]]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) fail(at(key), `unknown key "${key}" in a ${kind} step (allowed: ${[...allowed].join(", ")})`);
  }
  if (typeof raw[kind] !== "string" || !raw[kind]) fail(at(kind), `\`${kind}:\` must be a non-empty string`);

  const keysOf = (key: string, allowedKeys: string[]) => {
    const v = raw[key];
    if (v === undefined) return;
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(at(key), `\`${key}\` must be a mapping`);
    for (const k of Object.keys(v as object)) {
      if (!allowedKeys.includes(k)) fail(at(key), `unknown key "${k}" in ${key} (allowed: ${allowedKeys.join(", ")})`);
    }
  };
  const call = (key: string) => {
    if (raw[key] !== undefined && !CALL.test(String(raw[key]))) fail(at(key), `\`${key}\` must look like "POST /path", got "${raw[key]}"`);
  };
  const number = (key: string) => {
    if (raw[key] !== undefined && (typeof raw[key] !== "number" || (raw[key] as number) < 0)) fail(at(key), `\`${key}\` must be a non-negative number`);
  };
  if (raw.capture !== undefined) {
    keysOf("capture", Object.keys(raw.capture as object));
    for (const [k, v] of Object.entries(raw.capture as object)) if (typeof v !== "string") fail(at("capture"), `capture "${k}" must be a path such as json.id`);
  }
  if (kind in EXPECT_KEYS) keysOf("expect", EXPECT_KEYS[kind]!);
  keysOf("when", CONDITION_KEYS);

  switch (kind) {
    case "stub": {
      if (raw.on === undefined) fail(node, "a stub step needs `on`, e.g. `on: POST /hook`");
      call("on");
      const answers = ["reply", "sequence", "networkError"].filter((k) => raw[k] !== undefined);
      if (answers.length !== 1) fail(node, "a stub step needs exactly one of reply / sequence / networkError");
      keysOf("reply", RESPONSE_KEYS);
      if (raw.sequence !== undefined && (!Array.isArray(raw.sequence) || raw.sequence.length === 0)) fail(at("sequence"), "`sequence` must be a non-empty list of responses");
      number("times");
      number("delay");
      break;
    }
    case "request":
      call("request");
      if (["json", "form", "body"].filter((k) => raw[k] !== undefined).length > 1) fail(node, "use only one of json / form / body");
      break;
    case "insert":
      if (!raw.rows || typeof raw.rows !== "object") fail(at("rows"), "an insert step needs `rows` (a mapping or a list of mappings)");
      break;
    case "received":
      call("call");
      number("times");
      break;
  }
  return { ...raw, line: lineOf(node) } as unknown as Step;
}
