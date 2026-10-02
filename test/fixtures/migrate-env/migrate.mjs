// A migration tool that reads its own variables instead of DATABASE_URL, like Laravel's DB_* or EF Core's connection string.
import { DatabaseSync } from "node:sqlite";
const [file] = process.argv.slice(2);
if (file !== process.env.DB_DATABASE) throw new Error(`argument ${file} and DB_DATABASE ${process.env.DB_DATABASE} differ`);
if (!process.env.CONNECTION.startsWith("Data Source=")) throw new Error(`CONNECTION is ${process.env.CONNECTION}`);
const db = new DatabaseSync(file);
db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)");
db.close();
