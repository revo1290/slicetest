import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { App } from "../src/app.js";

// Its port closes at once and the process exits 1 s later: a crash whose exit event arrives late, as on a loaded Windows runner.
const SCRIPT = `
const server = require("node:http").createServer((req, res) => {
  if (req.url === "/die") {
    res.end("dying");
    server.close();
    server.closeAllConnections();
    setTimeout(() => process.exit(9), 1000);
    return;
  }
  res.end("ok");
});
server.listen(Number(process.env.PORT), "127.0.0.1");
`;

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "slicetest-settle-"));
  writeFileSync(path.join(dir, "app.cjs"), SCRIPT);
  return dir;
}

test("a process that stopped listening is waited for, so its exit is seen in the scenario that caused it", async () => {
  const app = await App.start({ command: "node app.cjs", ready: { path: "/" } }, setup(), {});
  try {
    await fetch(`${app.url}/die`);
    expect(await app.settle()).toMatchObject({ code: 9 });
  } finally {
    await app.stop();
  }
});

// Accepts and drops connections, then exits: a dying process whose port hasn't closed yet, as seen on Windows.
const DYING = `
const server = require("node:http").createServer((req, res) => {
  if (req.url === "/die") {
    res.end("dying");
    server.on("connection", (socket) => socket.destroy());
    setTimeout(() => process.exit(9), 1000);
    return;
  }
  res.end("ok");
});
server.listen(Number(process.env.PORT), "127.0.0.1");
`;

test("a process that drops the connections it accepts is waited for too", async () => {
  const dir = setup();
  writeFileSync(path.join(dir, "dying.cjs"), DYING);
  const app = await App.start({ command: "node dying.cjs", ready: { path: "/" } }, dir, {});
  try {
    await fetch(`${app.url}/die`);
    expect(await app.settle()).toMatchObject({ code: 9 });
  } finally {
    await app.stop();
  }
});

test("a process still listening is not waited for", async () => {
  const app = await App.start({ command: "node app.cjs", ready: { path: "/" } }, setup(), {});
  try {
    const started = Date.now();
    expect(await app.settle()).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
  } finally {
    await app.stop();
  }
});

test("a process that never listened on its port is not waited for", async () => {
  const dir = setup();
  writeFileSync(path.join(dir, "worker.cjs"), `console.log("worker up"); setInterval(() => {}, 1000);`);
  const app = await App.start({ command: "node worker.cjs", ready: { log: "worker up", flags: "" } }, dir, {});
  try {
    const started = Date.now();
    expect(await app.settle()).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
  } finally {
    await app.stop();
  }
});
