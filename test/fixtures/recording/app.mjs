import http from "node:http";

http
  .createServer(async (req, res) => {
    const city = new URL(req.url, "http://x").searchParams.get("city");
    const r = await fetch(`${process.env.WEATHER_URL}/forecast?city=${city}`, { headers: { authorization: "Bearer real-token" } });
    res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify({ city, weather: r.ok ? await r.json() : await r.text() }));
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("app ready"));
