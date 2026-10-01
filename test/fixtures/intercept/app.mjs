// An app with its providers' URLs written into the code, as many apps have.
// slicetest catches these calls with `stubs: [{ name, hosts }]`; the app is not changed.
import http from "node:http";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const json = (status, body, headers = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  try {
    if (url.pathname === "/weather") {
      const r = await fetch(`https://api.weather.test/v1/now?city=${encodeURIComponent(url.searchParams.get("city"))}`, { headers: { authorization: "Bearer weather-key" } });
      if (!r.ok) return json(502, { error: `weather service answered ${r.status}` });
      return json(200, { city: url.searchParams.get("city"), temperature: (await r.json()).temp_c });
    }
    // OAuth-style login: to the provider's page, back with a code, exchange it server-side.
    if (url.pathname === "/login") {
      const back = `http://${req.headers.host}/callback`;
      return res.writeHead(302, { location: `https://id.provider.test/authorize?client_id=app&redirect_uri=${encodeURIComponent(back)}&state=s-123` }).end();
    }
    if (url.pathname === "/callback") {
      if (url.searchParams.get("state") !== "s-123") return json(400, { error: "bad state" });
      const r = await fetch("https://id.provider.test/token", { method: "POST", body: new URLSearchParams({ code: url.searchParams.get("code"), client_id: "app" }) });
      const { access_token } = await r.json();
      return res.writeHead(303, { location: "/me", "set-cookie": `session=${access_token}; Path=/; HttpOnly` }).end();
    }
    if (url.pathname === "/me") {
      const token = /session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
      return token ? json(200, { token }) : json(401, { error: "not logged in" });
    }
    json(200, { ok: true });
  } catch (e) {
    json(500, { error: String(e.cause?.message ?? e.message) });
  }
});
server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("app ready"));
