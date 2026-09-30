import http from "node:http";
import mysql from "mysql2/promise";

const pool = mysql.createPool(process.env.DATABASE_URL);

http
  .createServer(async (req, res) => {
    const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "POST" && req.url === "/posts") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const { authorId, title } = JSON.parse(text);
      const [r] = await pool.query("INSERT INTO posts (author_id, title) VALUES (?, ?)", [authorId, title]);
      return send(201, { id: r.insertId });
    }
    const publish = req.url.match(/^\/posts\/(\d+)\/publish$/);
    if (req.method === "POST" && publish) {
      await pool.query("UPDATE posts SET published = true WHERE id = ?", [Number(publish[1])]);
      return send(200, { ok: true });
    }
    if (req.url === "/feed") {
      const [rows] = await pool.query("SELECT id, title, author FROM published_posts ORDER BY id");
      return send(200, rows);
    }
    res.writeHead(200).end("ok");
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("app ready"));
