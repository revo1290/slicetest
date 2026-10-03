import path from "node:path";

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
