import { afterAll, beforeAll, inject } from "vitest";
import { setRuntime } from "./scenario.js";
import { Runtime } from "./runtime.js";
import "./provided.js";
import "./matchers.js";

let runtime: Runtime | undefined;

beforeAll(async () => {
  runtime = await Runtime.start(inject("slicetestOptions"), inject("slicetestDb"));
  setRuntime(runtime);
});

afterAll(async () => {
  setRuntime(undefined);
  await runtime?.stop();
});
