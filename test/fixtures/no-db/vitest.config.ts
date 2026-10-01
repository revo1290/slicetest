import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [
    slicetest({
      // `db: false` with no `env`: the default environment must not mention {{db.url}}.
      app: { command: "node app.mjs", ready: { log: "ready" } },
      db: false,
      stubs: ["quotes"],
    }),
  ],
  test: { name: "no-db", include: ["*.scenario.ts"] },
});
