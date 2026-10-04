import { expect } from "vitest";
import { scenario } from "slicetest";

// Cases C1-C9 of examples/comparison/README.md: the same checks as PollsApiTest.java.

scenario("C1 creating a poll stores it and notifies slack once", async ({ http, db, stub }) => {
  stub("slack").on("POST", "/hook").reply(200, "ok");

  const res = await http.post("/polls", { title: "犬か猫か", a: "犬", b: "猫" });

  expect(res).toHaveStatus(201);
  expect(await db.changes()).toEqual({
    polls: { inserted: [expect.objectContaining({ title: "犬か猫か", option_a: "犬", option_b: "猫" })], updated: [], deleted: [] },
  });
  expect(stub("slack")).toHaveReceivedTimes(1, "POST", "/hook", { json: { text: "新しい投票: 犬か猫か（犬 vs 猫）" } });
});

scenario("C2 a failing notification leaves no poll behind", async ({ http, db, stub }) => {
  stub("slack").on("POST", "/hook").reply(500);

  expect(await http.post("/polls", { title: "山か海か", a: "山", b: "海" })).toHaveStatus(502);

  expect(await db.changes()).toEqual({});
  expect(stub("slack")).toHaveReceivedTimes(1, "POST", "/hook");
});

scenario("C3 a dropped connection to slack leaves no poll behind", async ({ http, db, stub }) => {
  stub("slack").on("POST", "/hook").networkError();

  expect(await http.post("/polls", { title: "夏か冬か", a: "夏", b: "冬" })).toHaveStatus(502);

  expect(await db.changes()).toEqual({});
});

scenario("C4 a poll without options is a 400 and nothing happens", async ({ http, db, stub }) => {
  expect(await http.post("/polls", { title: "選択肢なし" })).toHaveStatus(400);

  expect(await db.changes()).toEqual({});
  expect(stub("slack")).toHaveReceivedTimes(0);
});

scenario("C5 voting a and b stores one vote each", async ({ http, db }) => {
  expect(await http.post("/polls/1/votes", { choice: "a" })).toHaveStatus(204);
  expect(await http.post("/polls/1/votes", { choice: "b" })).toHaveStatus(204);

  expect(await db.changes()).toEqual({
    votes: { inserted: [expect.objectContaining({ choice: "a" }), expect.objectContaining({ choice: "b" })], updated: [], deleted: [] },
  });
});

scenario("C6 an invalid choice is a 400 and an unknown poll a 404", async ({ http, db }) => {
  expect(await http.post("/polls/1/votes", { choice: "x" })).toHaveStatus(400);
  expect(await http.post("/polls/999/votes", { choice: "a" })).toHaveStatus(404);

  expect(await db.changes()).toEqual({});
});

scenario("C7 the aggregate counts each choice", async ({ http, db }) => {
  await db.insert("votes", [{ poll_id: 1, choice: "a" }, { poll_id: 1, choice: "a" }, { poll_id: 1, choice: "b" }]);

  const res = await http.get("/polls/1");

  expect(res).toHaveStatus(200);
  expect(res.json).toEqual({ id: 1, title: "朝食は？", options: { a: "ごはん", b: "パン" }, votes: { a: 2, b: 1 } });
});

scenario("C8 ten simultaneous votes are all stored", async ({ http, db }) => {
  const responses = await http.concurrently(10, () => http.post("/polls/1/votes", { choice: "a" }));

  expect(responses).toHaveStatuses({ 204: 10 });
  expect(await db.count("votes", { poll_id: 1 })).toBe(10);
});

scenario("C9 every case starts from the seed", async ({ db }) => {
  expect(await db.count("votes")).toBe(0);
  expect(await db.rows("polls")).toMatchObject([{ id: 1, title: "朝食は？" }]);
  expect(await db.rows("polls")).toHaveLength(1);
});
