import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { doctor, formatChecks, type Probes } from "../src/doctor.js";

const healthy: Probes = {
  containerRuntime: async () => "Docker 27 at localhost",
  database: async () => {},
  command: async () => "atlas version v0.38.0",
  resolvePackage: () => true,
};

async function project(config: string, files: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slicetest-doctor-"));
  for (const [name, content] of Object.entries({ "slicetest.config.yaml": config, ...files })) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return path.join(dir, "slicetest.config.yaml");
}

// The Windows CI job sets SLICETEST_DATABASE_URL, which the config picks up; these tests choose their own.
beforeEach(() => {
  vi.stubEnv("SLICETEST_DATABASE_URL", "");
  return () => vi.unstubAllEnvs();
});

const summary = (checks: Awaited<ReturnType<typeof doctor>>) => checks.map((c) => `${c.status} ${c.label}`);

test("a complete project passes, listing what it checked", async () => {
  const config = await project(
    "app: { command: node server.js }\ndb: { migrate: { atlas: { dir: migrations } }, seed: seed.sql }\ncontainers: { cache: { image: redis:7, port: 6379 } }\n",
    { "migrations/1.sql": "", "seed.sql": "" },
  );
  const checks = await doctor(config, healthy, { PATH: path.dirname(process.execPath) });
  expect(summary(checks)).toEqual([
    expect.stringMatching(/^ok Node\.js /),
    expect.stringMatching(/^ok config .*slicetest\.config\.yaml$/),
    "ok container runtime: Docker 27 at localhost",
    expect.stringMatching(/^ok migrations .*migrations$/),
    "ok atlas CLI (atlas version v0.38.0)",
    expect.stringMatching(/^ok seed .*seed\.sql$/),
    "ok app: node found",
  ]);
  expect(checks[2]!.detail).toBe("runs postgres:17-alpine, redis:7");
  expect(formatChecks(checks)).toMatch(/Ready to run\.\n$/);
});

test("problems come with what to do about them", async () => {
  const config = await project(
    "app: { command: nosuchprogram serve }\ndb: { engine: mysql, migrate: { atlas: { dir: migrations } }, seed: seed.sql }\nopenapi: openapi.yaml\nstubs: [{ name: gh, upstream: https://api.github.com }]\n",
    { "openapi.yaml": "openapi: 3.1.0\ninfo: { title: x, version: '1' }\npaths: {}\n" },
  );
  const checks = await doctor(config, {
    containerRuntime: async () => {
      throw new Error("Could not find a working container runtime strategy");
    },
    database: async () => {},
    command: async () => {
      throw new Error("ENOENT");
    },
    resolvePackage: (name) => name !== "mysql2",
  }, { PATH: "" });
  const byLabel = Object.fromEntries(checks.map((c) => [c.label, c]));
  expect(byLabel["no container runtime"]).toMatchObject({ status: "fail", detail: expect.stringContaining("SLICETEST_DATABASE_URL") });
  expect(byLabel["mysql2 not installed"]).toMatchObject({ status: "fail", detail: expect.stringContaining("npm i -D mysql2") });
  expect(byLabel["atlas CLI not found"]?.status).toBe("fail");
  expect(checks.find((c) => c.label.startsWith("migrations"))).toMatchObject({ status: "fail", label: expect.stringMatching(/not found$/) });
  expect(checks.find((c) => c.label.startsWith("seed"))?.status).toBe("fail");
  expect(byLabel["app: nosuchprogram not found on PATH"]?.status).toBe("warn");
  expect(checks.find((c) => c.label.startsWith("stub gh: no recordings yet"))).toMatchObject({ status: "warn", detail: expect.stringContaining("SLICETEST_RECORD=gh") });
  expect(checks.find((c) => c.label.startsWith("app OpenAPI"))?.status).toBe("ok");
  expect(formatChecks(checks)).toMatch(/5 problem\(s\) to fix before running\.\n$/);
});

test("an invalid config stops there, with the validation message", async () => {
  const checks = await doctor(await project("app: {}\n"), healthy);
  expect(checks.at(-1)).toMatchObject({ status: "fail", detail: expect.stringContaining("app.command is required") });
});

test("a database server given by URL is connected to instead of looking for a container runtime", async () => {
  let tried = "";
  vi.stubEnv("SLICETEST_DATABASE_URL", "postgres://postgres:secret@db:5432/postgres");
  const checks = await doctor(await project("app: { command: ./run.sh }\ndb: { migrate: { sql: schema.sql } }\n", { "schema.sql": "" }), {
    ...healthy,
    database: async (_, url) => {
      tried = url;
      throw new Error("password authentication failed");
    },
  }, { SLICETEST_DATABASE_URL: "postgres://postgres:secret@db:5432/postgres" });
  expect(tried).toBe("postgres://postgres:secret@db:5432/postgres");
  expect(checks.find((c) => c.label.startsWith("postgres at"))).toMatchObject({
    status: "fail",
    label: "postgres at postgres://postgres:***@db:5432/postgres",
    detail: expect.stringContaining("password authentication failed"),
  });
  expect(checks.some((c) => c.label.includes("container runtime"))).toBe(false);
});

test("without a config only the machine is checked", async () => {
  const checks = await doctor(undefined, healthy);
  expect(summary(checks).slice(1)).toEqual(["warn no slicetest.config.yaml", "ok container runtime: Docker 27 at localhost"]);
});
