import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../src/vitest.js";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../src/index.ts") }] },
  plugins: [
    slicetest({
      app: {
        // Not `mvn spring-boot:run`: built once up front, so a worker doesn't compile and its downloads stay outside the proxy.
        build: "mvn -q -B -f spring-boot-api/pom.xml package -Dmaven.test.skip=true",
        command: "java -jar spring-boot-api/target/polls.jar",
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
      db: { migrate: { atlas: { dir: "file://migrations" } }, seed: "seed.sql", queries: true },
      stubs: [{ name: "slack", openapi: "slack.openapi.yaml" }],
      openapi: { spec: "openapi.yaml", minCoverage: 100 },
    }),
  ],
  test: { name: "spring-boot-api", include: ["scenarios/**/*.test.ts"] },
});
