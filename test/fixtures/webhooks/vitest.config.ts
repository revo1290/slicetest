import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [
    slicetest({
      app: {
        command: "node app.mjs",
        env: { PORT: "{{app.port}}", STRIPE_WEBHOOK_SECRET: "whsec_test", GITHUB_WEBHOOK_SECRET: "gh-secret" },
        ready: { log: "app ready" },
      },
    }),
  ],
  test: { name: "webhooks", include: ["*.scenario.ts", "*.scenario.yaml"] },
});
