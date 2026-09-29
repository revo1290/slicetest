import http from "node:http";

http
  .createServer((req, res) => {
    if (req.url === "/die") {
      console.error("sidecar: exiting on request");
      process.exit(9);
    }
    res.writeHead(200).end("sidecar ok");
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("sidecar up"));
