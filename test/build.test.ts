import os from "node:os";
import { expect, test } from "vitest";
import { buildAll } from "../src/global-setup.js";

const app = { command: "node app.js", ready: { path: "/" } };

test("a failing build names the process and shows the end of its output", async () => {
  const build = `node -e "console.log('compiling'); console.error('Type error: x is not a number'); process.exit(1)"`;
  await expect(buildAll({ root: os.tmpdir(), app: { ...app, build }, services: {} })).rejects.toThrow(
    /slicetest: app build failed: .*\n(.|\n)*compiling(.|\n)*Type error: x is not a number/,
  );
});

test("services are built too, alongside the app", async () => {
  const fail = `node -e "process.exit(3)"`;
  await expect(buildAll({ root: os.tmpdir(), app, services: { worker: { command: "x", build: fail } } })).rejects.toThrow("slicetest: service worker build failed");
});
