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

Runs *.scenario.yaml files against your app, as configured in slicetest.config.yaml.

Options:
  -c, --config <file>  Config file (default: ${CONFIG_NAMES.join(" / ")} in the current directory)
  -w, --watch          Re-run on changes
  -t, --name <pattern> Only run scenarios whose name matches
  -h, --help           Show this help

Config (paths are relative to the config file):
  app:     { command, env, cwd, ready: { path } | { log }, readyTimeout }
  db:      { migrate: { atlas: { dir } } | { sql } | { command }, seed, url, image, schemas, keep }
  stubs:   [names]
  http:    { headers, query }
  include: [globs]   default ["**/*.scenario.{yaml,yml}"]
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
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const configPath = values.config
    ? path.resolve(values.config)
    : CONFIG_NAMES.map((n) => path.resolve(n)).find((p) => existsSync(p));
  if (!configPath || !existsSync(configPath)) {
    process.stderr.write(`slicetest: no config found. Create ${CONFIG_NAMES[0]} (see --help).\n`);
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
