import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      // A test that imports runtime.js cold, or starts a nested Vitest, can pass 5 s on a busy machine without being wrong.
      { test: { name: "unit", include: ["test/**/*.test.ts"], testTimeout: 30_000 } },
      "examples/vitest.node.config.ts",
      "examples/vitest.python.config.ts",
      "test/fixtures/services/vitest.config.ts",
      "test/fixtures/mysql/vitest.config.ts",
      "test/fixtures/containers/vitest.config.ts",
      "test/fixtures/mail/vitest.config.ts",
      "test/fixtures/race/vitest.config.ts",
      "test/fixtures/sqlite/vitest.config.ts",
      "test/fixtures/auth/vitest.config.ts",
      "test/fixtures/webhooks/vitest.config.ts",
      "test/fixtures/intercept/vitest.config.ts",
      "test/fixtures/shared-app/vitest.config.ts",
      "test/fixtures/no-db/vitest.config.ts",
      "test/fixtures/neon/vitest.config.ts",
      "test/fixtures/graphql/vitest.config.ts",
      "test/fixtures/migrate-env/vitest.config.ts",
    ],
  },
});
