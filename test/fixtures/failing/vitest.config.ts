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
        env: { PORT: "{{app.port}}", MAIL_URL: "{{stub.mail}}" },
        ready: { log: "fixture ready" },
      },
      stubs: ["mail"],
    }),
  ],
  test: { include: ["*.scenario.ts"], sequence: { concurrent: false } },
});
