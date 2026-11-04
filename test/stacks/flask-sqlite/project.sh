python3 -m venv .venv
printf 'flask\n' > requirements.txt
.venv/bin/pip -q install -r requirements.txt
mkdir migrations
echo 'create table items (id integer primary key autoincrement, name text not null);' > migrations/001_init.sql
cat > app.py <<'E'
import os, sqlite3
from flask import Flask, jsonify, request
app = Flask(__name__)
@app.get("/")
def home():
    return jsonify(ok=True)
@app.post("/items")
def create():
    db = sqlite3.connect(os.environ["DATABASE_URL"].removeprefix("sqlite:///"))
    cur = db.execute("insert into items (name) values (?)", (request.json["name"],))
    db.commit()
    return jsonify(id=cur.lastrowid, name=request.json["name"]), 201
E
