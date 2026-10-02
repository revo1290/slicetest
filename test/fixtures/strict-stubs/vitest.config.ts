import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [slicetest({ app: { command: "node app.mjs", env: { PORT: "{{app.port}}", PAY_URL: "{{stub.pay}}" }, ready: { log: "ready" } }, db: false, stubs: ["pay"], strictStubs: true })],
  test: { name: "strict-stubs", include: ["*.scenario.ts", "*.scenario.yaml"] },
});
