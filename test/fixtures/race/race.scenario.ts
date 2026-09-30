import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("ten people booking the same seat at once: one gets it", async ({ http, db }) => {
  const responses = await http.concurrently(10, () => http.post("/book?seat=7"));
  expect(responses).toHaveStatuses({ 201: 1, 409: 9 });
  await expect(db).toHaveRow("bookings", { seat: 7 }, 1);
});

scenario("the requests really overlap: a check-then-insert without a constraint double-books", async ({ http, db }) => {
  const responses = await http.concurrently(10, () => http.post("/book-naive?seat=7"));
  expect(responses.filter((r) => r.status === 201).length).toBeGreaterThan(1);
  expect(await db.count("naive_bookings", { seat: 7 })).toBeGreaterThan(1);
});

scenario("toHaveStatuses shows one response per status when the counts differ", async ({ http }) => {
  const responses = await http.concurrently(3, (i) => http.post(`/book?seat=${i === 0 ? 1 : 2}`));
  expect(() => expect(responses).toHaveStatuses({ 201: 3 })).toThrow(/expected 3 responses to have statuses \{ 201: 3 \}, got \{ 201: 2, 409: 1 \}\n {2}201: POST \/book\?seat=\d/);
});
