import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

// Run by test/recording.test.ts, which starts the upstream and picks the recordings file.
export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [
    slicetest({
      app: { command: "node app.mjs", env: { PORT: "{{app.port}}", WEATHER_URL: "{{stub.weather}}" }, ready: { log: "app ready" } },
      stubs: [{ name: "weather", upstream: process.env.UPSTREAM_URL || "http://127.0.0.1:9", recordings: process.env.RECORDINGS_FILE }],
    }),
  ],
  test: { name: "recording", include: ["*.scenario.ts"] },
});
