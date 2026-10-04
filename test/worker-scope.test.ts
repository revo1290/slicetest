import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { runFixture } from "./run-fixture.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Windows ends a worker without a signal handler's chance to run; the taskkill path is covered elsewhere.
test.skipIf(process.platform === "win32")("an app.scope: worker app doesn't outlive the run when Vitest ends its worker", async () => {
  const run = await runFixture("worker-leak");
  expect(run.tests.get("the app of a worker is running")?.status).toBe("passed");
  const pid = Number(await readFile(path.join(import.meta.dirname, "fixtures/worker-leak/pid.log"), "utf8"));

  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  const left = alive(pid);
  if (left) process.kill(pid, "SIGKILL");
  expect(left, `app process ${pid} was still running after the run`).toBe(false);
}, 60_000);
