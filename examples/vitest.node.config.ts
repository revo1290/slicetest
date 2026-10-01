import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../src/vitest.js";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../src/index.ts") }] },
  plugins: [
    slicetest({
      app: {
        command: "node node-api/server.mjs",
        env: {
          PORT: "{{app.port}}",
          DATABASE_URL: "{{db.url}}",
          SLACK_WEBHOOK_URL: "{{stub.slack}}/hook",
        },
        ready: { path: "/health" },
      },
      db: { migrate: { atlas: { dir: "file://migrations" } }, seed: "seed.sql", queries: true },
      stubs: [{ name: "slack", openapi: "slack.openapi.yaml" }],
      openapi: { spec: "openapi.yaml", minCoverage: 100 },
    }),
  ],
  test: { name: "node-api", include: ["scenarios/**/*.test.ts"] },
});
