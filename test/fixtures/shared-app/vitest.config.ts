import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [slicetest({ app: { build: `node -e "require('fs').writeFileSync('starts.log', '')"`, command: "node app.mjs", ready: { log: "ready" }, scope: "worker" }, workers: 1, db: { engine: "sqlite", migrate: { sql: "schema.sql" } } })],
  // `workers: 1`: one worker, so both files must share its app.
  test: { name: "shared-app", include: ["*.scenario.ts"] },
});
