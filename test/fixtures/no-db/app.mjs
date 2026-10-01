import http from "node:http";
// No database: it forwards to an API and reports what its environment holds.
http
  .createServer(async (req, res) => {
    if (req.url === "/env") return res.end(JSON.stringify({ DATABASE_URL: process.env.DATABASE_URL ?? null }));
    const r = await fetch(`${process.env.API_URL}/quote`);
    res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready"));
