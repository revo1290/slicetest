import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

// Not a project of the root config: test/worker-scope.test.ts runs it and checks what is left afterwards.
export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [slicetest({ app: { command: "node app.mjs", ready: { log: "ready" }, scope: "worker" }, workers: 1, db: { engine: "sqlite", migrate: { sql: "schema.sql" } } })],
  test: { name: "worker-leak", include: ["*.scenario.ts"] },
});
