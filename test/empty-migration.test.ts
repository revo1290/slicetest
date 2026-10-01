import { expect, test } from "vitest";
import { runFailingFixture } from "./run-fixture.js";

test("a migration command that exits 0 but creates no tables stops the run, with its output", async () => {
  const output = await runFailingFixture("empty-migration");

  expect(output).toContain("slicetest: db.migrate finished without error but created no tables. Check that it reaches the database at DATABASE_URL.");
  expect(output).toContain("Its output:\nError: connect ECONNREFUSED 127.0.0.1:443");
}, 120_000);
