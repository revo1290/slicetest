# A tiny blog API on Python's sqlite3, holding one connection for its lifetime
# the way a real app does. slicetest resets the same file between scenarios.
import html, json, os, secrets, sqlite3
from urllib.parse import parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

db = sqlite3.connect(os.environ["DB_PATH"], check_same_thread=False, isolation_level=None)
db.execute("PRAGMA foreign_keys = ON")
db.execute("PRAGMA busy_timeout = 5000")

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def send(self, status, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def page(self, status, body, headers=()):
        data = body.encode()
        self.send_response(status)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        for k, v in headers: self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def cookie(self, name):
        for part in (self.headers.get("cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == name: return v
        return None

    def do_GET(self):
        # A server-rendered form with a CSRF token, as Django or Rails would render it.
        if self.path == "/signup":
            token = secrets.token_hex(8)
            return self.page(200, f"""<form method="post" action="/signup"><input type="hidden" name="csrf" value="{token}">
                <input name="name"><label><input type="checkbox" name="newsletter" value="yes"> News</label>
                <button name="intent" value="join">Sign up</button></form>
                <form action="/search"><input name="q"><button>Search</button></form>""", [("set-cookie", f"csrf={token}; Path=/")])
        if self.path.startswith("/authors/"):
            row = db.execute("SELECT name FROM authors WHERE id = ?", (int(self.path.split("/")[2]),)).fetchone()
            return self.page(200, f"<h1>Welcome, {html.escape(row[0])}</h1>") if row else self.send(404)
        if self.path == "/posts":
            rows = db.execute("SELECT p.id, a.name AS author, p.title FROM posts p JOIN authors a ON a.id = p.author_id ORDER BY p.id").fetchall()
            return self.send(200, [{"id": r[0], "author": r[1], "title": r[2]} for r in rows])
        self.send(200, {"site": db.execute("SELECT value FROM settings WHERE key = 'site'").fetchone()[0]})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["content-length"]))
        if self.path == "/signup":
            form = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
            if not form.get("csrf") or form["csrf"] != self.cookie("csrf"):
                return self.page(403, "CSRF token missing or incorrect")
            if form.get("intent") != "join":
                return self.page(400, "which button?")
            cur = db.execute("INSERT INTO authors (name) VALUES (?)", (form["name"] + (" (news)" if form.get("newsletter") == "yes" else ""),))
            return self.page(303, "", [("location", f"/authors/{cur.lastrowid}")])
        body = json.loads(raw)
        if self.path == "/posts":
            row = db.execute("SELECT id FROM authors WHERE name = ?", (body["author"],)).fetchone()
            if row is None:
                return self.send(422, {"error": "unknown author"})
            cur = db.execute("INSERT INTO posts (author_id, title) VALUES (?, ?)", (row[0], body["title"]))
            return self.send(201, {"id": cur.lastrowid})
        self.send(404)

server = ThreadingHTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler)
print("app ready", flush=True)
server.serve_forever()
