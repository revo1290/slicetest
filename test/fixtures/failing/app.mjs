import http from "node:http";

http
  .createServer(async (req, res) => {
    if (req.url === "/crash") {
      console.error("boom: about to crash");
      process.exit(3);
    }
    if (req.url === "/json") return res.writeHead(200, { "content-type": "application/json" }).end('{"user":{"name":"alice"}}');
    if (req.url === "/log-something") console.log("handled log-something");
    if (req.url === "/notify") {
      const r = await fetch(`${process.env.MAIL_URL}/send`, { method: "POST" });
      return res.writeHead(r.status).end();
    }
    res.writeHead(200).end("ok");
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("fixture ready"));
