import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    slicetest({
      app: { command: "node app.mjs", ready: { log: "app ready" } },
      db: { migrate: { sql: "schema.sql" }, seed: "seed.yaml" },
    }),
  ],
  test: { name: "data-seed", include: ["*.scenario.yaml"] },
});
