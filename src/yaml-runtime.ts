import { waitBudget } from "./deadline.js";
import { expect, inject } from "vitest";
import { recordYamlFailure } from "./ci.js";
import "./provided.js";
import { formatChanges } from "./db.js";
import "./matchers.js";
import type { ExpectedStatus, OrderedCall } from "./matchers.js";
import type { ScenarioContext } from "./runtime.js";
import { scenario } from "./scenario.js";
import type { HttpResponse } from "./http.js";
import type { MailFilter } from "./mail.js";
import { signWebhook, webhookBody, type WebhookOptions } from "./webhook.js";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import path from "node:path";
import { isIPv4, isIPv6 } from "node:net";
import { graphqlErrors } from "./graphql.js";
import { schemaProblems } from "./schema.js";
import { sse, type MatchOptions, type RecordedCall, type RouteBuilder, type ServerSentEvent, type StubResponse } from "./stub.js";
import { lookup, scenarioTitle, type ChangeSpec, type Conditions, type FilePart, type Step, type YamlFile, type YamlScenario } from "./yaml.js";
import type { SubmitOptions } from "./form.js";

export { lookup };

type Vars = Record<string, unknown>;

/** Registers the scenarios of one parsed YAML file. Called from the module the plugin generates for it. */
export function defineYamlScenarios(doc: YamlFile) {
  for (const sc of doc.scenarios) {
    const register = sc.only ? scenario.only : sc.skip ? scenario.skip : scenario;
    const rows = sc.each ?? [undefined];
    rows.forEach((row, i) => {
      const title = row ? scenarioTitle(sc.name, row, i) : sc.name;
      register(title, (ctx) => {
        seq = 0;
        return runSteps(doc, sc, [...doc.setup, ...sc.steps], ctx, { ...row });
      }, { timeout: sc.timeout, tags: sc.tags });
    });
  }
}

async function runSteps(doc: YamlFile, sc: YamlScenario, steps: Step[], ctx: ScenarioContext, vars: Vars, trail: string[] = []) {
  for (const [i, step] of steps.entries()) {
    if ("use" in step) {
      // The definition sees the scenario's variables plus `with`; what it captures is kept afterwards.
      const args = (interpolate(step.with ?? {}, vars) as Vars) ?? {};
      const inner: Vars = { ...vars, ...args };
      await runSteps(doc, sc, doc.define[step.use]!.steps, ctx, inner, [...trail, `step ${i + 1}: use ${step.use}`]);
      for (const [k, v] of Object.entries(inner)) if (!(k in args)) vars[k] = v;
      continue;
    }
    try {
      // A log step waits by itself; `within` is its timeout.
      // Log and mail steps wait by themselves; `within` is their timeout.
      // Requests poll the app (`every` ms, default 200): a job answered 202 until it's done.
      await retry(
        "within" in step && !("log" in step) && !("mail" in step) ? step.within : undefined,
        () => runStep(step, ctx, vars, doc.path ? path.dirname(doc.path) : undefined),
        "request" in step ? (step.every ?? 200) : 50,
      );
    } catch (e) {
      const label = step.name ?? describeStep(step);
      const where = `${doc.file}:${step.line} (${sc.name}, ${[...trail, `step ${i + 1}: ${label}`].join(" → ")})`;
      const ciDir = inject("slicetestDb")?.ciDir;
      if (ciDir && doc.path) {
        const message = (e instanceof Error ? e.message : String(e)).replace(/\x1b\[[0-9;]*m/g, "");
        await recordYamlFailure(ciDir, { file: doc.path, line: step.line, scenario: sc.name, step: [...trail, `step ${i + 1}: ${label}`].join(" → "), message }).catch(() => {});
      }
      if (e instanceof Error) {
        e.message = `${where}\n${e.message}`;
        throw e;
      }
      throw new Error(`${where}\n${String(e)}`);
    }
  }
}

function describeStep(step: Step) {
  if ("use" in step) return `use ${step.use}`;
  if ("submit" in step) return step.submit === true ? "submit" : `submit ${JSON.stringify(step.submit)}`;
  if ("request" in step) return step.concurrency ? `${step.request} ×${step.concurrency}` : step.request;
  if ("stub" in step) return `stub ${step.stub} ${step.on ?? `GraphQL ${step.graphql}`}`;
  if ("received" in step) return `received ${step.received}${step.call ? ` ${step.call}` : step.graphql ? ` GraphQL ${step.graphql}` : ""}`;
  if ("insert" in step) return `insert ${step.insert}`;
  if ("make" in step) return `make ${step.make}`;
  if ("chaos" in step) return `chaos ${step.chaos}`;
  if ("db" in step) return `db ${step.db}`;
  if ("changes" in step) return "changes";
  if ("checkpoint" in step) return "checkpoint";
  if ("set" in step) return `set ${Object.keys(step.set).join(", ")}`;
  if ("order" in step) return `order ${step.order.map((o) => (typeof o === "string" ? o : `${o.stub} ${o.call}`)).join(" → ")}`;
  if ("snapshot" in step) return "snapshot";
  if ("mail" in step) return `mail${Object.entries(step.mail).map(([k, v]) => ` ${k}: ${JSON.stringify(v)}`).join(",")}`;
  if ("log" in step) return `log ${step.from ? `from ${step.from} ` : ""}/${step.log}/`;
  return "sql";
}

/** Run `fn` until it passes or `within` ms have passed, then rethrow its last error. */
async function retry(wanted: number | undefined, fn: () => Promise<void>, every = 50) {
  if (!wanted) return fn();
  const { ms: within, note } = waitBudget(wanted);
  const deadline = Date.now() + within;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() >= deadline) {
        if (e instanceof Error) e.message = `${e.message}\n(still failing after retrying for ${within}ms${note})`;
        throw e;
      }
      await new Promise((r) => setTimeout(r, every));
    }
  }
}

async function runStep(step: Step, ctx: ScenarioContext, vars: Vars, base?: string) {
  if ("use" in step) throw new Error("slicetest: use steps are expanded by runSteps");
  if ("order" in step) {
    const calls = step.order.map((o): OrderedCall => {
      const [name, call, when] = typeof o === "string" ? [o.slice(0, o.search(/\s/)), o.slice(o.search(/\s/)).trim(), undefined] : [o.stub, o.call, o.when];
      const [method, p] = splitCall(interpolate(call, vars) as string);
      return [name, method, p, conditions(when, vars)];
    });
    expect(ctx.stub).toHaveReceivedInOrder(calls);
    return;
  }
  if ("set" in step) {
    for (const [k, v] of Object.entries(step.set)) vars[k] = interpolate(v, vars);
    return;
  }
  if ("checkpoint" in step) {
    await ctx.db.checkpoint();
    return;
  }

  if ("snapshot" in step) {
    expect(await ctx.trace({ keys: step.mask })).toMatchSnapshot();
    return;
  }

  if ("log" in step) {
    const target = step.from ? ctx.service(step.from) : ctx.app;
    await target.waitForLog(new RegExp(interpolate(step.log, vars) as string), step.within ?? 5000);
    return;
  }

  if ("mail" in step) {
    const filter = Object.fromEntries(
      Object.entries(interpolate(step.mail, vars) as Record<string, unknown>).map(([k, v]) => {
        if (!v || typeof v !== "object") return [k, String(v)];
        const { $regex, $options, ...rest } = v as Record<string, unknown>;
        if ($regex === undefined || Object.keys(rest).length) throw new Error(`mail ${k}: takes a string or { $regex, $options }, got ${JSON.stringify(v)}`);
        return [k, regexOf($regex, $options)];
      }),
    ) as MailFilter;
    const box = ctx.mail;
    await retry(step.within ?? 5000, async () => {
      const found = box.messages(filter);
      if (step.times === undefined ? found.length === 0 : found.length !== step.times) {
        const want = step.times === undefined ? "at least one message" : `${step.times} message(s)`;
        throw new Error(`expected ${want} matching ${JSON.stringify(step.mail)}, got ${found.length}\n${box.describe()}`);
      }
    });
    const last = box.last(filter);
    if (last) capture(step.capture, last as unknown as Record<string, unknown>, vars);
    return;
  }

  if ("changes" in step) {
    const actual = await ctx.db.changes({ ignore: step.ignore });
    const expected = interpolate(step.changes, vars) as Record<string, ChangeSpec>;
    const unexpected = Object.keys(actual).filter((t) => !(t in expected));
    if (unexpected.length) {
      throw new Error(`unexpected changes in ${unexpected.join(", ")}:\n${formatChanges(Object.fromEntries(unexpected.map((t) => [t, actual[t]!])))}`);
    }
    for (const [table, spec] of Object.entries(expected)) {
      const got = actual[table] ?? { inserted: [], updated: [], deleted: [] };
      for (const kind of ["inserted", "updated", "deleted"] as const) {
        const want = spec[kind];
        if (want === undefined) continue;
        const rows = kind === "updated" ? got.updated.map((u) => u.after) : got[kind];
        if (typeof want === "number") {
          if (rows.length !== want) throw new Error(`expected ${want} row(s) ${kind} in ${table}, got ${rows.length}\n${formatChanges({ [table]: got }) || "  (no changes)"}`);
        } else check(rows, want, vars, `${kind} rows of ${table}`);
      }
    }
    return;
  }

  if ("stub" in step) {
    const stub = ctx.stub(step.stub);
    let route: RouteBuilder;
    if (step.graphql !== undefined) {
      const { variables, ...when } = conditions(step.when, vars) as MatchOptions & { variables?: unknown };
      route = stub.graphql(interpolate(step.graphql, vars) as string, { ...when, variables });
    } else {
      const [method, path] = splitCall(step.on!);
      route = stub.on(method, interpolate(path, vars) as string, conditions(step.when, vars));
    }
    if (step.times !== undefined) route = route.times(step.times);
    if (step.delay !== undefined) route = route.delay(step.delay);
    if (step.optional) route = route.optional();
    // Replies are interpolated when a call arrives, so they can echo it: {{call.params.id}}, {{call.json.name}}, {{call.variables.id}}.
    const answer = (prepared: PreparedReply) => (call: RecordedCall) => {
      const { sse: events, data, errors, ...response } = interpolate(prepared.template, { ...vars, call: callVars(call) }) as StubResponse & { sse?: ServerSentEvent[]; data?: unknown; errors?: (string | { message: string })[] };
      if (prepared.bytes) return { ...response, body: prepared.bytes };
      if (data !== undefined || errors !== undefined) {
        return { status: 200, ...response, body: { ...(errors ? { errors: graphqlErrors(errors) } : {}), ...(data !== undefined ? { data } : {}) } };
      }
      return events ? sse(events, response) : response;
    };
    if (step.networkError) route.networkError();
    else if (step.sequence) {
      let n = 0;
      const seq = await Promise.all(step.sequence.map((r) => prepareReply(r, vars, base)));
      route.reply((call) => answer(seq[Math.min(n++, seq.length - 1)]!)(call));
    } else route.reply(answer(await prepareReply(step.reply ?? {}, vars, base)));
    return;
  }

  if ("submit" in step) {
    const page = ctx.http.history.at(-1);
    if (!page) throw new Error("submit needs a page with a form: request it first, e.g. `- request: GET /signup`");
    const res = await ctx.http.submit(page, {
      button: step.submit === true ? undefined : (interpolate(step.submit, vars) as string),
      form: interpolate(step.form, vars) as string | number | undefined,
      fields: await withFiles(interpolate(step.fields, vars) as Record<string, unknown> | undefined, base),
      headers: interpolate(step.headers, vars) as Record<string, string> | undefined,
      follow: step.follow,
    });
    verifyResponse(res, step.expect, vars, base);
    capture(step.capture, { status: res.status, json: res.json, text: res.text, headers: Object.fromEntries(res.headers), events: res.events }, vars);
    return;
  }

  if ("request" in step) {
    const [method, rawPath] = splitCall(step.request);
    const path = interpolate(rawPath, vars) as string;
    const headers = interpolate(step.headers, vars) as Record<string, string> | undefined;
    const opts = {
      headers: step.auth ? { ...ctx.auth.header(step.auth === true ? {} : (interpolate(step.auth, vars) as Record<string, unknown>)), ...headers } : headers,
      query: interpolate(step.query, vars) as Record<string, string> | undefined,
      follow: step.follow,
      ...(step.timeout !== undefined ? { timeout: step.timeout } : {}),
    };
    const gql = step.graphql === undefined ? undefined : (interpolate(typeof step.graphql === "string" ? { query: step.graphql } : step.graphql, vars) as Record<string, unknown>);
    let body =
      gql !== undefined
        ? gql
        : step.json !== undefined
        ? interpolate(step.json, vars)
        : step.form !== undefined
          ? ctx.http.form(interpolate(step.form, vars) as Record<string, string>)
          : step.multipart !== undefined
            ? await multipart(interpolate(step.multipart, vars) as Record<string, unknown>, base)
            : (interpolate(step.body, vars) as string | undefined);
    if (step.webhook) {
      const hook = interpolate(step.webhook, vars) as WebhookOptions;
      const signed = webhookBody(body, hook.provider);
      body = signed.body;
      const url = new URL(path, ctx.http.baseUrl);
      for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
      opts.headers = { "content-type": signed.type, ...signWebhook(signed.body, { url: url.href, ...hook }), ...opts.headers };
    }
    const e = step.expect;
    const verify = (res: HttpResponse) => {
      // GraphQL servers answer errors with 200, so a status check alone would pass them.
      const expectsErrors = !!e?.json && typeof e.json === "object" && "errors" in (e.json as object);
      if (gql && !expectsErrors && Array.isArray(res.json?.errors) && res.json.errors.length) expect(res).toHaveGraphQLData();
      verifyResponse(res, e, vars, base);
    };
    if (step.concurrency !== undefined) {
      // Each request gets its own body: a URLSearchParams body can only be read once.
      const all = await ctx.http.concurrently(step.concurrency, () => ctx.http.request(method, path, body instanceof URLSearchParams ? new URLSearchParams(body) : body, opts));
      if (e?.statuses !== undefined) expect(all).toHaveStatuses(interpolate(e.statuses, vars) as Record<number, number>);
      all.forEach(verify);
      return;
    }
    const max = e?.queries === undefined ? undefined : (interpolate(e.queries, vars) as number);
    let res!: HttpResponse;
    const queries = await (max === undefined ? undefined : ctx.db.queries(async () => (res = await ctx.http.request(method, path, body, opts))));
    if (!queries) res = await ctx.http.request(method, path, body, opts);
    if (queries && max !== undefined) {
      const ran = queries.withoutTransactions();
      if (ran.length > max) {
        const shapes = ran.shapes().map((s) => `  ${s.count > 1 ? `×${s.count} ` : ""}${s.sql}`);
        throw new Error(`expected at most ${max} SQL statements for ${method} ${path}, the app ran ${ran.length}:\n${shapes.join("\n")}`);
      }
    }
    verify(res);
    capture(step.capture, { status: res.status, json: res.json, text: res.text, headers: Object.fromEntries(res.headers), events: res.events }, vars);
    return;
  }

  if ("insert" in step) {
    const rows = await ctx.db.insert(step.insert, interpolate(step.rows, vars) as Record<string, unknown>[]);
    capture(step.capture, { rows, row: rows[0] }, vars);
    return;
  }

  if ("chaos" in step) {
    const { chaos, name: _, ...opts } = step as typeof step & { name?: string };
    ctx.stub(chaos).chaos(opts);
    return;
  }

  if ("make" in step) {
    const given = (interpolate(step.rows, vars) as Record<string, unknown> | Record<string, unknown>[] | undefined) ?? {};
    const rows = [];
    if (Array.isArray(given)) for (const r of given) rows.push(await ctx.db.make(step.make, r));
    else rows.push(...(await ctx.db.makeMany(step.make, step.count ?? 1, given)));
    capture(step.capture, { rows, row: rows[0] }, vars);
    return;
  }

  if ("sql" in step) {
    const rows = await ctx.db.query(step.sql, (interpolate(step.params, vars) as unknown[]) ?? []);
    expectRows(step.expect, rows, vars);
    capture(step.capture, { rows, row: rows[0], count: rows.length }, vars);
    return;
  }

  if ("db" in step) {
    const rows = await ctx.db.rows(step.db, (interpolate(step.where, vars) as Record<string, unknown>) ?? {}, { orderBy: step.orderBy });
    expectRows(step.expect, rows, vars, step.db);
    capture(step.capture, { rows, row: rows[0], count: rows.length }, vars);
    return;
  }

  // received
  const [method, path] = step.call ? splitCall(step.call) : [undefined, undefined];
  const stub = ctx.stub(step.received);
  const { variables, ...match } = conditions(step.when, vars) as MatchOptions & { variables?: unknown };
  if (step.graphql !== undefined) match.graphql = { operation: interpolate(step.graphql, vars) as string, variables };
  const p = path && (interpolate(path, vars) as string);
  if (step.times === undefined) expect(stub).toHaveReceived(method ?? "*", p ?? /.*/, match);
  else expect(stub).toHaveReceivedTimes(step.times, method, p, match);
}

function expectRows(e: { rows?: unknown[]; count?: number } | undefined, rows: unknown[], vars: Vars, table?: string) {
  if (!e) return;
  if (e.count !== undefined && rows.length !== e.count) {
    const shown = rows.slice(0, 5).map((r) => `  ${JSON.stringify(r)}`).join("\n");
    throw new Error(`expected ${e.count} row(s)${table ? ` in ${table}` : ""}, found ${rows.length}${shown ? `:\n${shown}` : ""}`);
  }
  if (e.rows !== undefined) check(rows, e.rows, vars, table ? `rows of ${table}` : "rows");
}

/** Subset comparison with Vitest's diff: objects may have extra keys, arrays must have the same length. */
function check(actual: unknown, expected: unknown, vars: Vars, what: string) {
  const want = toMatchers(interpolate(expected, vars));
  if (want && typeof want === "object" && !isAsymmetric(want)) expect(actual, what).toMatchObject(want as object);
  else expect(actual, what).toEqual(want);
}

function conditions(when: Conditions | undefined, vars: Vars): MatchOptions {
  if (!when) return {};
  return toMatchers(interpolate(when, vars)) as MatchOptions;
}

function capture(spec: Record<string, string> | undefined, result: Record<string, unknown>, vars: Vars) {
  for (const [name, path] of Object.entries(spec ?? {})) {
    const value = lookup(result, path);
    if (value === undefined) {
      throw new Error(`capture "${name}": ${path} is undefined in ${JSON.stringify(result).slice(0, 300)}`);
    }
    vars[name] = value;
  }
}

function callVars(call: RecordedCall) {
  return {
    method: call.method,
    path: call.path,
    params: call.params,
    query: Object.fromEntries(call.query),
    headers: call.headers,
    json: call.json,
    form: call.form,
    body: call.body,
    variables: call.graphql?.variables,
  };
}

interface PreparedReply {
  /** Interpolated per call. */
  template: unknown;
  /** A binary file's content, sent as it is. */
  bytes?: Uint8Array;
}

const TEXT_FILE = /^(text\/|application\/(xml|javascript)|image\/svg)/;

/** A reply with `file:` read once: JSON and YAML become the body (still templated), other text as a string, the rest as bytes. */
async function prepareReply(reply: Record<string, unknown>, vars: Vars, base = process.cwd()): Promise<PreparedReply> {
  if (typeof reply.file !== "string") return { template: reply };
  const { file: name, ...rest } = reply;
  const file = path.resolve(base, interpolate(name, vars) as string);
  const bytes = await readFile(file).catch(() => {
    throw new Error(`reply file: can't read ${file}`);
  });
  const ext = path.extname(file).toLowerCase();
  const headers = { ...(rest.headers as Record<string, string> | undefined) };
  const hasType = Object.keys(headers).some((h) => h.toLowerCase() === "content-type");
  if (ext === ".json" || ext === ".yaml" || ext === ".yml") {
    let body: unknown;
    try {
      body = ext === ".json" ? JSON.parse(bytes.toString("utf8")) : parseYaml(bytes.toString("utf8"));
    } catch (e) {
      throw new Error(`reply file ${file}: ${(e as Error).message}`);
    }
    return { template: { ...rest, headers, body } };
  }
  const type = MIME[ext] ?? "application/octet-stream";
  if (!hasType) headers["content-type"] = type;
  if (TEXT_FILE.test(type)) return { template: { ...rest, headers, body: bytes.toString("utf8") } };
  return { template: { ...rest, headers }, bytes: new Uint8Array(bytes) };
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".json": "application/json", ".csv": "text/csv", ".txt": "text/plain", ".xml": "application/xml",
  ".zip": "application/zip", ".html": "text/html", ".md": "text/markdown", ".yaml": "text/yaml", ".yml": "text/yaml",
};

/** A `{ file }` / `{ content }` part as a File: files are read relative to the scenario file. */
async function toFile(name: string, p: FilePart, base = process.cwd()): Promise<File> {
  if (p.file !== undefined) {
    const file = path.resolve(base, p.file);
    const bytes = await readFile(file).catch(() => {
      throw new Error(`field "${name}": can't read ${file}`);
    });
    const type = p.type ?? MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    return new File([new Uint8Array(bytes)], p.filename ?? path.basename(file), { type });
  }
  const content = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
  return new File([content], p.filename ?? name, { type: p.type ?? (typeof p.content === "string" ? "text/plain" : "application/json") });
}

/** A YAML `multipart:` mapping as FormData. */
async function multipart(fields: Record<string, unknown>, base?: string) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const part of Array.isArray(value) ? value : [value]) {
      if (part && typeof part === "object") data.append(name, await toFile(name, part as FilePart, base));
      else data.append(name, String(part));
    }
  }
  return data;
}

/** Submit fields with `{ file }` / `{ content }` values turned into Files. */
async function withFiles(fields: Record<string, unknown> | undefined, base?: string) {
  if (!fields) return undefined;
  const out: NonNullable<SubmitOptions["fields"]> = {};
  for (const [name, v] of Object.entries(fields)) {
    out[name] = v && typeof v === "object" && !Array.isArray(v) ? await toFile(name, v as FilePart, base) : (v as string);
  }
  return out;
}

function splitCall(s: string): [string, string] {
  const i = s.search(/\s/);
  return [s.slice(0, i).toUpperCase(), s.slice(i).trim()];
}

const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const PART = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Replace `{{name}}` in every string. A string that is only `{{name}}` takes
 * the variable's own type, so `id: "{{pollId}}"` stays a number.
 */
export function interpolate(value: unknown, vars: Vars): unknown {
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    if (whole) return resolve(whole[1]!, vars);
    return value.replace(PART, (_, name: string) => {
      const v = resolve(name, vars);
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)]));
  }
  return value;
}

/** `{{$seq}}`: 1, 2, 3… within a scenario, so generated values are unique and the same on every run. */
let seq = 0;

const OFFSET = /^\$(now|today|timestamp|timestampMs)\s*(?:([+-])\s*(\d+)\s*(ms|s|m|h|d))?$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Built-in values: `$uuid`, `$seq`, `$now`, `$today`, `$timestamp`, `$timestampMs` (the last four with `+1d`, `-30m`, …). */
function builtin(name: string): unknown {
  if (name === "$uuid") return crypto.randomUUID();
  if (name === "$seq") return ++seq;
  const m = OFFSET.exec(name);
  if (!m) throw new Error(`unknown built-in {{${name}}} (available: $uuid, $seq, $now, $today, $timestamp, $timestampMs; the time ones take an offset such as $now+1d or $timestamp-30m)`);
  const t = Date.now() + (m[2] ? (m[2] === "-" ? -1 : 1) * Number(m[3]) * UNIT_MS[m[4]!]! : 0);
  switch (m[1]) {
    case "now":
      return new Date(t).toISOString();
    case "today":
      return new Date(t).toISOString().slice(0, 10);
    case "timestamp":
      return Math.floor(t / 1000);
    default:
      return t;
  }
}

function resolve(name: string, vars: Vars) {
  if (name.startsWith("$")) return builtin(name);
  if (name.startsWith("env.") && !("env" in vars)) {
    const v = process.env[name.slice(4)];
    if (v === undefined) throw new Error(`{{${name}}}: the environment variable ${name.slice(4)} isn't set`);
    return v;
  }
  const v = lookup(vars, name);
  if (v === undefined) {
    const known = Object.keys(vars).filter((k) => k !== "call");
    throw new Error(`unknown variable {{${name}}}. Defined so far: ${known.join(", ") || "(none)"}`);
  }
  return v;
}

const TYPES: Record<string, unknown> = {
  string: expect.any(String),
  number: expect.any(Number),
  boolean: expect.any(Boolean),
  array: expect.any(Array),
  object: expect.any(Object),
};

const FORMATS: Record<string, RegExp | ((v: string) => boolean)> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  "date-time": /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i,
  time: /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i,
  uri: /^[a-z][a-z0-9+.-]*:\/\/\S+$/i,
  integer: /^-?\d+$/,
  ipv4: (v) => isIPv4(v),
  ipv6: (v) => isIPv6(v),
  hostname: /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i,
  // Crockford's base32: no I, L, O or U.
  ulid: /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i,
  // Three base64url parts whose first is a JSON header with `alg`; the signature isn't checked.
  jwt: (v) => {
    const parts = v.split(".");
    if (parts.length !== 3 || !parts.slice(0, 2).every((p) => /^[A-Za-z0-9_-]+$/.test(p)) || !/^[A-Za-z0-9_-]*$/.test(parts[2]!)) return false;
    try {
      return typeof JSON.parse(Buffer.from(parts[0]!, "base64url").toString()).alg === "string";
    } catch {
      return false;
    }
  },
};

const MATCHERS = ["$type", "$regex", "$options", "$contains", "$any", "$gt", "$gte", "$lt", "$lte", "$closeTo", "$len", "$not", "$oneOf", "$format"];

/** An asymmetric matcher Vitest's `toEqual` / `toMatchObject` call, with a readable name in diffs. */
function matcher(name: string, test: (v: unknown) => boolean) {
  return { asymmetricMatch: test, toAsymmetricMatcher: () => name, toString: () => name };
}

/** A decimal as Postgres `numeric` and MySQL `DECIMAL` columns come back, to keep their precision: `"12.50"`. */
const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Numbers compare as numbers, also with decimal strings from `numeric` / `DECIMAL` columns; strings
 * (ISO dates, versions) compare as strings; anything else never matches.
 */
function compare(op: string, arg: unknown, holds: (c: number) => boolean) {
  if (typeof arg !== "number" && typeof arg !== "string") throw new Error(`${op} takes a number or a string, got ${JSON.stringify(arg)}`);
  return matcher(`${op} ${JSON.stringify(arg)}`, (v) => {
    if (typeof arg === "number") return (typeof v === "number" || (typeof v === "string" && DECIMAL.test(v))) && holds(Number(v) - arg);
    return typeof v === "string" && holds(v < arg ? -1 : v > arg ? 1 : 0);
  });
}

function equalsMatcher(expected: unknown, actual: unknown) {
  return isAsymmetric(expected) ? (expected as { asymmetricMatch(v: unknown): boolean }).asymmetricMatch(actual) : subsetEquals(expected, actual);
}

/** `expected` contained in `actual`, with matchers anywhere: the rules of expected JSON. */
function subsetEquals(expected: unknown, actual: unknown): boolean {
  if (isAsymmetric(expected)) return (expected as { asymmetricMatch(v: unknown): boolean }).asymmetricMatch(actual);
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => subsetEquals(e, actual[i]));
  if (expected && typeof expected === "object") {
    return !!actual && typeof actual === "object" && Object.entries(expected).every(([k, v]) => k in actual && subsetEquals(v, (actual as Record<string, unknown>)[k]));
  }
  return Object.is(expected, actual) || expected === actual;
}

function regexOf(pattern: unknown, flags: unknown) {
  try {
    return new RegExp(String(pattern), flags === undefined ? undefined : String(flags));
  } catch (e) {
    const bad = flags !== undefined && /flags/i.test((e as Error).message);
    throw new Error(bad ? `$options ${JSON.stringify(flags)} has a flag JavaScript doesn't know (use i, m, s, u, g...)` : `$regex ${JSON.stringify(pattern)} isn't a valid regular expression: ${(e as Error).message}`);
  }
}

function single(key: string, arg: unknown, options?: unknown): unknown {
  switch (key) {
    case "$type":
      if (arg === "null") return null;
      if (arg === "integer") return matcher("$type integer", (v) => Number.isInteger(v));
      if (typeof arg === "string" && arg in TYPES) return TYPES[arg];
      throw new Error(`$type must be one of ${Object.keys(TYPES).join(", ")}, integer, null`);
    case "$regex":
      return expect.stringMatching(regexOf(arg, options));
    case "$contains":
      return matcher(`$contains ${JSON.stringify(arg)}`, (v) =>
        typeof v === "string" ? v.includes(String(arg)) : Array.isArray(v) ? v.some((item) => equalsMatcher(toMatchers(arg), item)) : false,
      );
    case "$any":
      return expect.anything();
    case "$gt":
      return compare(key, arg, (c) => c > 0);
    case "$gte":
      return compare(key, arg, (c) => c >= 0);
    case "$lt":
      return compare(key, arg, (c) => c < 0);
    case "$lte":
      return compare(key, arg, (c) => c <= 0);
    case "$closeTo": {
      // `$closeTo: 9.99` allows ±0.005 (two decimals, like toBeCloseTo); `$closeTo: [9.99, 0.1]` sets the tolerance.
      const [target, tolerance = 0.005] = Array.isArray(arg) ? arg : [arg];
      if (typeof target !== "number" || typeof tolerance !== "number" || !(tolerance >= 0)) throw new Error(`$closeTo takes a number or [number, tolerance], got ${JSON.stringify(arg)}`);
      return matcher(`$closeTo ${JSON.stringify(arg)}`, (v) => (typeof v === "number" || (typeof v === "string" && DECIMAL.test(v))) && Math.abs(Number(v) - target) <= tolerance + Number.EPSILON);
    }
    case "$len": {
      const want = toMatchers(arg);
      return matcher(`$len ${JSON.stringify(arg)}`, (v) => (typeof v === "string" || Array.isArray(v)) && equalsMatcher(want, v.length));
    }
    case "$not": {
      const want = toMatchers(arg);
      return matcher(`$not ${JSON.stringify(arg)}`, (v) => !equalsMatcher(want, v));
    }
    case "$oneOf": {
      if (!Array.isArray(arg)) throw new Error(`$oneOf takes a list, got ${JSON.stringify(arg)}`);
      const options = arg.map(toMatchers);
      return matcher(`$oneOf ${JSON.stringify(arg)}`, (v) => options.some((o) => equalsMatcher(o, v)));
    }
    case "$format": {
      const f = Object.hasOwn(FORMATS, String(arg)) ? FORMATS[String(arg)] : undefined;
      if (!f) throw new Error(`$format must be one of ${Object.keys(FORMATS).join(", ")}`);
      return matcher(`$format ${arg}`, (v) => typeof v === "string" && (typeof f === "function" ? f(v) : f.test(v)));
    }
    default:
      throw new Error(`unknown matcher ${key} (expected one of ${MATCHERS.join(", ")})`);
  }
}

/**
 * `{ $type: number }`, `{ $regex: "^ch_" }`, `{ $contains: "x" }`, `{ $any: true }`,
 * `{ $gte: 1, $lt: 10 }`, `{ $len: 3 }`, `{ $not: … }`, `{ $oneOf: [...] }` and
 * `{ $format: uuid }` become Vitest asymmetric matchers. Several `$` keys must all hold.
 */
export function toMatchers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toMatchers);
  if (!value || typeof value !== "object" || isAsymmetric(value)) return value;
  const keys = Object.keys(value);
  if (keys.length > 0 && keys.every((k) => k.startsWith("$"))) {
    const given = value as Record<string, unknown>;
    // `$options` is the flags of the `$regex` next to it, not a matcher of its own.
    if ("$options" in given && !("$regex" in given)) throw new Error("$options belongs with $regex, e.g. { $regex: \"^ab\", $options: \"i\" }");
    const own = keys.filter((k) => k !== "$options");
    const parts = own.map((k) => single(k, given[k], given.$options));
    if (parts.length === 1) return parts[0];
    return matcher(keys.map((k) => `${k} ${JSON.stringify((value as Record<string, unknown>)[k])}`).join(", "), (v) => parts.every((p) => equalsMatcher(p, v)));
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toMatchers(v)]));
}

function isAsymmetric(v: unknown) {
  return !!v && typeof v === "object" && typeof (v as { asymmetricMatch?: unknown }).asymmetricMatch === "function";
}

function verifyResponse(res: HttpResponse, e: { events?: Record<string, unknown>[]; cookies?: Record<string, Record<string, unknown> | null>; duration?: number | Record<string, unknown>; status?: ExpectedStatus; headers?: Record<string, unknown>; json?: unknown; text?: unknown; schema?: string | object } | undefined, vars: Vars, base?: string) {
  if (e?.status !== undefined) expect(res).toHaveStatus(interpolate(e.status, vars) as never);
  if (e?.headers !== undefined) {
    // `null`: the response must not send that header (`x-powered-by: null`), as in `cookies`.
    const entries = Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), v] as const);
    for (const [name] of entries.filter(([, v]) => v === null)) {
      const sent = res.headers.get(name);
      if (sent !== null) throw new Error(`${res.method} ${res.url}: expected no ${name} header, got ${JSON.stringify(sent)}`);
    }
    check(Object.fromEntries(res.headers), Object.fromEntries(entries.filter(([, v]) => v !== null)), vars, "response headers");
  }
  if (e?.json !== undefined) check(res.json, e.json, vars, "response JSON");
  if (e?.text !== undefined) check(res.text, e.text, vars, "response text");
  if (e?.events !== undefined) {
    if (!res.events) throw new Error(`${res.method} ${res.url}: expected server-sent events, but the response is ${res.headers.get("content-type") ?? "without a content type"}, not text/event-stream`);
    const wanted = toMatchers(interpolate(e.events, vars)) as unknown[];
    let at = 0;
    for (const [i, want] of wanted.entries()) {
      const found = res.events.findIndex((ev, j) => j >= at && subsetEquals(want, ev));
      if (found < 0) {
        const shown = res.events.slice(0, 20).map((ev, j) => `  ${j}: ${JSON.stringify(ev).slice(0, 200)}`).join("\n");
        throw new Error(
          `${res.method} ${res.url}: expected event ${i + 1} of ${wanted.length}, ${JSON.stringify(e.events[i])}, ${at > 0 ? `after event ${at - 1}` : "in the stream"}; ${res.events.length} event(s) arrived:\n${shown || "  (none)"}${res.events.length > 20 ? "\n  …" : ""}`,
        );
      }
      at = found + 1;
    }
  }
  if (e?.cookies !== undefined) {
    for (const [name, attrs] of Object.entries(e.cookies)) {
      if (attrs === null) expect(res).not.toSetCookie(name);
      else expect(res).toSetCookie(name, toMatchers(interpolate(attrs, vars)) as Record<string, unknown>);
    }
  }
  if (e?.duration !== undefined) {
    const want = interpolate(e.duration, vars);
    if (typeof want === "number") expect(res).toRespondWithin(want);
    else check(res.durationMs, want, vars, `${res.method} ${res.url} response time (${res.durationMs}ms)`);
  }
  if (e?.schema !== undefined) {
    const problems = schemaProblems(e.schema, res.json, base);
    if (problems.length) throw new Error(`${res.method} ${res.url}: the response JSON doesn't match ${typeof e.schema === "string" ? e.schema : "the schema"}:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }
}
