// On globalThis: Vitest loads the global setup through its own module runner, so this module exists twice in one process.
const FAILED = Symbol.for("slicetest.setupFailed");
const state = globalThis as { [FAILED]?: boolean };

export function markSetupFailed() {
  state[FAILED] = true;
}

export function setupFailed() {
  return state[FAILED] === true;
}
