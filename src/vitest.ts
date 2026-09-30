import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { configDefaults } from "vitest/config";
import { resolveOptions, type SlicetestOptions } from "./config.js";
import { parseScenarioFile } from "./yaml.js";

/** YAML scenario files are picked up next to the regular test files. */
export const YAML_SCENARIOS = "**/*.scenario.{yaml,yml}";
const YAML_ID = /\.scenario\.ya?ml$/;

const here = path.dirname(fileURLToPath(import.meta.url));
// Resolve sibling modules with this file's own extension, so it works from both src (.ts) and dist (.js).
const ext = path.extname(fileURLToPath(import.meta.url));

export function slicetest(options: SlicetestOptions): Plugin {
  let root: string | undefined;
  return {
    name: "slicetest",
    config(config) {
      const root = path.resolve(config.root ?? process.cwd());
      // Mutated rather than returned: a returned list would replace Vitest's default include instead of extending it.
      const test = ((config as { test?: { include?: string[] } }).test ??= {});
      test.include = [...(test.include ?? configDefaults.include), YAML_SCENARIOS];
      return {
        test: {
          globalSetup: [path.join(here, `global-setup${ext}`)],
          setupFiles: [path.join(here, `setup-file${ext}`)],
          provide: { slicetestOptions: resolveOptions(options, root) },
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
