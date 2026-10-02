import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [
    slicetest({
      app: { command: "node -e \"require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT)\"" },
      db: { engine: "sqlite", migrate: { command: "node migrate.mjs {{db.path}}", env: { DB_DATABASE: "{{db.path}}", CONNECTION: "{{db.adoNet}}" }, inputs: ["migrate.mjs"] } },
    }),
  ],
  test: { name: "migrate-env", include: ["*.scenario.ts"] },
});
