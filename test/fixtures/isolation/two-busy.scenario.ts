import { expect } from "vitest";
import { scenario } from "slicetest";

// Same module, same worker: scenario 1 hands the pids it saw to scenario 2.
let before: { app: number; worker: number };
const pid = async (url: string) => ((await (await fetch(`${url}/pid`)).json()) as { pid: number }).pid;

scenario("the app and the worker are both still busy when it ends", async ({ http, app, service }) => {
  before = { app: await pid(app.url), worker: await pid(service("worker").url) };
  expect(await http.post("/items/later", { delayMs: 10_000 })).toHaveStatus(202);
  await fetch(`${service("worker").url}/work`, { method: "POST" });
});

scenario("the next scenario has a new app and a new worker", async ({ app, service }) => {
  expect(await pid(app.url)).not.toBe(before.app);
  expect(await pid(service("worker").url)).not.toBe(before.worker);
});
