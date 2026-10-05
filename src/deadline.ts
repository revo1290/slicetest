/** When the running scenario's own timeout ends (epoch ms); shared across copies of the package. */
const KEY = Symbol.for("slicetest.deadline");
const slot = globalThis as { [KEY]?: { at: number; timeout: number } };

/** Kept short of the timeout, so the wait's own message (what it waited for) is what the user sees. */
const MARGIN = 300;

export function setScenarioDeadline(started: number, timeout: number | undefined) {
  if (timeout) slot[KEY] = { at: started + timeout, timeout };
  else delete slot[KEY];
}

export function clearScenarioDeadline() {
  delete slot[KEY];
}

/** `ms`, or less when the scenario's timeout ends first; `note` says so for the error message. */
export function waitBudget(ms: number): { ms: number; note: string } {
  const d = slot[KEY];
  if (!d) return { ms, note: "" };
  const left = d.at - MARGIN - Date.now();
  if (left >= ms) return { ms, note: "" };
  return { ms: Math.max(0, left), note: ` (the scenario's timeout of ${d.timeout}ms ends then; raise it with \`timeout:\`)` };
}
