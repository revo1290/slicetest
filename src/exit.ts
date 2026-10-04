/**
 * One `exit` listener shared by every copy of this package in the process. A multi-project Vitest
 * config loads the modules once per project's global setup, and a listener per copy ended in
 * Node's "11 exit listeners" warning.
 */
const KEY = Symbol.for("slicetest.exitHooks");
type Registry = { [KEY]?: Set<() => void> };

export function onProcessExit(hook: () => void) {
  const g = globalThis as Registry;
  if (!g[KEY]) {
    const hooks = (g[KEY] = new Set());
    process.once("exit", () => {
      for (const h of hooks) {
        try {
          h();
        } catch {}
      }
    });
  }
  g[KEY].add(hook);
}
