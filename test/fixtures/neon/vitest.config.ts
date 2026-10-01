import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [
    slicetest({
      app: { command: "node app.mjs", ready: { log: "ready" } },
      db: { migrate: { sql: "schema.sql" }, neon: true, queries: true },
      offline: true,
    }),
  ],
  test: { name: "neon", include: ["*.scenario.yaml"] },
});
