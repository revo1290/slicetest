import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [
    slicetest({
      containers: { cache: { image: "redis:7-alpine", port: 6379, reset: ["redis-cli", "FLUSHALL"] } },
      app: { command: "node app.mjs", env: { PORT: "{{app.port}}", REDIS_ADDR: "{{container.cache}}" }, ready: { log: "app ready" } },
    }),
  ],
  test: { name: "containers", include: ["*.scenario.ts"] },
});
