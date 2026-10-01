import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { configDefaults } from "vitest/config";
import { CONFIG_NAMES, resolveOptions, type SlicetestOptions } from "./config.js";
import { SESSION_ENV } from "./record.js";
import { parse } from "yaml";
import { parseScenarioFile } from "./yaml.js";

/**
 * Reads a slicetest.config.yaml, so the CLI and a vitest.config share one file.
 * `file` is relative to `root`; without it the first of CONFIG_NAMES in `root` is used.
 * The CLI-only `include` is dropped.
 */
export function loadConfigFile(root: string, file?: string): SlicetestOptions {
  const found = file ? path.resolve(root, file) : CONFIG_NAMES.map((n) => path.join(root, n)).find((p) => existsSync(p));
  if (!found || !existsSync(found)) {
    throw new Error(`slicetest: ${file ? `config file ${found} not found` : `no ${CONFIG_NAMES.join(" / ")} in ${root}; pass the options to slicetest({ ... }) or run "npx slicetest init"`}`);
  }
  const { include: _, ...options } = (parse(readFileSync(found, "utf8")) ?? {}) as SlicetestOptions & { include?: unknown };
  return options;
}

/** YAML scenario files are picked up next to the regular test files. */
export const YAML_SCENARIOS = "**/*.scenario.{yaml,yml}";
const YAML_ID = /\.scenario\.ya?ml$/;

const here = path.dirname(fileURLToPath(import.meta.url));
// Resolve sibling modules with this file's own extension, so it works from both src (.ts) and dist (.js).
const ext = path.extname(fileURLToPath(import.meta.url));

/**
 * The Vitest plugin. Pass the options, or the path of a slicetest.config.yaml (relative to the
 * Vitest root), or nothing to read the slicetest.config.yaml next to the Vitest config.
 */
export function slicetest(options?: SlicetestOptions | string): Plugin {
  let root: string | undefined;
  return {
    name: "slicetest",
    config(config) {
      const root = path.resolve(config.root ?? process.cwd());
      // Mutated rather than returned: a returned list would replace Vitest's default include instead of extending it.
      const test = ((config as { test?: { include?: string[] } }).test ??= {});
      // `slicetest record` runs only its session file.
      if (!process.env[SESSION_ENV]) test.include = [...(test.include ?? configDefaults.include), YAML_SCENARIOS];
      return {
        test: {
          globalSetup: [path.join(here, `global-setup${ext}`)],
          setupFiles: [path.join(here, `setup-file${ext}`)],
          provide: { slicetestOptions: resolveOptions(typeof options === "object" ? options : loadConfigFile(root, options), root) },
          hookTimeout: 120_000,
        },
      } as Record<string, unknown>;
    },
    transform(code, id) {
      const file = id.split("?")[0]!;
      if (!YAML_ID.test(file)) return;
      const doc = { ...parseScenarioFile(code, path.relative(root ?? process.cwd(), file) || file), path: file };
      const runtime = JSON.stringify(path.join(here, `yaml-runtime${ext}`));
      return { code: `import { defineYamlScenarios } from ${runtime};\ndefineYamlScenarios(${JSON.stringify(doc)});\n`, map: null };
    },
    // `config.root` is often unset; the resolved root is the one relative paths should follow.
    configResolved(resolved) {
      root = resolved.root;
      const provided = (resolved as { test?: { provide?: { slicetestOptions?: { root: string } } } }).test?.provide;
      if (provided?.slicetestOptions) provided.slicetestOptions.root = resolved.root;
    },
  };
}

export type { SlicetestOptions } from "./config.js";
