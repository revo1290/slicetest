// schema/config.schema.json (for editors) and config.ts (for runs) must accept the same keys.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { APP_KEYS, CONTAINER_KEYS, DB_KEYS, STUB_KEYS, TOP_LEVEL_KEYS } from "../src/config.js";

const root = path.join(import.meta.dirname, "..");
const schema = JSON.parse(readFileSync(path.join(root, "schema/config.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
const errors = (config: unknown) => (validate(config) ? [] : validate.errors!.map((e) => `${e.instancePath} ${e.message}`));

test("the schema lists the keys config.ts accepts", () => {
  const p = schema.properties;
  expect(Object.keys(p).filter((k) => k !== "$schema").sort()).toEqual([...TOP_LEVEL_KEYS].sort());
  // baseEnv is set by slicetest itself, not written in a config.
  expect(Object.keys(p.app.properties).sort()).toEqual(APP_KEYS.filter((k) => k !== "baseEnv").sort());
  expect(Object.keys(p.services.additionalProperties.properties).sort()).toEqual(APP_KEYS.filter((k) => k !== "baseEnv" && k !== "scope").sort());
  expect(Object.keys(p.db.oneOf[1].properties).sort()).toEqual([...DB_KEYS].sort());
  expect(Object.keys(p.stubs.items.oneOf[1].properties).sort()).toEqual([...STUB_KEYS].sort());
  expect(Object.keys(p.containers.additionalProperties.properties).sort()).toEqual([...CONTAINER_KEYS].sort());
});

test.each(["examples/slicetest.config.yaml", "examples/slicetest.spring.config.yaml"])("%s matches the schema", (file) => {
  expect(errors(parse(readFileSync(path.join(root, file), "utf8")))).toEqual([]);
});

test("a full config matches, and a misspelt or mistyped key doesn't", () => {
  const full = parse(`
$schema: https://unpkg.com/slicetest/schema/config.schema.json
app:
  command: node server.js
  build: npm run build
  cwd: .
  env: { PORT: "{{app.port}}", DEBUG: true, WORKERS: 2 }
  ready: { log: listening }
  readyTimeout: 60000
  scope: worker
  restart: scenario
  reset: { path: /__test/reset, method: post, timeout: 1000 }
  idle: { path: /__test/idle }
db:
  engine: postgres
  migrate: { command: npx prisma migrate deploy, inputs: [prisma/migrations], env: { X: "{{db.url}}" } }
  seed: [a.sql, b.sql]
  ignoreChanges: [updated_at, sessions.*]
  queries: true
stubs: [slack, { name: github, openapi: gh.yaml, autoReply: true, hosts: [api.github.com] }, { name: stripe, upstream: https://api.stripe.com }]
services: { worker: { command: node worker.js, ready: { log: up }, restart: scenario } }
containers: { cache: { image: redis:7, port: 6379, reset: [redis-cli, FLUSHALL] } }
openapi: { spec: openapi.yaml, minCoverage: 80 }
http: { headers: { accept: application/json }, timeout: 5000, follow: true }
mail: true
offline: true
strictStubs: true
workers: 2
auth: { audience: api }
include: [scenarios/**/*.scenario.yaml]
`);
  expect(errors(full)).toEqual([]);
  expect(errors({ app: { command: "x" }, db: false })).toEqual([]);
  expect(errors({ app: { command: "x" }, stub: ["a"] })).toContain(" must NOT have additional properties");
  expect(errors({ app: { command: "x", readyTimeout: "30s" } })).toContain("/app/readyTimeout must be number");
  expect(errors({ app: { command: "x", env: { A: null } } })).toContain("/app/env/A must be string,number,boolean");
});
