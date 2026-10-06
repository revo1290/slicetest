import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { runFixture, type FixtureRun } from "./run-fixture.js";

// SQLite, not Postgres: these runs need no container, so they also run on the Windows unit job.

const CACHE = "cache: the next scenario starts from an empty database, and so does the app's view of it";
const DELAYED = "delayed write: the next scenario doesn't receive the previous one's write";
const FILL_CACHE = "cache: the first scenario fills the app's cache";
const SCHEDULE_WRITE = "delayed write: a scenario schedules a write and ends before it happens";
const FAILED = "a scenario leaves state behind and fails";
const CLEAN = "the next scenario starts clean";

const passed = (run: FixtureRun, name: string) => expect(run.tests.get(name)?.status, run.tests.get(name)?.message).toBe("passed");
const failed = (run: FixtureRun, name: string) => expect(run.tests.get(name)?.status).toBe("failed");

// Without this, a first scenario that failed before leaving its state lets the second one pass for the wrong reason.
const leftState = (run: FixtureRun) => {
  passed(run, FILL_CACHE);
  passed(run, SCHEDULE_WRITE);
};

const modes = ["default", "restart", "reset", "idle", "reset+idle"] as const;
const leak: Record<string, FixtureRun> = {};
const afterFailure: Record<string, FixtureRun> = {};
let idleTimeout: FixtureRun;
let idleDefault: FixtureRun;
let twoBusy: FixtureRun;
let order: FixtureRun[];
let orderDefault: FixtureRun;
let concurrent: FixtureRun;
let parallel: FixtureRun;
let serial: FixtureRun;

// Not all at once: every nested Vitest run together starved the Windows runner, and fixture scenarios hit the 5 s timeout.
const slots = { free: 4, waiting: [] as (() => void)[] };
async function run(...args: Parameters<typeof runFixture>) {
  if (slots.free === 0) await new Promise<void>((r) => slots.waiting.push(r));
  else slots.free--;
  try {
    return await runFixture(...args);
  } finally {
    const next = slots.waiting.shift();
    if (next) next();
    else slots.free++;
  }
}

beforeAll(async () => {
  const barrier = await mkdtemp(path.join(os.tmpdir(), "slicetest-barrier-"));
  const serialBarrier = await mkdtemp(path.join(os.tmpdir(), "slicetest-barrier-"));
  try {
    await Promise.all([
      ...modes.map(async (m) => (leak[m] = await run("isolation", { env: { ISOLATION_MODE: m, ISOLATION_FILES: "leak" } }))),
      ...(["idle", "restart", "reset+idle"] as const).map(async (m) => (afterFailure[m] = await run("isolation", { env: { ISOLATION_MODE: m, ISOLATION_FILES: "after-failure" } }))),
      (async () => (idleTimeout = await run("isolation", { env: { ISOLATION_MODE: "idle", ISOLATION_IDLE_TIMEOUT: "300", ISOLATION_FILES: "idle-timeout" } })))(),
      (async () => (idleDefault = await run("isolation", { env: { ISOLATION_MODE: "idle", ISOLATION_IDLE_TIMEOUT: "default", ISOLATION_FILES: "idle-timeout" } })))(),
      (async () => (twoBusy = await run("isolation", { env: { ISOLATION_MODE: "idle", ISOLATION_IDLE_TIMEOUT: "300", ISOLATION_SERVICE: "1", ISOLATION_FILES: "two-busy" } })))(),
      (async () => (order = await Promise.all([undefined, 1, 2, 3].map((seed) =>
        run("isolation", { env: { ISOLATION_MODE: "reset", ISOLATION_FILES: "order" }, args: seed ? ["--sequence.shuffle.tests", `--sequence.seed=${seed}`] : [] })))))(),
      (async () => (orderDefault = await run("isolation", { env: { ISOLATION_MODE: "default", ISOLATION_FILES: "order" } })))(),
      (async () => (concurrent = await run("isolation", { env: { ISOLATION_MODE: "reset", ISOLATION_FILES: "order" }, args: ["--sequence.concurrent"] })))(),
      (async () => (parallel = await run("isolation", { env: { ISOLATION_FILES: "parallel-a,parallel-b", ISOLATION_WORKERS: "2", ISOLATION_BARRIER: barrier } })))(),
      (async () => (serial = await run("isolation", { env: { ISOLATION_FILES: "parallel-a,parallel-b", ISOLATION_WORKERS: "1", ISOLATION_BARRIER: serialBarrier } })))(),
    ]);
  } finally {
    await Promise.all([rm(barrier, { recursive: true, force: true }), rm(serialBarrier, { recursive: true, force: true })]);
  }
}, 240_000);

describe("state inside the app process", () => {
  test("by default the process is reused, so its cache and its pending work reach the next scenario", () => {
    leftState(leak.default!);
    failed(leak.default!, CACHE);
    expect(leak.default!.tests.get(CACHE)!.message).toMatch(/expected 2 to be \+?0|\{ count: 2 \}/);
    failed(leak.default!, DELAYED);
    expect(leak.default!.tests.get(DELAYED)!.message).toMatch(/expected 1 to be \+?0/);
  });

  test("app.restart: scenario drops both, because the process is stopped before the reset", () => {
    leftState(leak.restart!);
    passed(leak.restart!, CACHE);
    passed(leak.restart!, DELAYED);
  });

  test("app.reset clears what the app clears itself", () => {
    leftState(leak.reset!);
    passed(leak.reset!, CACHE);
    passed(leak.reset!, DELAYED);
  });

  test("app.idle only waits for background work: late writes land in their own scenario, the cache stays", () => {
    leftState(leak.idle!);
    passed(leak.idle!, DELAYED);
    failed(leak.idle!, CACHE);
    expect(leak.idle!.tests.get(CACHE)!.message).toMatch(/expected 2 to be \+?0|\{ count: 2 \}/);
  });

  test("reset and idle together cover both", () => {
    leftState(leak["reset+idle"]!);
    passed(leak["reset+idle"]!, CACHE);
    passed(leak["reset+idle"]!, DELAYED);
  });
});

describe("after a scenario that failed", () => {
  test.each(["idle", "restart", "reset+idle"])("%s: cookies, stub routes, chaos, rows and late writes don't reach the next scenario", (mode) => {
    failed(afterFailure[mode]!, FAILED);
    expect(afterFailure[mode]!.tests.get(FAILED)!.message).toContain("failed on purpose");
    passed(afterFailure[mode]!, CLEAN);
  });

  test("an app that stays busy past app.idle.timeout fails that scenario, and is restarted so the next one is clean", () => {
    failed(idleTimeout, "starts work that outlives the scenario");
    expect(idleTimeout.tests.get("starts work that outlives the scenario")!.message).toMatch(/app\.idle: the app still had background work after \d+ms \(GET \/__test\/idle last answered: 503/);
    passed(idleTimeout, "the next scenario is not blamed for it");
  });
});

describe("app.idle edge cases", () => {
  test("with its default timeout, the idle message still appears before Vitest's own 5 s test timeout, and the next scenario is clean", () => {
    const first = idleDefault.tests.get("starts work that outlives the scenario")!;
    expect(first.status).toBe("failed");
    expect(first.message).toMatch(/app\.idle: the app still had background work/);
    expect(first.message).not.toContain("timed out");
    passed(idleDefault, "the next scenario is not blamed for it");
  });

  test("when the app and a service are both busy, both are reported and both are restarted", () => {
    const first = twoBusy.tests.get("the app and the worker are both still busy when it ends")!;
    expect(first.status).toBe("failed");
    expect(first.message).toContain("app.idle");
    expect(first.message).toContain("services.worker.idle");
    passed(twoBusy, "the next scenario has a new app and a new worker");
  });
});

describe("order", () => {
  test("with the reset in place, scenarios give the same result in file order and in three seeded shuffles", () => {
    expect(order).toHaveLength(4);
    for (const run of order) {
      expect(run.tests.size).toBe(4);
      for (const name of run.tests.keys()) passed(run, name);
    }
  });
});

describe("order without the reset", () => {
  test("by default the same file fails from the second scenario on: that suite depends on order", () => {
    passed(orderDefault, "order 1: starts clean, leaves state behind");
    for (const n of [2, 3, 4]) failed(orderDefault, `order ${n}: starts clean, leaves state behind`);
  });
});

describe("parallelism", () => {
  test("scenarios of one file can't run concurrently: it is refused, naming the reason", () => {
    expect(concurrent.exitCode).not.toBe(0);
    for (const t of concurrent.tests.values()) {
      expect(t.status).toBe("failed");
      expect(t.message).toContain("scenarios share one app and database per file, so they can't run concurrently");
    }
  });

  test("two files on two workers run at the same time without sharing rows, stub calls or the app", () => {
    expect(parallel.exitCode).toBe(0);
    expect([...parallel.tests.values()].map((t) => t.status)).toEqual(["passed", "passed"]);
  });

  test("the check above does need two workers: on one, the files run one after the other", () => {
    expect([...serial.tests.values()].some((t) => t.status === "failed" && t.message.includes("the files ran one after the other"))).toBe(true);
  });
});

describe("a table created while the run is going", () => {
  test("is emptied before the next scenario", async () => {
    const run = await runFixture("isolation", { env: { ISOLATION_FILES: "late-table" } });
    passed(run, "late table: a scenario creates a table after the run started");
    passed(run, "late table: the next scenario finds that table empty");
  }, 60_000);
});
