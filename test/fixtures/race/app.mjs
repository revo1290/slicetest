import http from "node:http";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Check, then insert: two requests can both pass the check. /book relies on the
// unique constraint and turns the violation into a 409; /book-naive has none.
async function book(table, seat) {
  const { rowCount } = await pool.query(`SELECT 1 FROM ${table} WHERE seat = $1`, [seat]);
  if (rowCount) return 409;
  await sleep(30);
  try {
    await pool.query(`INSERT INTO ${table} (seat) VALUES ($1)`, [seat]);
    return 201;
  } catch (e) {
    if (e.code === "23505") return 409;
    throw e;
  }
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://app");
    const seat = Number(url.searchParams.get("seat"));
    if (req.method === "POST" && url.pathname === "/book") return res.writeHead(await book("bookings", seat)).end();
    if (req.method === "POST" && url.pathname === "/book-naive") return res.writeHead(await book("naive_bookings", seat)).end();
    res.writeHead(200).end("ok");
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("app ready"));
