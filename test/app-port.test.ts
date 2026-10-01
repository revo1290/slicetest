import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { App } from "../src/app.js";

// Stands in for an app whose port was taken between slicetest picking it and the app binding it.
const SCRIPT = `
const fs = require("node:fs");
const marker = process.argv[2];
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, process.env.PORT);
  console.error("Error: listen EADDRINUSE: address already in use 127.0.0.1:" + process.env.PORT);
  process.exit(1);
}
require("node:http").createServer((_, res) => res.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
`;

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "slicetest-port-"));
  writeFileSync(path.join(dir, "app.cjs"), SCRIPT);
  return dir;
}

test("starts again on another port when the app finds its port taken", async () => {
  const dir = setup();
  const app = await App.start({ command: "node app.cjs first.txt", ready: { path: "/" } }, dir, {});
  try {
    expect(await (await fetch(`http://127.0.0.1:${app.port}/`)).text()).toBe("ok");
  } finally {
    await app.stop();
  }
});

test("a process with a fixed port is not moved", async () => {
  const dir = setup();
  await expect(App.start({ command: "node app.cjs first.txt", ready: { path: "/" } }, dir, {}, "service.worker", 1)).rejects.toThrow(
    "EADDRINUSE",
  );
});
