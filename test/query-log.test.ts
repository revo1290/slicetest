import { expect, test } from "vitest";
import { normalizeSql, queryList } from "../src/query-log.js";

test("normalizeSql replaces literals and parameters so N+1 statements share one shape", () => {
  expect(normalizeSql("SELECT * FROM authors WHERE id = 7")).toBe("SELECT * FROM authors WHERE id = ?");
  expect(normalizeSql("SELECT *\n  FROM t WHERE name = 'o''neil' AND id = $2")).toBe("SELECT * FROM t WHERE name = ? AND id = ?");
  expect(normalizeSql("SELECT * FROM t WHERE id IN (1, 2, 3)")).toBe("SELECT * FROM t WHERE id IN (?)");
  expect(normalizeSql('SELECT "t1".a FROM t1')).toBe('SELECT "t1".a FROM t1');
});

test("repeated() finds the shapes run many times; withoutTransactions() drops BEGIN/COMMIT", () => {
  const q = queryList([
    { sql: "BEGIN", at: 0 },
    { sql: "SELECT * FROM posts", at: 1 },
    ...[1, 2, 3].map((id) => ({ sql: `SELECT * FROM authors WHERE id = ${id}`, at: 2 })),
    { sql: "COMMIT", at: 3 },
  ]);
  expect(q.repeated()).toEqual([{ sql: "SELECT * FROM authors WHERE id = ?", count: 3 }]);
  expect(q.withoutTransactions()).toHaveLength(4);
});
