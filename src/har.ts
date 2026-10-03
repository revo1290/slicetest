import { readFile } from "node:fs/promises";
import path from "node:path";
import { mergeRecordings, redactRequest, type Recording } from "./recording.js";

/**
 * `slicetest import session.har`: turn a HAR file (saved from the browser's
 * network panel, Charles, mitmproxy, Proxyman, Postman, …) into recordings a
 * stub replays, without running the app against the real service first.
 */

interface HarEntry {
  request: { method: string; url: string; postData?: { mimeType?: string; text?: string } };
  response: { status: number; headers?: { name: string; value: string }[]; content?: { mimeType?: string; text?: string; encoding?: string } };
}

export interface HarTarget {
  /** Stub name. */
  name: string;
  /** The real service's base URL; entries under it become recordings, with this prefix removed from their path. */
  upstream: string;
  /** Recordings file, absolute. */
  file: string;
}

const KEPT_HEADERS = ["content-type", "location", "retry-after", "link", "etag"];
const TEXTUAL = /json|text|xml|javascript|x-www-form-urlencoded|graphql/i;

export function harEntries(har: unknown, file = "the HAR file"): HarEntry[] {
  const entries = (har as { log?: { entries?: unknown } } | null)?.log?.entries;
  if (!Array.isArray(entries)) throw new Error(`slicetest import: ${file} is not a HAR file (no log.entries)`);
  return entries as HarEntry[];
}

/** The entry as a recording, if it is under `upstream` and replayable; otherwise why not. */
export function toRecording(entry: HarEntry, upstream: string): Recording | "elsewhere" | "skipped" {
  const base = new URL(upstream);
  let url: URL;
  try {
    url = new URL(entry.request.url);
  } catch {
    return "skipped";
  }
  const prefix = base.pathname.replace(/\/$/, "");
  if (url.host !== base.host || !(url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) return "elsewhere";
  const method = entry.request.method.toUpperCase();
  // Preflights are the browser's; aborted and blocked requests (status 0) have no answer to replay.
  if (method === "OPTIONS" || !entry.response || !entry.response.status) return "skipped";

  const query = Object.fromEntries([...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const sent = entry.request.postData?.text;
  const json = parse(sent);
  const request: Recording["request"] = redactRequest({
    method,
    path: url.pathname.slice(prefix.length) || "/",
    ...(Object.keys(query).length ? { query } : {}),
    ...(json !== undefined ? { json } : sent ? { body: sent } : {}),
  });

  const content = entry.response.content ?? {};
  let text = content.text ?? "";
  if (content.encoding === "base64" && text) {
    if (!TEXTUAL.test(content.mimeType ?? "")) return "skipped";
    text = Buffer.from(text, "base64").toString("utf8");
  }
  const headers = Object.fromEntries(
    (entry.response.headers ?? []).flatMap((h) => (KEPT_HEADERS.includes(h.name.toLowerCase()) ? [[h.name.toLowerCase(), h.value]] : [])),
  );
  const body = parse(text);
  return {
    request,
    response: {
      status: entry.response.status,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(body !== undefined ? { json: body } : text ? { body: text } : {}),
    },
  };
}

export async function importHar(harFile: string, targets: HarTarget[]) {
  const text = await readFile(harFile, "utf8");
  let har: unknown;
  try {
    har = JSON.parse(text);
  } catch (e) {
    throw new Error(`slicetest import: ${harFile} is not JSON: ${(e as Error).message}`);
  }
  const entries = harEntries(har, harFile);
  const written: { name: string; file: string; count: number }[] = [];
  const claimed = new Set<HarEntry>();
  let skipped = 0;
  for (const t of targets) {
    const recordings: Recording[] = [];
    for (const e of entries) {
      const r = toRecording(e, t.upstream);
      if (r === "elsewhere") continue;
      claimed.add(e);
      if (r === "skipped") skipped++;
      else recordings.push(r);
    }
    if (recordings.length === 0) continue;
    await mergeRecordings(t.file, t.upstream, recordings, `Imported by slicetest from ${path.basename(harFile)} (${t.upstream})`);
    written.push({ name: t.name, file: t.file, count: recordings.length });
  }
  const others = new Map<string, number>();
  for (const e of entries) {
    if (claimed.has(e)) continue;
    try {
      const host = new URL(e.request.url).origin;
      others.set(host, (others.get(host) ?? 0) + 1);
    } catch {}
  }
  return { written, skipped, others: [...others].sort((a, b) => b[1] - a[1]) };
}

function parse(text: string | undefined) {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
