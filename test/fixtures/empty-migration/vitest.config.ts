import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

// Run on its own by test/empty-migration.test.ts: the migration "succeeds" without creating anything,
// like drizzle-kit push through a driver that can't reach the server.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    slicetest({
      app: { command: "node -e \"require('http').createServer((q,s)=>s.end()).listen(process.env.PORT)\"" },
      db: { engine: "sqlite", migrate: { command: `node -e "console.log('Error: connect ECONNREFUSED 127.0.0.1:443')"`, inputs: [] }, reuse: false },
    }),
  ],
  test: { include: ["*.scenario.yaml"] },
});
