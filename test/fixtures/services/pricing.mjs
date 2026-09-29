// A second HTTP service the app depends on, started by slicetest as a service.
import http from "node:http";

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/die") process.exit(7);
    if (url.pathname === "/price") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ price: 1200 }));
    res.writeHead(200).end("ok");
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log(`pricing listening on ${process.env.PORT}`));
