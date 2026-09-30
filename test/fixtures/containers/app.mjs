import http from "node:http";
import net from "node:net";

// A minimal Redis client: one command per connection, integer replies only.
function redis(...args) {
  return new Promise((resolve, reject) => {
    const [host, port] = process.env.REDIS_ADDR.split(":");
    const socket = net.connect(Number(port), host, () => socket.write(`*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join("")}`));
    socket.once("data", (d) => {
      socket.end();
      const line = d.toString().trim();
      line.startsWith(":") ? resolve(Number(line.slice(1))) : reject(new Error(line));
    });
    socket.once("error", reject);
  });
}

http
  .createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/hits") {
      const n = await redis("INCR", "hits");
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ hits: n }));
    }
    res.writeHead(200).end("ok");
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("app ready"));
