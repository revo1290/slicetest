import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

// Run on its own by test/spec-from-app.test.ts (one scenario fails on purpose).
export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [
    slicetest({
      app: { command: "node app.mjs", ready: { log: "ready" } },
      db: { engine: "sqlite", migrate: { sql: "schema.sql" } },
      openapi: { fromApp: "/v3/api-docs", minCoverage: 100 },
    }),
  ],
  test: { include: ["*.scenario.yaml"] },
});
