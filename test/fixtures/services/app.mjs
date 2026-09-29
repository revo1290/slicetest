import http from "node:http";

http
  .createServer(async (req, res) => {
    if (req.url === "/quote") {
      const r = await fetch(`${process.env.PRICING_URL}/price?item=book`);
      const { price } = await r.json();
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ item: "book", price }));
    }
    res.writeHead(200).end("ok");
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("app ready"));
