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
import { CONFIG_NAMES, type SlicetestOptions } from "./config.js";


const HELP = `Usage: slicetest [filters...] [options]
       slicetest init [--force]
       slicetest gen [--spec <file>] [--out <dir>] [--uncovered] [--force]
       slicetest doctor [--config <file>]
       slicetest record [--out <file>] [--port <n>]
       slicetest import <file.har> [--stub <name>] [--upstream <url>]

Runs *.scenario.yaml files against your app, as configured in slicetest.config.yaml.
\`slicetest init\` looks at the project and writes a starting config and scenario.
\`slicetest gen\` writes scenario skeletons for the documented responses of the
app's OpenAPI spec; with --uncovered, only for those the last run didn't produce.
\`slicetest doctor\` checks the config, the container runtime or database server,
migrations, commands and spec files, and says what to fix.
\`slicetest record\` starts everything and a proxy in front of the app: use the app
through it (a browser, curl), press Enter, and get the session as a YAML scenario.
\`slicetest import\` turns a HAR file (the browser's network panel: "Save all as
HAR"; Charles, mitmproxy, Proxyman) into recordings for the stubs whose
\`upstream\` it has requests for, so they replay the real service's answers.

Options:
  -c, --config <file>  Config file (default: ${CONFIG_NAMES.join(" / ")} in the current directory)
  -w, --watch          Re-run on changes
  -t, --name <pattern> Only run scenarios whose name matches
      --spec <file>    gen: OpenAPI file (default: \`openapi\` from the config)
      --out <dir>      gen: where to write scenarios (default: scenarios)
                       record: the scenario file (default: scenarios/recorded-<time>.scenario.yaml)
      --port <n>       record: the proxy's port (default: any free port)
      --stub <name>    import: only this stub (with --upstream, one not in the config)
      --upstream <url> import: the real service's base URL for --stub
      --uncovered      gen: only responses the last run didn't cover
      --force          init, gen: overwrite existing files
      --diagrams <dir> Write a Mermaid sequence diagram of every scenario to <dir>,
                       one Markdown page per scenario file
  -h, --help           Show this help

Config (paths are relative to the config file):
  app:      { command, env, cwd, ready: { path } | { log }, readyTimeout }
  db:       { migrate: { atlas: { dir } } | { sql } | { command, inputs }, engine, seed, url, image, schemas, keep, reuse, queries }
  stubs:    [name | { name, openapi, autoReply, upstream, recordings }]
  services: { name: { command, env, cwd, ready } }
  containers: { name: { image, port, env, command, ready: { log }, reset } }
  mail:     true    SMTP server at {{mail.host}} / {{mail.port}}
  auth:     true | { audience, claims }   OpenID issuer at {{auth.issuer}} / {{auth.jwks}}
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
      port: { type: "string" },
      diagrams: { type: "string" },
      stub: { type: "string" },
      upstream: { type: "string" },
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
  if (positionals[0] === "doctor") {
    const { doctor, formatChecks } = await import("./doctor.js");
    const checks = await doctor(configPath);
    process.stdout.write(formatChecks(checks));
    if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
    return;
  }
  if (positionals[0] === "gen") {
    const config = configPath && existsSync(configPath) ? ((parse(await readFile(configPath, "utf8")) ?? {}) as CliConfig) : undefined;
    const configOpenapi = config?.openapi;
    const spec = values.spec ?? (typeof configOpenapi === "object" ? configOpenapi.spec : configOpenapi);
    if (!spec) throw new Error("slicetest gen: no OpenAPI spec. Pass --spec openapi.yaml, or set `openapi` in the config.");
    const root = values.spec || !configPath ? process.cwd() : path.dirname(configPath);
    const { gen } = await import("./gen.js");
    const { written, skipped, count, needsAuth } = await gen(root, { spec, out: values.out, uncovered: values.uncovered, force: values.force });
    const lines = [
      count === 0 ? "Every documented response is already covered; nothing to generate." : `${count} scenario(s) for the responses in ${spec}.`,
      ...written.map((f) => `  wrote   ${f}`),
      ...skipped.map((f) => `  skipped ${f} (exists; --force to overwrite)`),
      ...(needsAuth && count > 0 && !config?.auth
        ? ["", "The spec requires bearer tokens: requests carry `auth:`. Add `auth: true` to the config and point the app's JWT settings at {{auth.issuer}} / {{auth.jwks}}."]
        : []),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  if (positionals[0] === "import") {
    const har = positionals[1];
    if (!har) throw new Error("slicetest import: which HAR file? e.g. npx slicetest import session.har");
    const config = configPath && existsSync(configPath) ? ((parse(await readFile(configPath, "utf8")) ?? {}) as CliConfig) : undefined;
    const root = configPath && config ? path.dirname(configPath) : process.cwd();
    const declared = (config?.stubs ?? []).flatMap((s) => (typeof s === "object" && s.upstream ? [s] : []));
    let targets = declared.map((s) => ({ name: s.name, upstream: s.upstream!, file: path.resolve(root, s.recordings ?? `recordings/${s.name}.yaml`) }));
    if (values.stub) {
      const known = targets.find((t) => t.name === values.stub);
      const upstream = values.upstream ?? known?.upstream;
      if (!upstream) throw new Error(`slicetest import: stub "${values.stub}" has no upstream in the config; pass --upstream https://api.example.com`);
      targets = [{ name: values.stub, upstream, file: known?.file ?? path.resolve(root, `recordings/${values.stub}.yaml`) }];
    }
    if (targets.length === 0) throw new Error("slicetest import: no stub to import into. Give stubs an `upstream` in the config, or pass --stub <name> --upstream <url>.");
    const { importHar } = await import("./har.js");
    const { written, skipped, others } = await importHar(path.resolve(har), targets);
    const lines = [
      ...written.map((w) => `  ${w.name}: ${w.count} recording(s) → ${path.relative(process.cwd(), w.file)}`),
      ...(written.length === 0 ? [`No requests in ${har} go to ${targets.map((t) => t.upstream).join(", ")}.`] : []),
      ...(skipped ? [`  skipped ${skipped} preflight, aborted or binary request(s)`] : []),
      ...(others.length ? ["", "Requests to other hosts (not imported):", ...others.slice(0, 10).map(([h, n]) => `  ${h} (${n})`), "Import one with --stub <name> --upstream <url>."] : []),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    if (written.length === 0) process.exitCode = 1;
    return;
  }
  if (!configPath || !existsSync(configPath)) {
    process.stderr.write(`slicetest: no config found. Run "npx slicetest init" to create ${CONFIG_NAMES[0]} (see --help).\n`);
    process.exitCode = 1;
    return;
  }
  const { include, ...options } = (parse(await readFile(configPath, "utf8")) ?? {}) as CliConfig;
  if (positionals[0] === "record") {
    const { record } = await import("./record-cli.js");
    await record(configPath, options, { out: values.out, port: values.port ? Number(values.port) : 0 });
    return;
  }

  // Workers inherit the environment; a relative directory is taken from where the command runs.
  if (values.diagrams) process.env.SLICETEST_DIAGRAMS = path.resolve(values.diagrams);
  const { startVitest, version } = await import("vitest/node");
  if (Number.parseInt(version, 10) < 4) {
    process.stderr.write(`slicetest: needs Vitest 4 or later, and this project has Vitest ${version}. Upgrade it (npm i -D vitest@latest), or run slicetest from a folder with its own package.json.\n`);
    process.exitCode = 1;
    return;
  }
  const { slicetest, YAML_SCENARIOS } = await import("./vitest.js");
  // Vitest 4 takes the mode ("test") first; 5 dropped it.
  const start = (Number.parseInt(version, 10) === 4 ? startVitest.bind(null, "test") : startVitest) as typeof startVitest;
  const vitest = await start(
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
