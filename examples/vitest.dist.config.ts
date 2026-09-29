import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../dist/vitest.js";

// Smoke test of the built package: plugin and `slicetest` both come from dist.
export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../dist/index.js") }] },
  plugins: [
    slicetest({
      app: {
        command: "node node-api/server.mjs",
        env: { PORT: "{{app.port}}", DATABASE_URL: "{{db.url}}", SLACK_WEBHOOK_URL: "{{stub.slack}}/hook" },
        ready: { log: "listening on" },
      },
      db: { migrate: { sql: "migrations/20260929000000_init.sql" }, seed: "seed.sql" },
      stubs: [{ name: "slack", openapi: "slack.openapi.yaml" }],
      openapi: "openapi.yaml",
    }),
  ],
  test: { name: "dist", include: ["scenarios/**/*.test.ts"] },
});
