import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import type { RecordedCall, StubResponse } from "./stub.js";

/** One recorded exchange with the real service, as stored in the recordings file. */
export interface Recording {
  request: { method: string; path: string; query?: Record<string, string>; json?: unknown; body?: string };
  response: { status: number; headers?: Record<string, string>; json?: unknown; body?: string };
}

/**
 * Response headers worth keeping. Everything else (dates, cookies, rate-limit
 * counters, request ids) is noise in a committed file, or a secret.
 */
const KEPT_HEADERS = ["content-type", "location", "retry-after", "link", "etag"];

/** Request headers not forwarded to the real service. */
const HOP_HEADERS = ["host", "connection", "content-length", "accept-encoding", "transfer-encoding", "keep-alive"];

/**
 * Replays recorded exchanges for calls no route matches and, in record mode,
 * forwards the calls it has no recording for to the real service and records
 * the answer. Identical requests replay their recordings in order within a
 * scenario; the last one repeats.
 */
export class Recorder {
  #entries: Recording[];
  #added: Recording[] = [];
  #seen = new Map<string, number>();

  private constructor(
    readonly name: string,
    readonly file: string,
    readonly upstream: string,
    readonly recording: boolean,
    entries: Recording[],
  ) {
    this.#entries = entries;
  }

  static async load(name: string, file: string, upstream: string, recording: boolean) {
    return new Recorder(name, file, upstream, recording, await readRecordings(file));
  }

  /** What recording a call gets, or undefined to leave it unanswered. */
  async answer(call: RecordedCall): Promise<StubResponse | undefined> {
    const request = requestOf(call);
    const key = keyOf(request);
    const matches = this.#entries.filter((e) => keyOf(e.request) === key);
    const n = this.#seen.get(key) ?? 0;
    this.#seen.set(key, n + 1);
    if (matches.length > 0 && (!this.recording || n < matches.length)) return toResponse(matches[Math.min(n, matches.length - 1)]!);
    if (!this.recording) return undefined;

    const entry: Recording = { request, response: await this.#forward(call) };
    this.#entries.push(entry);
    this.#added.push(entry);
    return toResponse(entry);
  }

  /** Why a call went unanswered, for the stub's 501 reply. */
  hint() {
    return `no recording in ${this.file} either; run with SLICETEST_RECORD=${this.name} to record it from ${this.upstream}`;
  }

  /** Start of a scenario: identical requests replay from their first recording again. */
  reset() {
    this.#seen.clear();
  }

  /** Recordings made by this worker, to be merged into the file when the run ends. */
  added() {
    return this.#added;
  }

  async #forward(call: RecordedCall): Promise<Recording["response"]> {
    const url = new URL(this.upstream);
    // Keep a path prefix on the upstream (e.g. https://api.example.com/v2) in front of the call's path.
    url.pathname = url.pathname.replace(/\/$/, "") + call.path;
    url.search = call.query.toString();
    const headers = new Headers();
    for (const [k, v] of Object.entries(call.headers)) {
      if (v !== undefined && !HOP_HEADERS.includes(k)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    let res: Response;
    try {
      res = await fetch(url, { method: call.method, headers, body: ["GET", "HEAD"].includes(call.method) ? undefined : call.body });
    } catch (e) {
      throw new Error(`slicetest: recording stub ${this.name}: ${call.method} ${url} failed: ${(e as Error).message}`);
    }
    const text = await res.text();
    const kept = Object.fromEntries(KEPT_HEADERS.flatMap((h) => (res.headers.has(h) ? [[h, res.headers.get(h)!]] : [])));
    const json = parse(text);
    return {
      status: res.status,
      ...(Object.keys(kept).length ? { headers: kept } : {}),
      ...(json !== undefined ? { json } : text ? { body: text } : {}),
    };
  }
}

function requestOf(call: RecordedCall): Recording["request"] {
  const query = Object.fromEntries([...call.query.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return {
    method: call.method,
    path: call.path,
    ...(Object.keys(query).length ? { query } : {}),
    ...(call.json !== undefined ? { json: call.json } : call.body ? { body: call.body } : {}),
  };
}

function keyOf(r: Recording["request"]) {
  return JSON.stringify([r.method.toUpperCase(), r.path, sortKeys(r.query ?? {}), sortKeys(r.json ?? null), r.body ?? ""]);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

function toResponse(e: Recording): StubResponse {
  return { status: e.response.status, headers: e.response.headers, body: e.response.json !== undefined ? e.response.json : (e.response.body ?? "") };
}

function parse(text: string) {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function readRecordings(file: string): Promise<Recording[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const doc = YAML.parse(text) as unknown;
  if (doc == null) return [];
  if (!Array.isArray(doc) || !doc.every((e) => e?.request?.method && e?.request?.path && typeof e?.response?.status === "number")) {
    throw new Error(`slicetest: ${file} is not a recordings file: expected a list of { request: { method, path }, response: { status } }`);
  }
  return doc as Recording[];
}

/** Append new recordings to `file`, skipping exact duplicates, keeping the order they were made in. */
export async function mergeRecordings(file: string, upstream: string, added: Recording[]) {
  const entries = await readRecordings(file);
  for (const e of added) if (!entries.some((x) => isDeepStrictEqual(x, e))) entries.push(e);
  await mkdir(path.dirname(file), { recursive: true });
  const header = `# Recorded by slicetest from ${upstream}. Review before committing: request bodies are stored as sent.\n`;
  await writeFile(file, header + YAML.stringify(entries, { lineWidth: 0 }));
}
