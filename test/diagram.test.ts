import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { sequenceDiagram } from "../src/diagram.js";
import { HttpClient } from "../src/http.js";
import { Stub } from "../src/stub.js";

let stub: Stub;
let app: import("node:http").Server;
let http: HttpClient;
beforeEach(async () => {
  stub = await Stub.start("pay; #1");
  const { createServer } = await import("node:http");
  // An app that calls the stub while it answers.
  app = createServer(async (req, res) => {
    const r = await fetch(`${stub.url}/charges`, { method: "POST", body: "{}" });
    res.writeHead(r.status === 201 ? 201 : 502, { "content-type": "application/json" }).end(JSON.stringify(r.status === 201 ? { id: 7 } : { error: "payment failed; retry" }));
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  http = new HttpClient(`http://127.0.0.1:${(app.address() as import("node:net").AddressInfo).port}`);
});
afterEach(async () => {
  await stub.close();
  app.close();
});

test("stub calls are drawn inside the request that caused them, in order", async () => {
  stub.on("POST", "/charges").once().reply(201, { ok: true });
  await http.post("/orders", {});
  await http.post("/orders", {});

  const changes = { orders: { inserted: [{ id: 7 }], updated: [], deleted: [] }, empty: { inserted: [], updated: [], deleted: [] } };
  expect(sequenceDiagram(http.history, [stub], changes)).toBe(
    [
      "sequenceDiagram",
      "  participant test as scenario",
      "  participant app",
      "  participant s_pay___1 as pay#59; #35;1 (stub)",
      "  participant db as database",
      "  test->>+app: POST /orders",
      "  app->>+s_pay___1: POST /charges",
      "  s_pay___1-->>-app: 201",
      "  app-->>-test: 201 id: 7",
      "  test->>+app: POST /orders",
      "  app->>+s_pay___1: POST /charges",
      "  s_pay___1-->>-app: 501 no stub",
      "  app-->>-test: 502 error: payment failed#59; retry",
      "  Note over app,db: orders +1",
    ].join("\n"),
  );
});

test("--diagrams writes one Markdown page per scenario file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slicetest-diagrams-"));
  const root = path.join(import.meta.dirname, "..");
  const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
  const config = path.join(import.meta.dirname, "fixtures/graphql/vitest.config.ts");
  await promisify(execFile)(process.execPath, [vitest, "run", "--config", config], { cwd: root, env: { ...process.env, SLICETEST_DIAGRAMS: dir } });

  const page = await readFile(path.join(dir, "graphql.scenario.yaml.md"), "utf8");
  expect(page).toContain("# graphql.scenario.yaml");
  expect(page).toContain("## a GraphQL request, answered by a GraphQL stub\n\n```mermaid\nsequenceDiagram");
  expect(page).toContain("  app->>+s_github: GraphQL mutation CreateIssue");
  expect(await readFile(path.join(dir, "graphql.scenario.ts.md"), "utf8")).toContain("## errors() answers like a GraphQL server");
}, 60_000);
