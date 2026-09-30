# A tiny blog API on Python's sqlite3, holding one connection for its lifetime
# the way a real app does. slicetest resets the same file between scenarios.
import json, os, sqlite3
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

    def do_GET(self):
        if self.path == "/posts":
            rows = db.execute("SELECT p.id, a.name AS author, p.title FROM posts p JOIN authors a ON a.id = p.author_id ORDER BY p.id").fetchall()
            return self.send(200, [{"id": r[0], "author": r[1], "title": r[2]} for r in rows])
        self.send(200, {"site": db.execute("SELECT value FROM settings WHERE key = 'site'").fetchone()[0]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
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
