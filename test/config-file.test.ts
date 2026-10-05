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

test("the CLI's include replaces the test files the plugin would add, instead of being extended", async () => {
  const { slicetestPlugin, slicetest } = await import("../src/vitest.js");
  const app = { app: { command: "node a.js" }, db: false as const };
  const run = (plugin: ReturnType<typeof slicetest>) => {
    const config: { root: string; test?: { include?: string[] } } = { root: os.tmpdir() };
    (plugin.config as (c: unknown) => unknown)(config);
    return config.test?.include;
  };
  expect(run(slicetestPlugin(app, { include: ["e2e/**/*.scenario.yaml"] }))).toEqual(["e2e/**/*.scenario.yaml"]);
  expect(run(slicetest(app))).toContain("**/*.scenario.{yaml,yml}");
  expect(run(slicetest(app))).toContain("**/*.{test,spec}.?(c|m)[jt]s?(x)");
});
