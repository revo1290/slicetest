"""Standard library http.server + psycopg. Same API as the Node example."""
import json
import os
import re
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psycopg

DB_URL = os.environ["DATABASE_URL"]


def notify_slack(text):
    req = urllib.request.Request(
        os.environ["SLACK_WEBHOOK_URL"],
        data=json.dumps({"text": text}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=5)  # raises HTTPError on non-2xx


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, body=None):
        self.send_response(status)
        if body is not None:
            self.send_header("content-type", "application/json")
        self.end_headers()
        if body is not None:
            self.wfile.write(json.dumps(body, ensure_ascii=False).encode())

    def read_json(self):
        length = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(length)) if length else {}

    def do_GET(self):
        if self.path == "/health":
            return self.send(200, {"ok": True})
        m = re.fullmatch(r"/polls/(\d+)", self.path)
        if not m:
            return self.send(404, {"error": "not found"})
        with psycopg.connect(DB_URL) as conn:
            row = conn.execute(
                """SELECT p.id, p.title, p.option_a, p.option_b,
                          count(v.*) FILTER (WHERE v.choice = 'a'),
                          count(v.*) FILTER (WHERE v.choice = 'b')
                     FROM polls p LEFT JOIN votes v ON v.poll_id = p.id
                    WHERE p.id = %s GROUP BY p.id""",
                (int(m[1]),),
            ).fetchone()
        if row is None:
            return self.send(404, {"error": "not found"})
        self.send(200, {
            "id": row[0],
            "title": row[1],
            "options": {"a": row[2], "b": row[3]},
            "votes": {"a": row[4], "b": row[5]},
        })

    def do_POST(self):
        if self.path == "/polls":
            body = self.read_json()
            title, a, b = body.get("title"), body.get("a"), body.get("b")
            if not (title and a and b):
                return self.send(400, {"error": "title, a and b are required"})
            try:
                with psycopg.connect(DB_URL) as conn:  # commits on success, rolls back on exception
                    poll_id = conn.execute(
                        "INSERT INTO polls (title, option_a, option_b) VALUES (%s, %s, %s) RETURNING id",
                        (title, a, b),
                    ).fetchone()[0]
                    notify_slack(f"新しい投票: {title}（{a} vs {b}）")
            except Exception as e:
                print(f"create poll failed: {e}", flush=True)
                return self.send(502, {"error": "notification failed"})
            return self.send(201, {"id": poll_id})

        m = re.fullmatch(r"/polls/(\d+)/votes", self.path)
        if not m:
            return self.send(404, {"error": "not found"})
        choice = self.read_json().get("choice")
        if choice not in ("a", "b"):
            return self.send(400, {"error": "choice must be a or b"})
        with psycopg.connect(DB_URL) as conn:
            cur = conn.execute(
                "INSERT INTO votes (poll_id, choice) SELECT id, %s FROM polls WHERE id = %s",
                (choice, int(m[1])),
            )
        if cur.rowcount:
            self.send(204)
        else:
            self.send(404, {"error": "not found"})


if __name__ == "__main__":
    port = int(os.environ["PORT"])
    print(f"listening on {port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
