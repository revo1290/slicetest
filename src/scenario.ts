import { test } from "vitest";
import type { Runtime, ScenarioContext } from "./runtime.js";

// Kept on globalThis so it survives the setup file and the test file loading
// separate copies of this module (e.g. one from dist, one through an alias).
const KEY = Symbol.for("slicetest.runtime");
const slot = globalThis as { [KEY]?: Runtime };

export function setRuntime(runtime: Runtime | undefined) {
  slot[KEY] = runtime;
}

type Body = (ctx: ScenarioContext) => Promise<void> | void;

export interface ScenarioOptions {
  timeout?: number;
  /** Labels to select scenarios by: `npx slicetest --tag smoke`, or `SLICETEST_TAGS=smoke,!slow` with Vitest. */
  tags?: string[];
}

/**
 * Whether a scenario with `tags` runs under `filter` (`SLICETEST_TAGS`): comma- or space-separated tags,
 * any of which it must have, and `!tag`s it must not have. No filter runs everything.
 */
export function tagsSelected(tags: readonly string[] = [], filter = process.env.SLICETEST_TAGS) {
  const terms = (filter ?? "").split(/[\s,]+/).filter(Boolean);
  const excluded = terms.filter((t) => t.startsWith("!")).map((t) => t.slice(1));
  const wanted = terms.filter((t) => !t.startsWith("!"));
  if (tags.some((t) => excluded.includes(t))) return false;
  return wanted.length === 0 || tags.some((t) => wanted.includes(t));
}

function define(register: typeof test | typeof test.only | typeof test.skip) {
  return (name: string, body: Body, options?: number | ScenarioOptions) => {
    const { timeout, tags } = typeof options === "number" ? { timeout: options, tags: undefined } : (options ?? {});
    // Scenarios the tag filter leaves out show as skipped, so the filter is visible in the summary.
    return (tagsSelected(tags) ? register : test.skip)(
      name,
      async ({ onTestFailed, task }) => {
        const runtime = slot[KEY];
        if (!runtime) {
          throw new Error("slicetest: runtime not started. Add the slicetest() plugin to your vitest config.");
        }
        if (task.concurrent) {
          throw new Error(
            "slicetest: scenarios share one app and database per file, so they can't run concurrently. Remove .concurrent / sequence.concurrent.",
          );
        }
        const file = task.file?.filepath ?? task.file?.name ?? "";
        onTestFailed(async () => {
          console.error(`--- slicetest ---\n${await runtime.diagnostics()}\n-----------------`);
          await runtime.reportDiagram(file, task.name, true);
        });
        const started = Date.now();
        await runtime.beforeScenario();
        await body(runtime.context());
        // Leaves a margin for the checks after the wait, so `idle` reports before Vitest's timeout does.
        await runtime.afterScenario(task.timeout ? started + task.timeout - 500 : undefined);
        await runtime.reportDiagram(file, task.name, false);
      },
      timeout,
    );
  };
}

/**
 * A test that runs against the real app. The database is reset to the
 * migrated schema (plus seed) and stubs are cleared before each scenario.
 */
export const scenario = Object.assign(define(test), {
  only: define(test.only),
  skip: define(test.skip),
  todo: (name: string) => test.todo(name),
  /** Same scenario for each row: `scenario.each(rows)("name %s", async (row, ctx) => ...)`. */
  each<T>(rows: readonly T[]) {
    return (name: string, body: (row: T, ctx: ScenarioContext) => Promise<void> | void, options?: number | ScenarioOptions) => {
      rows.forEach((row, i) => {
        const title = format(name, row, i);
        define(test)(title, (ctx) => body(row, ctx), options);
      });
    };
  },
});

/** printf-style `%s`/`%i`/`%j`/`%#`, plus `$field` for object rows. */
function format(name: string, row: unknown, index: number) {
  const args = Array.isArray(row) ? [...row] : [row];
  let out = name.replace(/%[sdij#%]/g, (tok) => {
    if (tok === "%%") return "%";
    if (tok === "%#") return String(index);
    const v = args.shift();
    return tok === "%j" ? JSON.stringify(v) : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
  if (row && typeof row === "object" && !Array.isArray(row)) {
    out = out.replace(/\$(\w+)/g, (m, k: string) => (k in row ? String((row as Record<string, unknown>)[k]) : m));
  }
  return out;
}
