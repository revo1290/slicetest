// The cache never invalidates and the timer is never awaited, on purpose: that is the state under test.
import http from "node:http";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.DATABASE_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");

let cachedCount;
const pending = new Set();

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};

const readJson = async (req) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === "GET /pid") return send(res, 200, { pid: process.pid });
      if (route === "GET /count") {
        cachedCount ??= db.prepare("SELECT count(*) AS n FROM items").get().n;
        return send(res, 200, { count: cachedCount });
      }
      if (route === "POST /items") {
        const { owner = "", body = "" } = await readJson(req);
        db.prepare("INSERT INTO items (owner, body) VALUES (?, ?)").run(owner, body);
        return send(res, 201, {});
      }
      if (route === "POST /items/later") {
        const { delayMs = 150, body = "late" } = await readJson(req);
        const timer = setTimeout(() => {
          pending.delete(timer);
          db.prepare("INSERT INTO items (owner, body) VALUES ('', ?)").run(body);
        }, delayMs);
        pending.add(timer);
        return send(res, 202, {});
      }
      if (route === "GET /login") return send(res, 200, {}, { "set-cookie": "sid=abc; Path=/" });
      if (route === "GET /whoami") return send(res, 200, { cookie: req.headers.cookie ?? null });
      if (route === "GET /via-stub") {
        const upstream = await fetch(`${process.env.STUB_URL}/ping`);
        return send(res, 200, await upstream.json());
      }
      if (route === "POST /__test/reset") {
        cachedCount = undefined;
        for (const timer of pending) clearTimeout(timer);
        pending.clear();
        return send(res, 204);
      }
      if (route === "GET /__test/idle") return send(res, pending.size === 0 ? 200 : 503, { pending: pending.size });
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: String(e) });
    }
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("app ready"));
