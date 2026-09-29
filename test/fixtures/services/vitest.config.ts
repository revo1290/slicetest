import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [
    slicetest({
      services: {
        pricing: { command: "node pricing.mjs", ready: { path: "/" } },
        worker: { command: "node worker.mjs" },
      },
      app: {
        command: "node app.mjs",
        env: { PORT: "{{app.port}}", PRICING_URL: "{{service.pricing}}" },
        ready: { log: "app ready" },
      },
      db: { migrate: { sql: "schema.sql" } },
    }),
  ],
  test: { name: "services", include: ["*.scenario.ts", "*.scenario.yaml"] },
});
