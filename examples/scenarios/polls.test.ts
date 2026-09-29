// The same scenarios run against the Node app and the Python app.
import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("投票を作るとDBに保存され、Slackに通知される", async ({ http, db, stub }) => {
  stub("slack").on("POST", "/hook").reply(200, "ok");

  const res = await http.post("/polls", { title: "犬か猫か", a: "犬", b: "猫" });

  expect(res).toHaveStatus(201);
  expect(await db.one("polls", { title: "犬か猫か" })).toMatchObject({ id: res.json.id, option_a: "犬", option_b: "猫" });
  expect(stub("slack")).toHaveReceivedTimes(1, "POST", "/hook");
  expect(stub("slack")).toHaveReceived("POST", "/hook", {
    json: { text: "新しい投票: 犬か猫か（犬 vs 猫）" },
    headers: { "content-type": /json/ },
  });
});

scenario("Slack通知に失敗したら投票は作られない", async ({ http, db, stub }) => {
  stub("slack").on("POST", "/hook").reply(500);

  const res = await http.post("/polls", { title: "山か海か", a: "山", b: "海" });

  expect(res).toHaveStatus(502);
  await expect(db).toHaveRow("polls", { title: "山か海か" }, 0);
});

scenario("Slackに繋がらなくても投票は作られない", async ({ http, db, stub }) => {
  stub("slack").on("POST", "/hook").networkError();

  expect(await http.post("/polls", { title: "夏か冬か", a: "夏", b: "冬" })).toHaveStatus(502);
  await expect(db).not.toHaveRow("polls", { title: "夏か冬か" });
});

scenario("seed のデータがあり、投票の集計が返る", async ({ http, db }) => {
  const seeded = await db.one<{ id: number }>("polls", { title: "朝食は？" });
  await db.insert("votes", [
    { poll_id: seeded.id, choice: "a" },
    { poll_id: seeded.id, choice: "a" },
    { poll_id: seeded.id, choice: "b" },
  ]);

  const res = await http.get(`/polls/${seeded.id}`);

  expect(res).toHaveStatus(200);
  expect(res.json).toEqual({
    id: 1,
    title: "朝食は？",
    options: { a: "ごはん", b: "パン" },
    votes: { a: 2, b: 1 },
  });
});

scenario.each([
  { choice: "a", poll: 1, status: 204 },
  { choice: "b", poll: 1, status: 204 },
  { choice: "x", poll: 1, status: 400 },
  { choice: "a", poll: 999, status: 404 },
])("poll $poll に $choice で投票すると $status", async ({ choice, poll, status }, { http, db }) => {
  expect(await http.post(`/polls/${poll}/votes`, { choice })).toHaveStatus(status);
  await expect(db).toHaveRow("votes", { poll_id: poll, choice }, status === 204 ? 1 : 0);
});

scenario("シナリオごとにDBはseed直後の状態へ戻る（IDも1から）", async ({ db }) => {
  expect(await db.count("votes")).toBe(0);
  expect(await db.rows("polls")).toMatchObject([{ id: 1, title: "朝食は？" }]);
});

scenario("db.changes() はシナリオ中にアプリが書いた行だけを返す", async ({ http, db, stub }) => {
  stub("slack").on("POST", "/hook").reply(200, "ok");
  await db.insert("votes", { poll_id: 1, choice: "a" });
  await db.checkpoint(); // ここまでの準備は差分に含めない

  const res = await http.post("/polls", { title: "右か左か", a: "右", b: "左" });

  expect(res).toHaveStatus(201);
  expect(await db.changes()).toEqual({
    polls: { inserted: [{ id: res.json.id, title: "右か左か", option_a: "右", option_b: "左" }], updated: [], deleted: [] },
  });
});

scenario("db.changes() は更新と削除を主キーで突き合わせる", async ({ db }) => {
  const [inserted] = await db.insert("polls", { title: "夕食は？", option_a: "和", option_b: "洋" });
  await db.checkpoint();
  await db.query("UPDATE polls SET option_b = '中' WHERE id = $1", [inserted!.id]);

  expect(await db.changes()).toEqual({
    polls: {
      inserted: [],
      updated: [{ key: { id: inserted!.id }, before: inserted, after: { ...inserted, option_b: "中" }, changed: ["option_b"] }],
      deleted: [],
    },
  });
});

scenario("db.changes() は seed の行の削除も報告する", async ({ db }) => {
  await db.query("DELETE FROM polls WHERE id = 1");

  expect(await db.changes()).toEqual({
    polls: { inserted: [], updated: [], deleted: [{ id: 1, title: "朝食は？", option_a: "ごはん", option_b: "パン" }] },
  });
});
