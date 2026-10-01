import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [
    slicetest({
      app: { command: "node app.mjs", ready: { log: "app ready" } },
      db: { engine: "mysql", migrate: { sql: "schema.sql" }, seed: "seed.sql", keep: ["categories"], queries: true },
    }),
  ],
  test: { name: "mysql", include: ["*.scenario.ts", "*.scenario.yaml"] },
});
