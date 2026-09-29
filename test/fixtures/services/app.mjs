import http from "node:http";

http
  .createServer(async (req, res) => {
    if (req.url === "/quote") {
      const r = await fetch(`${process.env.PRICING_URL}/price?item=book`);
      const { price } = await r.json();
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ item: "book", price }));
    }
    if (req.url === "/signup") {
      const r = await fetch(`${process.env.MAILER_URL}/v3/mail/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "a@example.com", subject: "Welcome" }),
      });
      const sent = await r.json();
      const u = await fetch(`${process.env.MAILER_URL}/v3/users/42`);
      return res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ status: r.status, sent, user: await u.json() }));
    }
    res.writeHead(200).end("ok");
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("app ready"));
