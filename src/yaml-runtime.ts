import { expect, inject } from "vitest";
import { recordYamlFailure } from "./ci.js";
import "./provided.js";
import { formatChanges } from "./db.js";
import "./matchers.js";
import type { ScenarioContext } from "./runtime.js";
import { scenario } from "./scenario.js";
import type { HttpResponse } from "./http.js";
import type { MailFilter } from "./mail.js";
import { signWebhook, webhookBody, type WebhookOptions } from "./webhook.js";
import { sse, type MatchOptions, type RecordedCall, type ServerSentEvent, type StubResponse } from "./stub.js";
import type { ChangeSpec, Conditions, Step, YamlFile, YamlScenario } from "./yaml.js";

type Vars = Record<string, unknown>;

/** Registers the scenarios of one parsed YAML file. Called from the module the plugin generates for it. */
export function defineYamlScenarios(doc: YamlFile) {
  for (const sc of doc.scenarios) {
    const register = sc.only ? scenario.only : sc.skip ? scenario.skip : scenario;
    const rows = sc.each ?? [undefined];
    rows.forEach((row, i) => {
      const title = row ? interpolateTitle(sc.name, row, i) : sc.name;
      register(title, (ctx) => runSteps(doc, sc, [...doc.setup, ...sc.steps], ctx, { ...row }), sc.timeout);
    });
  }
}

async function runSteps(doc: YamlFile, sc: YamlScenario, steps: Step[], ctx: ScenarioContext, vars: Vars) {
  for (const [i, step] of steps.entries()) {
    try {
      // A log step waits by itself; `within` is its timeout.
      // Log and mail steps wait by themselves; `within` is their timeout.
      await retry("within" in step && !("log" in step) && !("mail" in step) ? step.within : undefined, () => runStep(step, ctx, vars));
    } catch (e) {
      const label = step.name ?? describeStep(step);
      const where = `${doc.file}:${step.line} (${sc.name}, step ${i + 1}: ${label})`;
      const ciDir = inject("slicetestDb")?.ciDir;
      if (ciDir && doc.path) {
        const message = (e instanceof Error ? e.message : String(e)).replace(/\x1b\[[0-9;]*m/g, "");
        await recordYamlFailure(ciDir, { file: doc.path, line: step.line, scenario: sc.name, step: `step ${i + 1}: ${label}`, message }).catch(() => {});
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
  if ("submit" in step) return step.submit === true ? "submit" : `submit ${JSON.stringify(step.submit)}`;
  if ("request" in step) return step.concurrency ? `${step.request} ×${step.concurrency}` : step.request;
  if ("stub" in step) return `stub ${step.stub} ${step.on}`;
  if ("received" in step) return `received ${step.received}${step.call ? ` ${step.call}` : ""}`;
  if ("insert" in step) return `insert ${step.insert}`;
  if ("make" in step) return `make ${step.make}`;
  if ("chaos" in step) return `chaos ${step.chaos}`;
  if ("db" in step) return `db ${step.db}`;
  if ("changes" in step) return "changes";
  if ("checkpoint" in step) return "checkpoint";
  if ("snapshot" in step) return "snapshot";
  if ("mail" in step) return `mail${Object.entries(step.mail).map(([k, v]) => ` ${k}: ${JSON.stringify(v)}`).join(",")}`;
  if ("log" in step) return `log ${step.from ? `from ${step.from} ` : ""}/${step.log}/`;
  return "sql";
}

/** Run `fn` until it passes or `within` ms have passed, then rethrow its last error. */
async function retry(within: number | undefined, fn: () => Promise<void>) {
  if (!within) return fn();
  const deadline = Date.now() + within;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() >= deadline) {
        if (e instanceof Error) e.message = `${e.message}\n(still failing after retrying for ${within}ms)`;
        throw e;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function runStep(step: Step, ctx: ScenarioContext, vars: Vars) {
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
        const re = v && typeof v === "object" && "$regex" in v ? new RegExp(String((v as { $regex: unknown }).$regex)) : undefined;
        return [k, re ?? String(v)];
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
    const actual = await ctx.db.changes();
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
    const [method, path] = splitCall(step.on);
    let route = ctx.stub(step.stub).on(method, interpolate(path, vars) as string, conditions(step.when, vars));
    if (step.times !== undefined) route = route.times(step.times);
    if (step.delay !== undefined) route = route.delay(step.delay);
    // Replies are interpolated when a call arrives, so they can echo it: {{call.params.id}}, {{call.json.name}}.
    const answer = (template: unknown) => (call: RecordedCall) => {
      const { sse: events, ...response } = interpolate(template, { ...vars, call: callVars(call) }) as StubResponse & { sse?: ServerSentEvent[] };
      return events ? sse(events, response) : response;
    };
    if (step.networkError) route.networkError();
    else if (step.sequence) {
      let n = 0;
      const seq = step.sequence;
      route.reply((call) => answer(seq[Math.min(n++, seq.length - 1)])(call));
    } else route.reply(answer(step.reply ?? {}));
    return;
  }

  if ("submit" in step) {
    const page = ctx.http.history.at(-1);
    if (!page) throw new Error("submit needs a page with a form: request it first, e.g. `- request: GET /signup`");
    const res = await ctx.http.submit(page, {
      button: step.submit === true ? undefined : (interpolate(step.submit, vars) as string),
      form: interpolate(step.form, vars) as string | number | undefined,
      fields: interpolate(step.fields, vars) as Record<string, string>,
      headers: interpolate(step.headers, vars) as Record<string, string> | undefined,
      follow: step.follow,
    });
    verifyResponse(res, step.expect, vars);
    capture(step.capture, { status: res.status, json: res.json, text: res.text, headers: Object.fromEntries(res.headers) }, vars);
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
    };
    let body =
      step.json !== undefined
        ? interpolate(step.json, vars)
        : step.form !== undefined
          ? ctx.http.form(interpolate(step.form, vars) as Record<string, string>)
          : (interpolate(step.body, vars) as string | undefined);
    if (step.webhook) {
      const signed = webhookBody(body);
      body = signed.body;
      opts.headers = { "content-type": signed.type, ...signWebhook(signed.body, interpolate(step.webhook, vars) as WebhookOptions), ...opts.headers };
    }
    const e = step.expect;
    const verify = (res: HttpResponse) => verifyResponse(res, e, vars);
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
    capture(step.capture, { status: res.status, json: res.json, text: res.text, headers: Object.fromEntries(res.headers) }, vars);
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
  const match = conditions(step.when, vars);
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
    body: call.body,
  };
}

function splitCall(s: string): [string, string] {
  const i = s.search(/\s/);
  return [s.slice(0, i).toUpperCase(), s.slice(i).trim()];
}

/** `json.items[0].id` or `json.items.0.id` */
export function lookup(obj: unknown, path: string): unknown {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((cur, key) => (cur == null ? undefined : (cur as Record<string, unknown>)[key]), obj);
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

function resolve(name: string, vars: Vars) {
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

/**
 * `{ $type: number }`, `{ $regex: "^ch_" }`, `{ $contains: "x" }` and
 * `{ $any: true }` become Vitest asymmetric matchers.
 */
export function toMatchers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toMatchers);
  if (!value || typeof value !== "object" || isAsymmetric(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0]!.startsWith("$")) {
    const [key] = keys as [string];
    const arg = (value as Record<string, unknown>)[key];
    switch (key) {
      case "$type":
        if (arg === "null") return null;
        if (typeof arg === "string" && arg in TYPES) return TYPES[arg];
        throw new Error(`$type must be one of ${Object.keys(TYPES).join(", ")}, null`);
      case "$regex":
        return expect.stringMatching(new RegExp(String(arg)));
      case "$contains":
        return expect.stringContaining(String(arg));
      case "$any":
        return expect.anything();
      default:
        throw new Error(`unknown matcher ${key} (expected $type, $regex, $contains, $any)`);
    }
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toMatchers(v)]));
}

function isAsymmetric(v: unknown) {
  return !!v && typeof v === "object" && typeof (v as { asymmetricMatch?: unknown }).asymmetricMatch === "function";
}

function interpolateTitle(name: string, row: Record<string, unknown>, index: number) {
  return name.replace(PART, (m, key: string) => {
    if (key.trim() === "#") return String(index);
    const v = lookup(row, key);
    return v === undefined ? m : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

function verifyResponse(res: HttpResponse, e: { status?: number; headers?: Record<string, unknown>; json?: unknown; text?: unknown } | undefined, vars: Vars) {
  if (e?.status !== undefined) expect(res).toHaveStatus(interpolate(e.status, vars) as number);
  if (e?.headers !== undefined) {
    const expected = Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), v]));
    check(Object.fromEntries(res.headers), expected, vars, "response headers");
  }
  if (e?.json !== undefined) check(res.json, e.json, vars, "response JSON");
  if (e?.text !== undefined) check(res.text, e.text, vars, "response text");
}
