#!/usr/bin/env node
/**
 * `npx slicetest`: run YAML scenarios without writing any JavaScript.
 * Reads slicetest.config.yaml (the same options as the Vitest plugin) and
 * drives Vitest programmatically.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import type { SlicetestOptions } from "./config.js";

const CONFIG_NAMES = ["slicetest.config.yaml", "slicetest.config.yml", "slicetest.config.json"];

const HELP = `Usage: slicetest [filters...] [options]
       slicetest init [--force]
       slicetest gen [--spec <file>] [--out <dir>] [--uncovered] [--force]

Runs *.scenario.yaml files against your app, as configured in slicetest.config.yaml.
\`slicetest init\` looks at the project and writes a starting config and scenario.
\`slicetest gen\` writes scenario skeletons for the documented responses of the
app's OpenAPI spec; with --uncovered, only for those the last run didn't produce.

Options:
  -c, --config <file>  Config file (default: ${CONFIG_NAMES.join(" / ")} in the current directory)
  -w, --watch          Re-run on changes
  -t, --name <pattern> Only run scenarios whose name matches
      --spec <file>    gen: OpenAPI file (default: \`openapi\` from the config)
      --out <dir>      gen: where to write scenarios (default: scenarios)
      --uncovered      gen: only responses the last run didn't cover
      --force          init, gen: overwrite existing files
  -h, --help           Show this help

Config (paths are relative to the config file):
  app:      { command, env, cwd, ready: { path } | { log }, readyTimeout }
  db:       { migrate: { atlas: { dir } } | { sql } | { command, inputs }, engine, seed, url, image, schemas, keep, reuse }
  stubs:    [name | { name, openapi, autoReply, upstream, recordings }]
  services: { name: { command, env, cwd, ready } }
  containers: { name: { image, port, env, command, ready: { log }, reset } }
  openapi:  file | { spec, minCoverage }
  http:     { headers, query }
  include:  [globs]  default ["**/*.scenario.{yaml,yml}"]
`;

export interface CliConfig extends SlicetestOptions {
  include?: string[];
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      watch: { type: "boolean", short: "w" },
      name: { type: "string", short: "t" },
      help: { type: "boolean", short: "h" },
      force: { type: "boolean" },
      spec: { type: "string" },
      out: { type: "string" },
      uncovered: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (positionals[0] === "init") {
    const { init } = await import("./init.js");
    const { files, notes } = await init(process.cwd(), { force: values.force });
    process.stdout.write(
      `Created ${files.join(" and ")}.\n\nWhat was detected (check these in the config):\n${notes.map((n) => `  - ${n}`).join("\n")}\n\nNext: npx slicetest\n`,
    );
    return;
  }

  const configPath = values.config
    ? path.resolve(values.config)
    : CONFIG_NAMES.map((n) => path.resolve(n)).find((p) => existsSync(p));
  if (positionals[0] === "gen") {
    const configOpenapi = configPath && existsSync(configPath) ? ((parse(await readFile(configPath, "utf8")) ?? {}) as CliConfig).openapi : undefined;
    const spec = values.spec ?? (typeof configOpenapi === "object" ? configOpenapi.spec : configOpenapi);
    if (!spec) throw new Error("slicetest gen: no OpenAPI spec. Pass --spec openapi.yaml, or set `openapi` in the config.");
    const root = values.spec || !configPath ? process.cwd() : path.dirname(configPath);
    const { gen } = await import("./gen.js");
    const { written, skipped, count } = await gen(root, { spec, out: values.out, uncovered: values.uncovered, force: values.force });
    const lines = [
      count === 0 ? "Every documented response is already covered; nothing to generate." : `${count} scenario(s) for the responses in ${spec}.`,
      ...written.map((f) => `  wrote   ${f}`),
      ...skipped.map((f) => `  skipped ${f} (exists; --force to overwrite)`),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  if (!configPath || !existsSync(configPath)) {
    process.stderr.write(`slicetest: no config found. Run "npx slicetest init" to create ${CONFIG_NAMES[0]} (see --help).\n`);
    process.exitCode = 1;
    return;
  }
  const { include, ...options } = (parse(await readFile(configPath, "utf8")) ?? {}) as CliConfig;

  const { startVitest } = await import("vitest/node");
  const { slicetest, YAML_SCENARIOS } = await import("./vitest.js");
  const vitest = await startVitest(
    positionals,
    {
      config: false,
      root: path.dirname(configPath),
      include: include ?? [YAML_SCENARIOS],
      watch: !!values.watch,
      run: !values.watch,
      testNamePattern: values.name,
    },
    { plugins: [slicetest(options)] },
  );
  if (!values.watch) await vitest?.close();
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
  process.exitCode = 1;
});
