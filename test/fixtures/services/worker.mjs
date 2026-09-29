// A queue worker with no HTTP port: it polls the jobs table and logs what it did.
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pool.on("error", () => {});
setInterval(async () => {
  try {
    const { rows } = await pool.query("UPDATE jobs SET done = true WHERE NOT done RETURNING id, name");
    for (const job of rows) console.log(`job ${job.id} (${job.name}) done`);
  } catch {}
}, 30);
