import http from "node:http";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://app");
    try {
      if (req.method === "POST" && url.pathname === "/plans") {
        const { rows } = await pool.query("INSERT INTO plans (name) VALUES ($1) RETURNING id", [url.searchParams.get("name")]);
        return res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(rows[0]));
      }
      if (req.method === "POST" && url.pathname === "/users") {
        const { rows } = await pool.query("INSERT INTO users (plan_id, email) VALUES (1, $1) RETURNING id", [url.searchParams.get("email")]);
        return res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: Number(rows[0].id) }));
      }
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(500).end(String(e.message));
    }
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("app ready"));
