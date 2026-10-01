import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { loadConfigFile } from "../src/vitest.js";

test("slicetest() without options reads the CLI's config file; include is the CLI's own", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slicetest-config-"));
  await writeFile(path.join(root, "slicetest.config.yaml"), "app:\n  command: npm start\ninclude: [e2e/*.yaml]\n");
  await writeFile(path.join(root, "other.yml"), "app: { command: node b.js }\n");

  expect(loadConfigFile(root)).toEqual({ app: { command: "npm start" } });
  expect(loadConfigFile(root, "other.yml")).toEqual({ app: { command: "node b.js" } });
  expect(() => loadConfigFile(root, "missing.yaml")).toThrow(`config file ${path.join(root, "missing.yaml")} not found`);
  expect(() => loadConfigFile(os.tmpdir().concat(path.sep, "nowhere"))).toThrow('no slicetest.config.yaml / slicetest.config.yml / slicetest.config.json in');
});
