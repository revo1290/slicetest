import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

// Env, not several configs: test/isolation.test.ts runs one project per mode (default restart reset idle reset+idle).
const mode = (process.env.ISOLATION_MODE ?? "default").split("+");
const idleTimeout = process.env.ISOLATION_IDLE_TIMEOUT ?? "3000";
const files = (process.env.ISOLATION_FILES ?? "leak").split(",");

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [
    slicetest({
      app: {
        command: "node app.mjs",
        env: { PORT: "{{app.port}}", DATABASE_PATH: "{{db.path}}", STUB_URL: "{{stub.upstream}}" },
        ready: { log: "app ready" },
        ...(mode.includes("restart") ? { restart: "scenario" as const } : {}),
        ...(mode.includes("reset") ? { reset: { path: "/__test/reset" } } : {}),
        // "default" leaves the timeout out, to see what slicetest does with its own default.
        ...(mode.includes("idle") ? { idle: { path: "/__test/idle", ...(idleTimeout === "default" ? {} : { timeout: Number(idleTimeout) }) } } : {}),
      },
      ...(process.env.ISOLATION_SERVICE
        ? { services: { worker: { command: "node service.mjs", env: { PORT: "{{service.worker.port}}" }, ready: { path: "/pid" }, idle: { path: "/__test/idle", timeout: 300 } } } }
        : {}),
      db: { engine: "sqlite", migrate: { sql: "schema.sql" } },
      stubs: ["upstream"],
      workers: Number(process.env.ISOLATION_WORKERS ?? 1),
    }),
  ],
  test: { name: "isolation", include: files.map((f) => `${f}.scenario.ts`) },
});
