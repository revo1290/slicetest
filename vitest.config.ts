import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/**/*.test.ts"] } },
      "examples/vitest.node.config.ts",
      "examples/vitest.python.config.ts",
      "test/fixtures/services/vitest.config.ts",
    ],
  },
});
