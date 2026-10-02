import http from "node:http";
// Charges a card through the payments API, but only for orders over 0.
http
  .createServer(async (req, res) => {
    const amount = Number(new URL(req.url, "http://x").searchParams.get("amount"));
    if (amount > 0) await fetch(`${process.env.PAY_URL}/charges`, { method: "POST" });
    res.end("ok");
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready"));
