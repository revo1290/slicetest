import { isMap, isSeq, LineCounter, parseDocument, type Node } from "yaml";

/**
 * YAML scenarios: the same things a TypeScript scenario can do, written as
 * data so teams that don't use JavaScript can write them. This module parses
 * and validates a file (in the Vitest main process, where line numbers are
 * known); yaml-runtime.ts runs the result inside a worker.
 */

export interface YamlFile {
  file: string;
  /** Absolute path, for CI annotations. */
  path?: string;
  /** Steps run at the start of every scenario in the file. */
  setup: Step[];
  /** Named step lists that `use:` steps run, with `with:` values for their `params`. */
  define: Record<string, { params: string[]; steps: Step[] }>;
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

export type Step = (StubStep | RequestStep | SubmitStep | InsertStep | MakeStep | ChaosStep | SqlStep | DbStep | ReceivedStep | ChangesStep | CheckpointStep | SetStep | LogStep | SnapshotStep | MailStep | UseStep) & {
  line: number;
  name?: string;
};

type GraphQLReply = { data?: unknown; errors?: (string | { message: string })[] };

/** Run the steps of a `define:` entry. Values in `with` become variables inside it; what it captures is visible afterwards. */
export interface UseStep {
  use: string;
  with?: Record<string, unknown>;
}

export interface StubStep {
  stub: string;
  /** METHOD /path; or `graphql` instead. */
  on?: string;
  /** A GraphQL operation name, answered at any path. */
  graphql?: string;
  when?: Conditions;
  /** `sse`: a streamed reply, a list of { event, data, id } (instead of `body`). */
  reply?: { status?: number; headers?: Record<string, string>; body?: unknown; sse?: { event?: string; data: unknown; id?: string }[] } & GraphQLReply;
  sequence?: ({ status?: number; headers?: Record<string, string>; body?: unknown; sse?: { event?: string; data: unknown; id?: string }[] } & GraphQLReply)[];
  networkError?: boolean;
  times?: number;
  delay?: number;
  /** The app may not call this route; `strictStubs` doesn't report it. */
  optional?: boolean;
}

export interface Conditions {
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  json?: unknown;
  /** Subset of a form-encoded body's fields, bracket keys nested (`metadata[order]` → `metadata: { order }`). */
  form?: Record<string, unknown>;
  body?: unknown;
  /** Subset of a GraphQL request's variables (with `graphql`). */
  variables?: unknown;
}

export interface RequestStep {
  request: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  json?: unknown;
  form?: Record<string, unknown>;
  body?: string;
  /** A GraphQL operation sent as the JSON body. */
  graphql?: string | { query: string; variables?: Record<string, unknown>; operationName?: string };
  follow?: boolean;
  /** Send `Authorization: Bearer` with a token from the `auth` issuer: `true`, or the claims, e.g. { sub: u1, roles: [admin] }. */
  auth?: true | Record<string, unknown>;
  /** Sign the body as this provider would deliver a webhook: { provider: stripe, secret: whsec_test, event, stale, invalidSignature }. */
  webhook?: { provider: string | { header: string; algorithm?: string; encoding?: "hex" | "base64"; prefix?: string }; secret: string; event?: string; stale?: boolean; invalidSignature?: boolean };
  /** Send the request this many times at once. `expect` applies to every response; `statuses` counts them. */
  concurrency?: number;
  /** `queries`: at most this many SQL statements (not counting BEGIN/COMMIT), with `db.queries` on. */
  /** `schema`: a JSON Schema for the response JSON, inline or `file#/pointer` relative to the scenario file. */
  expect?: { status?: number; statuses?: Record<string, number>; headers?: Record<string, unknown>; json?: unknown; text?: unknown; queries?: number; schema?: string | object };
  capture?: Record<string, string>;
}

/**
 * Submit a form of the page the last request returned, as a browser with JavaScript off would.
 * `submit:` names the button to press (its text, value, name or id), or is `true` for the form's only button.
 */
export interface SubmitStep {
  submit: string | true;
  /** The form by id, name or 0-based position, when the page has several. */
  form?: string | number;
  /** Values typed into the form by field name; true / false / a list check checkboxes and radios. */
  fields?: Record<string, string | number | boolean | (string | number)[]>;
  headers?: Record<string, string>;
  follow?: boolean;
  expect?: { status?: number; headers?: Record<string, unknown>; json?: unknown; text?: unknown; schema?: string | object };
  capture?: Record<string, string>;
}

export interface InsertStep {
  insert: string;
  rows: Record<string, unknown> | Record<string, unknown>[];
  capture?: Record<string, string>;
}

/** Rows built by `db.make()`: only the columns given are fixed, the rest is filled from the schema. */
export interface MakeStep {
  make: string;
  rows?: Record<string, unknown> | Record<string, unknown>[];
  /** Make this many rows, each with `rows` (a mapping). */
  count?: number;
  capture?: Record<string, string>;
}

/** Faults injected into a stub's answers for the rest of the scenario, like `stub(name).chaos()`. */
export interface ChaosStep {
  chaos: string;
  failFirst?: number;
  errorRate?: number;
  statuses?: number[];
  networkErrorRate?: number;
  latency?: number | [number, number];
  seed?: number;
}

export interface SqlStep {
  sql: string;
  params?: unknown[];
  expect?: { rows?: unknown[]; count?: number };
  capture?: Record<string, string>;
  within?: number;
}

export interface DbStep {
  db: string;
  where?: Record<string, unknown>;
  orderBy?: string | string[];
  expect?: { rows?: unknown[]; count?: number };
  capture?: Record<string, string>;
  /** Retry for up to this many milliseconds, for effects the app applies asynchronously. */
  within?: number;
}

export interface ReceivedStep {
  received: string;
  call?: string;
  /** A GraphQL operation name, instead of `call`. */
  graphql?: string;
  when?: Conditions;
  /** Exact number of matching calls. Default: at least one. */
  times?: number;
  within?: number;
}

/** Expected rows per table: a count, or a list of subset rows. */
export type ChangeSpec = { inserted?: number | unknown[]; updated?: number | unknown[]; deleted?: number | unknown[] };

/**
 * The database changed exactly in these tables since the scenario started (or
 * the last checkpoint). Tables that aren't listed must be unchanged.
 */
export interface ChangesStep {
  changes: Record<string, ChangeSpec>;
  within?: number;
}

/** Wait until the app (or `from:` a service) prints a line matching `log` (a regex) during the scenario. */
export interface LogStep {
  log: string;
  from?: string;
  /** Milliseconds to wait. Default 5000. */
  within?: number;
}

/** Define variables for later steps: `set: { orderId: "{{$uuid}}" }`. */
export interface SetStep {
  set: Record<string, unknown>;
}

/** Later `changes` steps only see what happens after this step. */
export interface CheckpointStep {
  checkpoint: true;
}

/** Compare the scenario's trace (requests, stub calls, database changes) with its stored snapshot. */
export interface SnapshotStep {
  snapshot: true;
  /** Keys whose values are masked in addition to dates and UUIDs. */
  mask?: string[];
}

/**
 * The app sent mail matching `mail:` (strings are exact addresses for to/from and substrings
 * otherwise; `{ $regex }` also works). Waits up to `within` ms (default 5000). `capture` reads
 * the last match: `subject`, `text`, `links.0`.
 */
export interface MailStep {
  mail: { to?: unknown; from?: unknown; subject?: unknown; text?: unknown; html?: unknown };
  /** Exact number of matching messages. Default: at least one. */
  times?: number;
  within?: number;
  capture?: Record<string, string>;
}

const KINDS = {
  stub: ["on", "graphql", "when", "reply", "sequence", "networkError", "times", "delay", "optional"],
  request: ["headers", "query", "json", "form", "body", "graphql", "follow", "auth", "webhook", "concurrency", "expect", "capture"],
  submit: ["form", "fields", "headers", "follow", "expect", "capture"],
  insert: ["rows", "capture"],
  sql: ["params", "expect", "capture", "within"],
  db: ["where", "orderBy", "expect", "capture", "within"],
  received: ["call", "graphql", "when", "times", "within"],
  changes: ["within"],
  log: ["from", "within"],
  checkpoint: [],
  set: [],
  snapshot: ["mask"],
  mail: ["times", "within", "capture"],
  make: ["rows", "count", "capture"],
  chaos: ["failFirst", "errorRate", "statuses", "networkErrorRate", "latency", "seed"],
  use: ["with"],
} as const;
type Kind = keyof typeof KINDS;

const EXPECT_KEYS: Record<string, string[]> = {
  request: ["status", "statuses", "headers", "json", "text", "queries", "schema"],
  submit: ["status", "headers", "json", "text", "schema"],
  sql: ["rows", "count"],
  db: ["rows", "count"],
};
const CONDITION_KEYS = ["query", "headers", "json", "form", "body", "variables"];
const WEBHOOK_KEYS = ["provider", "secret", "event", "stale", "invalidSignature"];
const WEBHOOK_PROVIDERS = ["stripe", "github", "slack", "shopify", "standard"];
const MAIL_KEYS = ["to", "from", "subject", "text", "html"];
const CHANGE_KEYS = ["inserted", "updated", "deleted"];
const RESPONSE_KEYS = ["status", "headers", "body", "sse", "data", "errors"];
const SCENARIO_KEYS = ["name", "steps", "each", "skip", "only", "timeout"];
const CALL = /^([A-Za-z]+|\*)\s+(\/\S*)$/;
/** A request may also go to a captured URL of the app, e.g. a link from a mail: `GET {{link}}`. */
const REQUEST = /^[A-Za-z]+\s+(\/\S*|\{\{[^}]+\}\}\S*)$/;

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
  for (const key of Object.keys(top)) if (!["scenarios", "setup", "define"].includes(key)) fail(root, `unknown top-level key "${key}" (expected scenarios, setup, define)`);

  const stepsOf = (seqNode: unknown, what: string): Step[] => {
    if (!isSeq(seqNode)) return fail(seqNode, `${what} must be a list of steps`);
    return seqNode.items.map((item) => parseStep(item, fail, lineOf));
  };

  const scenariosNode = root.get("scenarios", true);
  if (!isSeq(scenariosNode) || scenariosNode.items.length === 0) return fail(scenariosNode ?? root, "`scenarios:` must be a non-empty list");
  const setupNode = root.get("setup", true);

  const define: YamlFile["define"] = {};
  const defineNode = root.get("define", true);
  if (defineNode !== undefined) {
    if (!isMap(defineNode)) return fail(defineNode, "`define:` maps names to step lists, e.g. `define: { login: [ ...steps ] }`");
    for (const pair of defineNode.items) {
      const name = String((pair.key as { value?: unknown })?.value ?? pair.key);
      const value = pair.value;
      if (isSeq(value)) {
        define[name] = { params: [], steps: stepsOf(value, `define "${name}"`) };
        continue;
      }
      if (!isMap(value)) return fail(value ?? pair.key, `define "${name}" must be a list of steps, or { params, steps }`);
      const raw = value.toJSON() as Record<string, unknown>;
      for (const k of Object.keys(raw)) if (k !== "params" && k !== "steps") fail(value, `unknown key "${k}" in define "${name}" (allowed: params, steps)`);
      if (raw.params !== undefined && !(Array.isArray(raw.params) && raw.params.every((p) => typeof p === "string" && p))) fail(value.get("params", true) ?? value, "`params` must be a list of names, e.g. [email, password]");
      define[name] = { params: (raw.params as string[] | undefined) ?? [], steps: stepsOf(value.get("steps", true), `define "${name}": steps`) };
    }
  }
  // `use:` must name a definition and give it exactly its params; definitions can't use themselves.
  const checkUses = (steps: Step[], chain: string[]) => {
    for (const step of steps) {
      if (!("use" in step)) continue;
      const def = define[step.use];
      const at = `${file}:${step.line}`;
      if (!def) throw new YamlScenarioError(`${at}: no definition "${step.use}" (defined: ${Object.keys(define).join(", ") || "none; add a top-level \`define:\`"})`);
      if (chain.includes(step.use)) throw new YamlScenarioError(`${at}: "${step.use}" uses itself (${[...chain, step.use].join(" → ")})`);
      const given = Object.keys(step.with ?? {});
      const missing = def.params.filter((p) => !given.includes(p));
      const extra = given.filter((g) => !def.params.includes(g));
      if (missing.length) throw new YamlScenarioError(`${at}: use ${step.use} needs \`with: { ${missing.join(", ")} }\``);
      if (extra.length) throw new YamlScenarioError(`${at}: "${extra.join('", "')}" ${extra.length > 1 ? "aren't params" : "isn't a param"} of ${step.use} (params: ${def.params.join(", ") || "none"})`);
      checkUses(def.steps, [...chain, step.use]);
    }
  };
  for (const [name, def] of Object.entries(define)) checkUses(def.steps, [name]);

  const parsed: YamlFile = {
    file,
    setup: setupNode ? stepsOf(setupNode, "setup") : [],
    define,
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
  checkUses(parsed.setup, []);
  for (const sc of parsed.scenarios) checkUses(sc.steps, []);
  return parsed;
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
  if (kind === "changes") {
    const tables = raw.changes;
    if (!tables || typeof tables !== "object" || Array.isArray(tables)) fail(at(kind), "`changes:` must map table names to { inserted, updated, deleted }");
    for (const [table, spec] of Object.entries(tables as object)) {
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) fail(at(kind), `changes of "${table}" must be a mapping such as { inserted: 1 }`);
      for (const [k, v] of Object.entries(spec as object)) {
        if (!CHANGE_KEYS.includes(k)) fail(at(kind), `unknown key "${k}" in changes of "${table}" (allowed: ${CHANGE_KEYS.join(", ")})`);
        if (!Array.isArray(v) && !(typeof v === "number" && v >= 0)) fail(at(kind), `${table}.${k} must be a count or a list of rows`);
      }
    }
  } else if (kind === "mail") {
    const filter = raw.mail;
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) fail(at(kind), "`mail:` must be a mapping such as { to: alice@example.com, subject: Welcome } ({} for any)");
    for (const k of Object.keys(filter as object)) if (!MAIL_KEYS.includes(k)) fail(at(kind), `unknown key "${k}" in mail (allowed: ${MAIL_KEYS.join(", ")})`);
  } else if (kind === "submit") {
    if (raw.submit !== true && (typeof raw.submit !== "string" || !raw.submit.trim())) fail(at(kind), "`submit:` names the button to press (its text), or is `true` for the form's only button");
    if (raw.form !== undefined && !(typeof raw.form === "string" || (Number.isInteger(raw.form) && (raw.form as number) >= 0))) fail(at("form"), "`form` is the form's id or name, or its position on the page (0 for the first)");
    const fields = raw.fields;
    if (fields !== undefined) {
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) fail(at("fields"), "`fields` must map field names to values, e.g. { email: a@b.test }");
      for (const [k, v] of Object.entries(fields as object)) {
        const scalar = (x: unknown) => typeof x === "string" || typeof x === "number";
        if (!(scalar(v) || typeof v === "boolean" || (Array.isArray(v) && v.every(scalar)))) fail(at("fields"), `field "${k}" must be a string, number, true / false or a list`);
      }
    }
  } else if (kind === "use") {
    if (typeof raw.use !== "string" || !raw.use) fail(at(kind), "`use:` names a step list from `define:`");
    if (raw.with !== undefined && (!raw.with || typeof raw.with !== "object" || Array.isArray(raw.with))) fail(at("with"), "`with` maps params to values, e.g. { email: a@b.test }");
  } else if (kind === "set") {
    if (!raw.set || typeof raw.set !== "object" || Array.isArray(raw.set) || Object.keys(raw.set).length === 0) fail(at(kind), "`set:` maps variable names to values, e.g. { orderId: \"{{$uuid}}\" }");
    for (const k of Object.keys(raw.set as object)) if (!/^[A-Za-z_][\w]*$/.test(k)) fail(at(kind), `"${k}" isn't a variable name (letters, digits and _)`);
  } else if (kind === "checkpoint") {
    if (raw.checkpoint !== true) fail(at(kind), "use `checkpoint: true`");
  } else if (kind === "snapshot") {
    if (raw.snapshot !== true) fail(at(kind), "use `snapshot: true`");
    if (raw.mask !== undefined && !(Array.isArray(raw.mask) && raw.mask.every((k) => typeof k === "string"))) fail(at("mask"), "`mask:` must be a list of keys, e.g. [token]");
  } else if (typeof raw[kind] !== "string" || !raw[kind]) fail(at(kind), `\`${kind}:\` must be a non-empty string`);

  const keysOf = (key: string, allowedKeys: string[]) => {
    const v = raw[key];
    if (v === undefined) return;
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(at(key), `\`${key}\` must be a mapping`);
    for (const k of Object.keys(v as object)) {
      if (!allowedKeys.includes(k)) fail(at(key), `unknown key "${k}" in ${key} (allowed: ${allowedKeys.join(", ")})`);
    }
  };
  const call = (key: string, pattern = CALL) => {
    if (raw[key] !== undefined && !pattern.test(String(raw[key]))) fail(at(key), `\`${key}\` must look like "POST /path", got "${raw[key]}"`);
  };
  if (raw.within !== undefined && (typeof raw.within !== "number" || raw.within <= 0)) fail(at("within"), "`within` must be a positive number of milliseconds");
  const number = (key: string) => {
    if (raw[key] !== undefined && (typeof raw[key] !== "number" || (raw[key] as number) < 0)) fail(at(key), `\`${key}\` must be a non-negative number`);
  };
  if (raw.capture !== undefined) {
    keysOf("capture", Object.keys(raw.capture as object));
    for (const [k, v] of Object.entries(raw.capture as object)) if (typeof v !== "string") fail(at("capture"), `capture "${k}" must be a path such as json.id`);
  }
  if (kind in EXPECT_KEYS) keysOf("expect", EXPECT_KEYS[kind]!);
  {
    const schema = (raw.expect as Record<string, unknown> | undefined)?.schema;
    if (schema !== undefined && !((typeof schema === "string" && schema) || (schema && typeof schema === "object" && !Array.isArray(schema)))) {
      fail(at("expect"), "`expect.schema` is a JSON Schema, or a file such as openapi.yaml#/components/schemas/Poll");
    }
  }
  keysOf("when", CONDITION_KEYS);
  if (raw.graphql !== undefined && kind !== "request" && (typeof raw.graphql !== "string" || !raw.graphql)) fail(at("graphql"), "`graphql` is the operation's name, e.g. `graphql: GetUser`");
  if ((raw.when as Record<string, unknown> | undefined)?.variables !== undefined && raw.graphql === undefined) fail(at("when"), "`when.variables` needs `graphql: <operation>`");

  switch (kind) {
    case "stub": {
      if ((raw.on === undefined) === (raw.graphql === undefined)) fail(node, "a stub step needs one of `on` (e.g. `on: POST /hook`) or `graphql` (e.g. `graphql: GetUser`)");
      call("on");
      const answers = ["reply", "sequence", "networkError"].filter((k) => raw[k] !== undefined);
      if (answers.length !== 1) fail(node, "a stub step needs exactly one of reply / sequence / networkError");
      keysOf("reply", RESPONSE_KEYS);
      for (const [where, r] of [["reply", raw.reply], ...((Array.isArray(raw.sequence) ? raw.sequence : []) as unknown[]).map((r) => ["sequence", r] as const)] as const) {
        if (!r || typeof r !== "object") continue;
        const { body, sse, data, errors } = r as { body?: unknown; sse?: unknown; data?: unknown; errors?: unknown };
        if (data !== undefined || errors !== undefined) {
          if (raw.graphql === undefined) fail(at(where), "`data` and `errors` answer a GraphQL operation: use them with `graphql: <operation>`, or send `body`");
          if (body !== undefined || sse !== undefined) fail(at(where), "a GraphQL reply has `data` / `errors`, not `body` or `sse`");
          if (errors !== undefined && !(Array.isArray(errors) && errors.every((e) => typeof e === "string" || (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string")))) {
            fail(at(where), "`errors` must be a list of messages or { message, path, extensions }");
          }
        }
        if (sse === undefined) continue;
        if (body !== undefined) fail(at(where), "a reply has either `body` or `sse`, not both");
        if (!Array.isArray(sse) || sse.some((e) => !e || typeof e !== "object" || Array.isArray(e) || !("data" in e) || Object.keys(e).some((k) => !["event", "data", "id"].includes(k)))) {
          fail(at(where), "`sse` must be a list of events such as { event: message_start, data: { ... } }");
        }
      }
      if (raw.sequence !== undefined && (!Array.isArray(raw.sequence) || raw.sequence.length === 0)) fail(at("sequence"), "`sequence` must be a non-empty list of responses");
      number("times");
      number("delay");
      if (raw.optional !== undefined && typeof raw.optional !== "boolean") fail(at("optional"), "`optional` must be true or false");
      break;
    }
    case "request":
      call("request", REQUEST);
      if (["json", "form", "body", "graphql"].filter((k) => raw[k] !== undefined).length > 1) fail(node, "use only one of json / form / body / graphql");
      if (raw.graphql !== undefined) {
        const g = raw.graphql as Record<string, unknown> | string | null;
        const ok = (typeof g === "string" && g.trim()) || (g && typeof g === "object" && !Array.isArray(g) && typeof g.query === "string" && Object.keys(g).every((k) => ["query", "variables", "operationName"].includes(k)));
        if (!ok) fail(at("graphql"), "`graphql` is the query, or { query, variables, operationName }");
      }
      if (raw.webhook !== undefined) {
        const w = raw.webhook as Record<string, unknown> | null;
        if (!w || typeof w !== "object" || Array.isArray(w)) fail(at("webhook"), "`webhook` must be a mapping such as { provider: stripe, secret: whsec_test }");
        for (const k of Object.keys(w!)) if (!WEBHOOK_KEYS.includes(k)) fail(at("webhook"), `unknown key "${k}" in webhook (allowed: ${WEBHOOK_KEYS.join(", ")})`);
        if (typeof w!.secret !== "string" || !w!.secret) fail(at("webhook"), "`webhook.secret` is required: the signing secret the app is configured with");
        const p = w!.provider;
        if (!(typeof p === "string" ? WEBHOOK_PROVIDERS.includes(p) : p && typeof p === "object" && typeof (p as { header?: unknown }).header === "string")) {
          fail(at("webhook"), `\`webhook.provider\` must be one of ${WEBHOOK_PROVIDERS.join(", ")} or { header, prefix, encoding }`);
        }
      }
      if (raw.auth !== undefined && raw.auth !== true && !(raw.auth && typeof raw.auth === "object" && !Array.isArray(raw.auth))) fail(at("auth"), "`auth` must be true or the token's claims, e.g. { sub: u1, roles: [admin] }");
      if (raw.concurrency !== undefined && !(Number.isInteger(raw.concurrency) && (raw.concurrency as number) >= 1)) fail(at("concurrency"), "`concurrency` must be a positive whole number");
      {
        const q = (raw.expect as Record<string, unknown> | undefined)?.queries;
        if (q !== undefined && !(Number.isInteger(q) && (q as number) >= 0)) fail(at("expect"), "`expect.queries` is the most SQL statements the request may run, e.g. 3");
        if (q !== undefined && raw.concurrency !== undefined) fail(at("expect"), "`expect.queries` can't be used with `concurrency`");
      }
      if (raw.concurrency !== undefined && raw.capture !== undefined) fail(at("capture"), "`capture` can't be used with `concurrency`: there is more than one response");
      {
        const statuses = (raw.expect as Record<string, unknown> | undefined)?.statuses;
        if (statuses !== undefined) {
          if (raw.concurrency === undefined) fail(at("expect"), "`expect.statuses` needs `concurrency`");
          if (!statuses || typeof statuses !== "object" || Object.entries(statuses).some(([k, v]) => !/^\d{3}$/.test(k) || !Number.isInteger(v))) {
            fail(at("expect"), "`expect.statuses` maps status codes to counts, e.g. { 201: 1, 409: 9 }");
          }
        }
      }
      break;
    case "insert":
      if (!raw.rows || typeof raw.rows !== "object") fail(at("rows"), "an insert step needs `rows` (a mapping or a list of mappings)");
      break;
    case "chaos":
      for (const k of ["errorRate", "networkErrorRate"]) {
        if (raw[k] !== undefined && !(typeof raw[k] === "number" && raw[k] >= 0 && raw[k] <= 1)) fail(at(k), `\`${k}\` must be a number between 0 and 1`);
      }
      for (const k of ["failFirst", "seed"]) if (raw[k] !== undefined && !Number.isInteger(raw[k])) fail(at(k), `\`${k}\` must be a whole number`);
      if (raw.statuses !== undefined && !(Array.isArray(raw.statuses) && raw.statuses.length > 0 && raw.statuses.every((s) => Number.isInteger(s) && s >= 400 && s <= 599))) {
        fail(at("statuses"), "`statuses` must be a list of 4xx/5xx codes, e.g. [503]");
      }
      {
        const l = raw.latency;
        if (l !== undefined && !(typeof l === "number" || (Array.isArray(l) && l.length === 2 && l.every((x) => typeof x === "number")))) fail(at("latency"), "`latency` must be milliseconds or [min, max]");
      }
      break;
    case "make":
      if (raw.rows !== undefined && (!raw.rows || typeof raw.rows !== "object")) fail(at("rows"), "`rows` must be a mapping or a list of mappings");
      if (raw.count !== undefined) {
        if (!(Number.isInteger(raw.count) && (raw.count as number) >= 1)) fail(at("count"), "`count` must be a positive whole number");
        if (Array.isArray(raw.rows)) fail(at("count"), "use either `count` or a list of `rows`");
      }
      break;
    case "log":
      try {
        new RegExp(raw.log as string);
      } catch (e) {
        fail(at("log"), `\`log\` must be a regular expression: ${(e as Error).message}`);
      }
      if (raw.from !== undefined && typeof raw.from !== "string") fail(at("from"), "`from` must be a service name");
      break;
    case "received":
      call("call");
      if (raw.call !== undefined && raw.graphql !== undefined) fail(node, "a received step takes `call` or `graphql`, not both");
      number("times");
      break;
    case "mail":
      number("times");
      break;
  }
  return { ...raw, line: lineOf(node) } as unknown as Step;
}
