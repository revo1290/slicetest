npm init -y >/dev/null
npm pkg set type=module scripts.start="node server.js" >/dev/null
npm i --silent --no-audit --no-fund express@5 pg@8
mkdir migrations
echo 'create table items (id serial primary key, name text not null);' > migrations/001_init.sql
cat > server.js <<'E'
import express from "express";
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(express.json());
app.get("/", (_req, res) => res.json({ ok: true }));
app.post("/items", async (req, res) => {
  const { rows } = await pool.query("insert into items (name) values ($1) returning *", [req.body.name]);
  res.status(201).json(rows[0]);
});
app.listen(process.env.PORT);
E
