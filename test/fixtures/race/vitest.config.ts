import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [
    slicetest({
      app: { command: "node app.mjs", ready: { log: "app ready" } },
      db: { migrate: { sql: "schema.sql" } },
    }),
  ],
  test: { name: "race", include: ["*.scenario.ts", "*.scenario.yaml"] },
});
