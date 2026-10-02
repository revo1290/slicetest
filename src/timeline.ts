/**
 * When requests to the app and calls to stubs started and ended (`performance.now()`),
 * kept beside the objects rather than on them, so that the public shapes (and snapshots
 * of them) don't change. Used to put a scenario's events in order for `diagram()`.
 */
export const timeline = new WeakMap<object, { start: number; end?: number }>();
