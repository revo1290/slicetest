// Plain node:http + pg. No framework on purpose.
import http from "node:http";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pool.on("error", (e) => console.error("pool error:", e.message));

async function notifySlack(text) {
  const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`slack responded ${res.status}`);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function send(res, status, body) {
  res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function route(req, res) {
  const { pathname } = new URL(req.url, "http://x");
  if (req.method === "GET" && pathname === "/health") return send(res, 200, { ok: true });

  if (req.method === "POST" && pathname === "/polls") {
    const { title, a, b } = await readJson(req);
    if (!title || !a || !b) return send(res, 400, { error: "title, a and b are required" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "INSERT INTO polls (title, option_a, option_b) VALUES ($1, $2, $3) RETURNING id",
        [title, a, b],
      );
      await notifySlack(`新しい投票: ${title}（${a} vs ${b}）`);
      await client.query("COMMIT");
      return send(res, 201, { id: Number(rows[0].id) });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("create poll failed:", e.message);
      return send(res, 502, { error: "notification failed" });
    } finally {
      client.release();
    }
  }

  const m = pathname.match(/^\/polls\/(\d+)(\/votes)?$/);
  if (m && req.method === "GET" && !m[2]) {
    const { rows } = await pool.query(
      `SELECT p.id, p.title, p.option_a, p.option_b,
              count(v.*) FILTER (WHERE v.choice = 'a') AS a_votes,
              count(v.*) FILTER (WHERE v.choice = 'b') AS b_votes
         FROM polls p LEFT JOIN votes v ON v.poll_id = p.id
        WHERE p.id = $1 GROUP BY p.id`,
      [m[1]],
    );
    if (rows.length === 0) return send(res, 404, { error: "not found" });
    const p = rows[0];
    return send(res, 200, {
      id: Number(p.id),
      title: p.title,
      options: { a: p.option_a, b: p.option_b },
      votes: { a: Number(p.a_votes), b: Number(p.b_votes) },
    });
  }
  if (m && req.method === "POST" && m[2]) {
    const { choice } = await readJson(req);
    if (choice !== "a" && choice !== "b") return send(res, 400, { error: "choice must be a or b" });
    const { rowCount } = await pool.query(
      "INSERT INTO votes (poll_id, choice) SELECT id, $2 FROM polls WHERE id = $1",
      [m[1], choice],
    );
    return send(res, rowCount ? 204 : 404, rowCount ? undefined : { error: "not found" });
  }
  send(res, 404, { error: "not found" });
}

http
  .createServer((req, res) =>
    route(req, res).catch((e) => {
      console.error(e);
      send(res, 500, { error: "internal" });
    }),
  )
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log(`listening on ${process.env.PORT}`));
