import { afterAll, beforeAll, inject } from "vitest";
import { setRuntime } from "./scenario.js";
import { Runtime } from "./runtime.js";
import { flushYamlFailures } from "./ci.js";
import "./provided.js";
import "./matchers.js";

let runtime: Runtime | undefined;
// With app.scope "worker" the runtime outlives the file: Vitest runs this worker's next
// files in the same module state (isolate: false), and the processes go when it exits.
const shared = globalThis as { __slicetestRuntime?: Promise<Runtime> };

beforeAll(async () => {
  const options = inject("slicetestOptions");
  if (options.app.scope === "worker") {
    const starting = (shared.__slicetestRuntime ??= Runtime.start(options, inject("slicetestDb")));
    starting.catch(() => {
      if (shared.__slicetestRuntime === starting) shared.__slicetestRuntime = undefined;
    });
    runtime = await starting;
  } else {
    runtime = await Runtime.start(options, inject("slicetestDb"));
  }
  setRuntime(runtime);
});

afterAll(async () => {
  await flushYamlFailures();
  setRuntime(undefined);
  if (inject("slicetestOptions").app.scope === "worker") await runtime?.flush();
  else await runtime?.stop();
});
