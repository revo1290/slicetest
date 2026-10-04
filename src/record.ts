import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { stringify } from "yaml";
import type { Changes } from "./db.js";
import type { ScenarioContext } from "./runtime.js";
import { parseForm, type RecordedCall } from "./stub.js";
import { mask } from "./trace.js";
import { requestUrl } from "./request-url.js";

/**
 * `npx slicetest record`: use the app for real (a browser, curl, a mobile
 * client) through a proxy, and get the session back as a YAML scenario: the
 * requests, the responses to expect, the stubbed services' replies and the
 * database changes. The session runs as one long scenario, so the app, the
 * database and the stubs are the same ones the tests use.
 */

/** Passed from the CLI to the session through the environment. */
export interface RecordSession {
  /** Written by the session: `{ "url": … }` once the proxy listens, `{ "done": … }` at the end. */
  stateFile: string;
  /** Created by the CLI when the user is done. */
  stopFile: string;
  out: string;
  port: number;
  stubs: string[];
}

export const SESSION_ENV = "SLICETEST_RECORD_SESSION";

export interface Exchange {
  method: string;
  path: string;
  contentType?: string;
  body: string;
  status: number;
  responseType?: string;
  response: string;
}

/** Requests a browser makes on its own, not part of what the scenario is about. */
const ASSET = /\.(ico|png|jpe?g|gif|webp|avif|svg|css|js|mjs|map|woff2?|ttf|eot)(\?|$)/i;
/** Hop-by-hop headers, and the ones fetch rewrites. */
const DROP_REQUEST = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "content-length", "accept-encoding"]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]);

export async function runSession(ctx: ScenarioContext, session: RecordSession) {
  const exchanges: Exchange[] = [];
  const target = ctx.app.url;
  const proxy = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || DROP_REQUEST.has(k)) continue;
      for (const value of Array.isArray(v) ? v : [v]) headers.append(k, value);
    }
    try {
      const upstream = await fetch(requestUrl(req.url, target), {
        method: req.method,
        headers,
        body: body.length && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
        redirect: "manual",
      });
      const payload = Buffer.from(await upstream.arrayBuffer());
      const out: Record<string, string | string[]> = {};
      upstream.headers.forEach((v, k) => {
        if (!DROP_RESPONSE.has(k) && k !== "set-cookie") out[k] = v;
      });
      const cookies = upstream.headers.getSetCookie();
      if (cookies.length) out["set-cookie"] = cookies;
      res.writeHead(upstream.status, out).end(payload);
      exchanges.push({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        contentType: req.headers["content-type"],
        body: body.toString("utf8"),
        status: upstream.status,
        responseType: upstream.headers.get("content-type") ?? undefined,
        response: payload.toString("utf8"),
      });
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain" }).end(`slicetest record: the app didn't answer: ${(e as Error).message}\n`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(session.port, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  await writeFile(session.stateFile, JSON.stringify({ url, app: target }));

  while (!existsSync(session.stopFile)) await new Promise((r) => setTimeout(r, 200));
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  proxy.closeAllConnections();

  const calls = Object.fromEntries(session.stubs.map((name) => [name, ctx.stub(name).calls()]));
  const changes = await ctx.db.changes();
  const { yaml, summary } = buildScenario(exchanges, calls, changes, { name: path.basename(session.out).replace(/\.scenario\.ya?ml$/, "") });
  await writeFile(session.out, yaml);
  await writeFile(session.stateFile, JSON.stringify({ url, done: true, summary }));
}

export interface Summary {
  requests: number;
  skippedAssets: number;
  stubs: number;
  tables: string[];
  unanswered: string[];
}

/** The recorded session as a YAML scenario, with a comment header of what to review. */
export function buildScenario(exchanges: Exchange[], calls: Record<string, RecordedCall[]>, changes: Changes, { name = "recorded session", now = new Date() } = {}) {
  const kept = exchanges.filter((x) => !ASSET.test(x.path));
  const steps: Record<string, unknown>[] = [];
  const notes: string[] = [];

  // Stubs first: the answers the services gave, so the replay doesn't need them.
  const unanswered: string[] = [];
  let stubRoutes = 0;
  for (const [stub, list] of Object.entries(calls)) {
    const groups = new Map<string, RecordedCall[]>();
    for (const c of list) {
      if (!c.response || c.response.status === 501) {
        unanswered.push(`${stub}: ${c.method} ${c.path}`);
        continue;
      }
      const key = `${c.method} ${c.path}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    for (const [on, group] of groups) {
      const replies = group.map((c) => ({ status: c.response!.status, ...(c.response!.body ? { body: parse(c.response!.body, c.response!.headers["content-type"]) } : {}) }));
      const same = replies.every((r) => JSON.stringify(r) === JSON.stringify(replies[0]));
      steps.push({ stub, on, ...(same ? { reply: replies[0] } : { sequence: replies }) });
      stubRoutes++;
    }
  }
  if (unanswered.length) notes.push(`These calls got no answer while recording (register a route, or give the stub an upstream / autoReply): ${unanswered.join(", ")}`);

  // Values from earlier responses that later requests use (ids in paths, tokens in bodies) become captures.
  const captured = new Map<string, string>();
  kept.forEach((x, i) => {
    let reqPath = x.path;
    let reqBody = x.body;
    for (const [value, variable] of captured) {
      reqPath = reqPath.split(value).join(`{{${variable}}}`);
      reqBody = reqBody.split(value).join(`{{${variable}}}`);
    }
    const [method, pathOnly] = [x.method, reqPath];
    const step: Record<string, unknown> = { request: `${method} ${pathOnly}` };
    if (x.body) {
      if (/json/i.test(x.contentType ?? "")) step.json = parse(reqBody, "application/json");
      // Nested and repeated fields survive: `form:` is encoded back the same way on replay.
      else if (/x-www-form-urlencoded/i.test(x.contentType ?? "")) step.form = parseForm(reqBody);
      else step.body = reqBody;
    }
    const expectation: Record<string, unknown> = { status: x.status };
    const json = /json/i.test(x.responseType ?? "") ? parse(x.response, "application/json") : undefined;
    if (json !== undefined && typeof json === "object") expectation.json = loosen(json);
    else if (!/html/i.test(x.responseType ?? "") && x.response && x.response.length <= 200) expectation.text = x.response;
    step.expect = expectation;

    // Capture top-level values that show up again later.
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const later = kept.slice(i + 1).map((y) => `${y.path}\n${y.body}`).join("\n");
      const capture: Record<string, string> = {};
      for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
        if ((typeof value !== "string" && typeof value !== "number") || String(value).length < 3 || !later.includes(String(value))) continue;
        let variable = key.replace(/\W/g, "_");
        while ([...captured.values()].includes(variable)) variable += "_";
        capture[variable] = `json.${key}`;
        captured.set(String(value), variable);
      }
      if (Object.keys(capture).length) step.capture = capture;
    }
    steps.push(step);
  });

  for (const [stub, list] of Object.entries(calls)) {
    const byCall = new Map<string, number>();
    for (const c of list) if (c.response && c.response.status !== 501) byCall.set(`${c.method} ${c.path}`, (byCall.get(`${c.method} ${c.path}`) ?? 0) + 1);
    for (const [call, times] of byCall) steps.push({ received: stub, call, times });
  }

  const tables = Object.keys(changes);
  const counts = Object.fromEntries(
    Object.entries(changes).map(([table, c]) => [
      table,
      Object.fromEntries(Object.entries({ inserted: c.inserted.length, updated: c.updated.length, deleted: c.deleted.length }).filter(([, n]) => n > 0)),
    ]),
  );
  steps.push({ changes: counts });

  const skipped = exchanges.length - kept.length;
  if (skipped) notes.push(`${skipped} request(s) for static files (scripts, styles, images) were left out.`);
  if (kept.length === 0) notes.push("No requests to the app were recorded; send them to the proxy URL printed when recording started.");
  const header = [
    `# Recorded with \`npx slicetest record\` on ${now.toISOString().slice(0, 10)}. Review it before committing:`,
    "# - give the scenario a name that says what it checks, and split it if it checks several things;",
    "# - dates and UUIDs in responses are matched by type only, and `changes` only counts rows;",
    "#   tighten what matters (see https://github.com/revo1290/slicetest#yaml-scenarios).",
    ...notes.map((n) => `# - ${n}`),
    "# yaml-language-server: $schema=https://unpkg.com/slicetest/schema/scenario.schema.json",
    "",
  ].join("\n");
  const yaml = header + stringify({ scenarios: [{ name, steps }] }, { lineWidth: 0 });
  const summary: Summary = { requests: kept.length, skippedAssets: skipped, stubs: stubRoutes, tables, unanswered };
  return { yaml, summary };
}

function parse(text: string, contentType: string | undefined): unknown {
  if (/json/i.test(contentType ?? "")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** Dates and UUIDs change from run to run: expect their type instead of their value. */
function loosen(value: unknown): unknown {
  const walk = (v: unknown): unknown => {
    if (v === "[date]" || v === "[uuid]") return { $type: "string" };
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(mask(value));
}
