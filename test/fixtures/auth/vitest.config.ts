import path from "node:path";
import { defineConfig } from "vitest/config";
import { slicetest } from "../../../src/vitest.js";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^slicetest$/, replacement: path.resolve(import.meta.dirname, "../../../src/index.ts") }] },
  plugins: [
    slicetest({
      auth: { audience: "api://fixture", claims: { tenant: "acme" } },
      app: {
        command: "node app.mjs",
        env: { PORT: "{{app.port}}", OIDC_ISSUER: "{{auth.issuer}}", OIDC_AUDIENCE: "{{auth.audience}}" },
        ready: { log: "app ready" },
      },
    }),
  ],
  test: { name: "auth", include: ["*.scenario.ts", "*.scenario.yaml"] },
});
