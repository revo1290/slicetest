import http from "node:http";

const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

http
  .createServer(async (req, res) => {
    if (req.url === "/users/1") return json(res, 200, { id: "1", name: "alice" }); // id should be an integer
    if (req.url === "/users/2") return json(res, 200, { id: 2, name: "bob" });
    if (req.url === "/users/3") return json(res, 418, { error: "teapot" }); // undocumented status
    if (req.url === "/secret") return json(res, 200, {}); // undocumented path
    if (req.url === "/signup") {
      const r = await fetch(`${process.env.MAIL_URL}/v3/mail/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "not-an-email" }), // missing "subject", bad format
      });
      return json(res, 201, { id: 1, mailStatus: r.status });
    }
    res.writeHead(200).end("ok");
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("fixture ready"));
