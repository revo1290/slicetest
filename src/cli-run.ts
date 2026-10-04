import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { editDistance } from "./config.js";

export interface RunFlags {
  update?: boolean;
  reporter?: string[];
  "output-file"?: string;
  shard?: string;
}

/** Vitest options for the run flags of `npx slicetest`; paths are taken from where the command runs, like `--diagrams`. */
export function runOptions(flags: RunFlags, cwd = process.cwd()) {
  if (flags.shard !== undefined) {
    const m = /^(\d+)\/(\d+)$/.exec(flags.shard);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) throw new Error(`slicetest: --shard takes <index>/<count> with 1 ≤ index ≤ count, e.g. --shard 1/3, got "${flags.shard}"`);
  }
  return {
    ...(flags.update ? { update: true } : {}),
    ...(flags.reporter?.length ? { reporters: flags.reporter } : {}),
    ...(flags["output-file"] ? { outputFile: path.resolve(cwd, flags["output-file"]) } : {}),
    ...(flags.shard ? { shard: flags.shard } : {}),
  };
}

const OPTIONS = {
  config: { type: "string", short: "c" },
  watch: { type: "boolean", short: "w" },
  name: { type: "string", short: "t" },
  tag: { type: "string", multiple: true },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  force: { type: "boolean" },
  spec: { type: "string" },
  out: { type: "string" },
  uncovered: { type: "boolean" },
  port: { type: "string" },
  diagrams: { type: "string" },
  stub: { type: "string" },
  upstream: { type: "string" },
  json: { type: "boolean" },
  update: { type: "boolean", short: "u" },
  reporter: { type: "string", multiple: true },
  "output-file": { type: "string" },
  shard: { type: "string" },
} as const;

/** parseArgs, with its errors worded for this CLI (and a guess at a misspelt option). */
export function parseCliArgs(argv: string[]) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const unknown = /^Unknown option '(-{1,2}[^']*)'/.exec(err.message ?? "")?.[1];
    if (err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && unknown) {
      const name = unknown.replace(/^-+/, "");
      const near = Object.keys(OPTIONS)
        .map((k) => ({ k, d: editDistance(k, name.toLowerCase()) }))
        .filter(({ k, d }) => d <= Math.max(2, Math.floor(name.length / 3)) || (name.length >= 3 && k.startsWith(name.toLowerCase())))
        .sort((a, b) => a.d - b.d)[0];
      throw new Error(`slicetest: unknown option ${unknown}${near ? `; did you mean --${near.k}?` : ""} (see npx slicetest --help)`);
    }
    // A missing value (`--config` last on the line) and the like: node's own wording says what is wrong.
    throw new Error(`slicetest: ${err.message ?? e} (see npx slicetest --help)`);
  }
}

/** This package's version: the package.json next to dist/ (and next to src/ when run from a checkout). */
export async function packageVersion() {
  const file = new URL("../package.json", import.meta.url);
  return (JSON.parse(await readFile(file, "utf8")) as { version: string }).version;
}
