import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

const python = process.platform === "win32" ? "python" : "python3";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [
    slicetest({
      // The build runs once, before the app starts: the scenario checks its output exists.
      app: { command: `${python} app.py`, build: `node -e "require('fs').writeFileSync('.build-stamp', String(Date.now()))"`, env: { PORT: "{{app.port}}", DB_PATH: "{{db.path}}" }, ready: { log: "app ready" } },
      db: { engine: "sqlite", migrate: { sql: "schema.sql" }, seed: "seed.sql" },
    }),
  ],
  test: { name: "sqlite", include: ["*.scenario.ts", "*.scenario.yaml"] },
});
