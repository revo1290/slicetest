import { expect, test, vi } from "vitest";
import { App } from "../src/app.js";

test("stopping an app twice signals its process group once: the pid may be someone else's by then", async () => {
  const app = await App.start({ command: `node -e "setInterval(() => {}, 1000)"` }, process.cwd(), {});
  const kill = vi.spyOn(process, "kill");
  try {
    await app.stop();
    const first = kill.mock.calls.length;
    await app.stop();
    expect(first).toBeGreaterThan(0);
    expect(kill.mock.calls.length).toBe(first);
  } finally {
    kill.mockRestore();
  }
});
