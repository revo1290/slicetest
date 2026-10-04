import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../src/vitest.js";

// Same inputs as ApiTestEnvironment.java: the migration file, seed.sql, the Postgres image, one Slack stub.
export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../src/index.ts") }] },
  plugins: [
    slicetest({
      app: {
        // Not `mvn spring-boot:run`: built once up front, so a worker doesn't compile and its downloads stay outside the proxy.
        build: "mvn -q -B package -Dmaven.test.skip=true",
        command: "java -jar target/polls.jar",
        cwd: "../spring-boot-api",
        env: {
          SERVER_PORT: "{{app.port}}",
          SPRING_DATASOURCE_URL: "{{db.jdbcUrl}}",
          SPRING_DATASOURCE_USERNAME: "{{db.user}}",
          SPRING_DATASOURCE_PASSWORD: "{{db.password}}",
          SLACK_WEBHOOK_URL: "{{stub.slack}}/hook",
        },
        ready: { path: "/health" },
        readyTimeout: 120_000,
      },
      // reuse is slicetest's default locally and off on CI (the CI-like runs set COMPARISON_REUSE=off).
      db: { migrate: { sql: "../migrations/20260929000000_init.sql" }, seed: "../seed.sql", ...(process.env.COMPARISON_REUSE === "off" ? { reuse: false } : {}) },
      stubs: ["slack"],
      workers: 1,
    }),
  ],
  test: { name: "spring-comparison", include: ["slicetest/*.test.ts"] },
});
