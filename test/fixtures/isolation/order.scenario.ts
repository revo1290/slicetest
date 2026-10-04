import { expect } from "vitest";
import { scenario } from "slicetest";

// Not asserting /count before the insert: that would fill the cache with 0 and hide a stale one.

for (const n of [1, 2, 3, 4]) {
  scenario(`order ${n}: starts clean, leaves state behind`, async ({ http, db, stub }) => {
    expect(await db.count("items")).toBe(0);
    expect(http.cookies.size).toBe(0);
    expect(stub("upstream").calls()).toEqual([]);
    expect(stub("upstream").describeRoutes()).toEqual([]);

    await db.insert("items", Array.from({ length: n }, (_, i) => ({ body: `${n}.${i}` })));
    await http.get("/login");
    stub("upstream").on("GET", "/ping").reply(200, { from: `order ${n}` });
    expect((await http.get("/via-stub")).json).toEqual({ from: `order ${n}` });
    expect((await http.get("/count")).json).toEqual({ count: n });
  });
}
