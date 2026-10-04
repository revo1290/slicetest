// A second process with background work of its own: POST /work keeps it busy for 10 s.
import http from "node:http";

let busyUntil = 0;
http
  .createServer((req, res) => {
    const route = `${req.method} ${req.url}`;
    res.setHeader("content-type", "application/json");
    if (route === "POST /work") busyUntil = Date.now() + 10_000;
    if (route === "GET /__test/idle") res.statusCode = Date.now() < busyUntil ? 503 : 200;
    res.end(JSON.stringify({ pid: process.pid }));
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("service ready"));
