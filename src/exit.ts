// One listener per process, not per copy of the package (many Vitest projects ended in Node's "11 exit
// listeners" warning). Vitest ends a worker with SIGTERM, which skips `exit` and left worker-scope apps running.
const KEY = Symbol.for("slicetest.exitHooks");
type Registry = { [KEY]?: Set<() => void> };

export function onProcessExit(hook: () => void) {
  const g = globalThis as Registry;
  if (!g[KEY]) {
    const hooks = (g[KEY] = new Set());
    const run = () => {
      for (const h of hooks) {
        try {
          h();
        } catch {}
      }
      hooks.clear();
    };
    process.once("exit", run);
    // Sent again only when nobody else listens: its default action then ends the process as before.
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.once(signal, () => {
        run();
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      });
    }
  }
  g[KEY].add(hook);
}
