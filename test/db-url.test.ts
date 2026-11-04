import { expect, test } from "vitest";
import { withDatabase } from "../src/drivers/postgres.js";

test("{{db.url}} uses the postgresql scheme: SQLAlchemy refuses postgres://, and everything else reads both", () => {
  expect(withDatabase("postgres://u:p@h:5432/postgres", "run_1")).toBe("postgresql://u:p@h:5432/run_1");
  expect(withDatabase("postgresql://u:p@h:5432/postgres?sslmode=disable", "run_1")).toBe("postgresql://u:p@h:5432/run_1?sslmode=disable");
});
