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

function define(register: typeof test | typeof test.only | typeof test.skip) {
  return (name: string, body: Body, timeout?: number) =>
    register(
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
        onTestFailed(() => {
          console.error(`--- slicetest ---\n${runtime.diagnostics()}\n-----------------`);
        });
        await runtime.beforeScenario();
        await body(runtime.context());
        await runtime.afterScenario();
      },
      timeout,
    );
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
    return (name: string, body: (row: T, ctx: ScenarioContext) => Promise<void> | void, timeout?: number) => {
      rows.forEach((row, i) => {
        const title = format(name, row, i);
        define(test)(title, (ctx) => body(row, ctx), timeout);
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
