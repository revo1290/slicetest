import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [
    slicetest({
      mail: true,
      app: { command: "node app.mjs", env: { PORT: "{{app.port}}", SMTP_HOST: "{{mail.host}}", SMTP_PORT: "{{mail.port}}" }, ready: { log: "app ready" } },
    }),
  ],
  test: { name: "mail", include: ["*.scenario.ts", "*.scenario.yaml"] },
});
