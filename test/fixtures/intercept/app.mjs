// An app with its providers' URLs written into the code, as many apps have.
// slicetest catches these calls with `stubs: [{ name, hosts }]`; the app is not changed.
import http from "node:http";

const jobs = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const json = (status, body, headers = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  try {
    if (url.pathname === "/weather") {
      const r = await fetch(`https://api.weather.test/v1/now?city=${encodeURIComponent(url.searchParams.get("city"))}`, { headers: { authorization: "Bearer weather-key" } });
      if (!r.ok) return json(502, { error: `weather service answered ${r.status}` });
      return json(200, { city: url.searchParams.get("city"), temperature: (await r.json()).temp_c });
    }
    if (url.pathname === "/ask") {
      // Relays a streamed answer, as an app in front of an LLM API does.
      const r = await fetch("https://api.weather.test/v1/forecast/stream", { method: "POST" });
      const text = (await r.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)).text ?? "").join("");
      return json(200, { contentType: r.headers.get("content-type"), text });
    }
    if (url.pathname === "/upload-form") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<form method="post" action="/upload" enctype="multipart/form-data"><input name="owner" value="ada"><input type="file" name="files"><button>Send</button></form>`);
    }
    if (url.pathname === "/upload") {
      // Takes an upload and passes it on to a storage API, as a multipart body again.
      const form = await new Request("http://x", { method: "POST", headers: req.headers, body: req, duplex: "half" }).formData();
      const out = new FormData();
      out.append("owner", form.get("owner"));
      for (const f of form.getAll("files")) out.append("files", f, f.name);
      const r = await fetch("https://api.weather.test/v1/uploads", { method: "POST", body: out });
      return json(r.status, { stored: (await r.json()).count, names: form.getAll("files").map((f) => `${f.name} (${f.type}, ${f.size})`) });
    }
    // A job that finishes in the background, as queues and batch exports do.
    if (url.pathname === "/jobs" && req.method === "POST") {
      const id = String(jobs.size + 1);
      jobs.set(id, Date.now() + 300);
      return json(202, { id });
    }
    if (url.pathname.startsWith("/jobs/")) {
      const due = jobs.get(url.pathname.slice(6));
      return due === undefined ? json(404, {}) : json(200, { status: Date.now() >= due ? "done" : "running" });
    }
    // Two providers in a row: read the weather, then notify about it.
    if (url.pathname === "/alert") {
      const now = await (await fetch("https://api.weather.test/v1/now?city=Tokyo")).json();
      await fetch("https://id.provider.test/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `${now.temp_c}°C` }) });
      return json(200, { sent: true });
    }
    if (url.pathname === "/logo") {
      const r = await fetch("https://api.weather.test/v1/logo.png");
      const bytes = new Uint8Array(await r.arrayBuffer());
      return json(200, { type: r.headers.get("content-type"), size: bytes.length, first: [...bytes.slice(0, 4)] });
    }
    if (url.pathname === "/feed") {
      const r = await fetch(`https://${url.searchParams.get("group")}.groups.test/ja.atom`);
      return json(200, { feed: await r.text() });
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
