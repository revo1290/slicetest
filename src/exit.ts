// One listener for every copy of the package: a multi-project Vitest config loads it once per
// project, and a listener each ended in Node's "11 exit listeners" warning.
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
