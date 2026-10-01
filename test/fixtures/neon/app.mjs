// An app on Neon's serverless driver over HTTP, as on Vercel. Its DATABASE_URL is Neon-style;
// slicetest answers the driver's HTTP queries from the test database.
import http from "node:http";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

http
  .createServer(async (req, res) => {
    const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    try {
      if (req.method === "POST" && req.url === "/notes") {
        let raw = "";
        for await (const c of req) raw += c;
        const { title, tags } = JSON.parse(raw);
        const [note] = await sql`INSERT INTO notes (title, tags) VALUES (${title}, ${tags}) RETURNING id, title, tags, created_at`;
        return json(201, { ...note, createdIsDate: note.created_at instanceof Date });
      }
      if (req.url === "/notes") return json(200, await sql`SELECT id, title FROM notes ORDER BY id`);
      if (req.url === "/stats") {
        // A batch runs in one transaction.
        const [count, latest] = await sql.transaction([sql`SELECT count(*)::int AS n FROM notes`, sql`SELECT max(id) AS id FROM notes`], { isolationLevel: "RepeatableRead" });
        return json(200, { count: count[0].n, latest: latest[0].id });
      }
      json(404, {});
    } catch (e) {
      // The driver copies Postgres's error fields onto the error.
      json(e.code === "23505" ? 409 : 500, { code: e.code ?? null, message: e.message });
    }
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready"));
