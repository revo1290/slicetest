import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Admin, Driver, Engine, Row, Table, TableShape } from "./driver.js";

/**
 * SQLite through Node's built-in `node:sqlite` (Node 22.5+): no server, no
 * container. A "server" is a directory, a database is a file in it, cloning a
 * template is `VACUUM INTO`. The app opens the same file; WAL mode lets it keep
 * its connection while slicetest reads and resets tables.
 *
 * URLs are `sqlite:///absolute/path` (the SQLAlchemy / dj-database-url form);
 * `{{db.path}}` is the plain file path for apps that want that.
 */

type Sqlite = typeof import("node:sqlite");
let loaded: Promise<Sqlite> | undefined;

/** `node:sqlite` warns that it's experimental on every import; that's noise in test output. */
function load() {
  return (loaded ??= (async () => {
    const emit = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      if (String(typeof warning === "string" ? warning : warning.message).includes("SQLite")) return;
      (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      return await import("node:sqlite");
    } catch {
      throw new Error(`slicetest: db.engine "sqlite" needs Node.js 22.5 or later (node:sqlite); this is ${process.versions.node}`);
    } finally {
      process.emitWarning = emit;
    }
  })());
}

/** `sqlite:///tmp/a.db` → `/tmp/a.db`; `sqlite:///C:/x/a.db` → `C:/x/a.db`. Plain paths pass through. */
export function sqlitePath(url: string) {
  if (!url.startsWith("sqlite:")) return url;
  const p = decodeURIComponent(url.replace(/^sqlite:(\/\/)?/, "").replace(/[?#].*$/, ""));
  return /^\/[a-zA-Z]:[\\/]/.test(p) ? p.slice(1) : p;
}

export function sqliteUrl(file: string) {
  const p = path.resolve(file).replace(/\\/g, "/");
  return `sqlite://${p.startsWith("/") ? "" : "/"}${p}`;
}

/** Values node:sqlite can't bind are stored the way an app would store them. */
/** The parenthesised bodies of every CHECK in a CREATE TABLE statement. */
function checkBodies(sql: string) {
  const bodies: string[] = [];
  for (const m of sql.matchAll(/\bcheck\s*\(/gi)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < sql.length && depth > 0; i++) {
      if (sql[i] === "'") i = sql.indexOf("'", i + 1);
      else if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
      if (i < 0) return bodies;
    }
    bodies.push(sql.slice(start, i - 1));
  }
  return bodies;
}

function bind(v: unknown) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === "object" && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v === undefined ? null : v;
}

async function openDb(file: string) {
  const { DatabaseSync } = await load();
  const db = new DatabaseSync(file);
  // The app may be writing; wait for its lock instead of failing with SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export class SqliteDriver implements Driver {
  private constructor(private readonly db: DatabaseSync) {}

  static async connect(url: string) {
    const db = await openDb(sqlitePath(url));
    // Read now, before the app starts: the first connection to open the -shm file truncates it, and on Windows
    // that failed (SQLITE_IOERR_TRUNCATE) when it was slicetest's first read right after app.restart killed the app.
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    return new SqliteDriver(db);
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const values = params.map(bind) as never[];
    // Rows come with a null prototype; plain objects compare and print as expected.
    return stmt.columns().length === 0 ? (stmt.run(...values), []) : (stmt.all(...values).map((r) => ({ ...r })) as T[]);
  }

  async queryAll(sqls: string[]): Promise<Row[][]> {
    return Promise.all(sqls.map((s) => this.query(s)));
  }

  async exec(script: string) {
    this.db.exec(script);
  }

  ident(name: string) {
    return name
      .split(".")
      .map((part) => this.column(part))
      .join(".");
  }

  column(name: string) {
    return `"${name.replace(/"/g, '""')}"`;
  }

  param(n: number) {
    return `?${n}`;
  }

  inList(column: string, values: unknown[], params: unknown[]) {
    if (values.length === 0) return "0";
    const start = params.length;
    params.push(...values);
    return `${this.ident(column)} IN (${values.map((_, i) => `?${start + i + 1}`).join(", ")})`;
  }

  /** SQLite has one schema per file (`main`), so `schemas` doesn't apply. */
  async listTables(_schemas: string[], keep: string[]): Promise<Table[]> {
    const rows = await this.query<{ name: string; key: string | null }>(
      `SELECT m.name AS name,
              (SELECT group_concat(name, char(10)) FROM (SELECT name FROM pragma_table_info(m.name) WHERE pk > 0 ORDER BY pk)) AS key
         FROM sqlite_master m
        WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
        ORDER BY 1`,
    );
    return rows
      .filter((r) => !keep.includes(r.name) && !keep.includes(`main.${r.name}`))
      .map((r) => ({ name: r.name, quoted: this.ident(r.name), key: r.key ? r.key.split("\n") : [] }));
  }

  /** DELETE, then forget AUTOINCREMENT counters. Foreign keys are off for this connection only. */
  async truncate(tables: Table[]) {
    if (tables.length === 0) return;
    const sequence = (await this.query("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'")).length > 0;
    const names = tables.map((t) => `'${t.name.replace(/'/g, "''")}'`).join(", ");
    this.db.exec(
      `PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE; ${tables.map((t) => `DELETE FROM ${t.quoted};`).join(" ")}` +
        `${sequence ? ` DELETE FROM sqlite_sequence WHERE name IN (${names});` : ""} COMMIT; PRAGMA foreign_keys = ON;`,
    );
  }

  async insert(table: string, row: Row) {
    const cols = Object.keys(row);
    const sql =
      cols.length === 0
        ? `INSERT INTO ${this.ident(table)} DEFAULT VALUES RETURNING *`
        : `INSERT INTO ${this.ident(table)} (${cols.map((c) => this.column(c)).join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")}) RETURNING *`;
    return this.query(sql, Object.values(row));
  }

  async describe(table: string): Promise<TableShape> {
    const [master] = await this.query<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1", [table]);
    if (!master) throw new Error(`slicetest: there is no table "${table}"`);
    const columns = await this.query<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number; hidden: number }>(
      "SELECT name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo(?1) ORDER BY cid",
      [table],
    );
    const pk = columns.filter((c) => c.pk > 0);
    // An INTEGER PRIMARY KEY is the rowid: SQLite assigns it.
    const rowid = pk.length === 1 && pk[0]!.type.toUpperCase() === "INTEGER" ? pk[0]!.name : undefined;
    const keys = await this.query<{ id: number; table: string; from: string; to: string | null }>(
      'SELECT id, "table", "from", "to" FROM pragma_foreign_key_list(?1) ORDER BY id, seq',
      [table],
    );
    const foreignKeys = new Map<number, { columns: string[]; table: string; references: string[] }>();
    for (const k of keys) {
      const fk = foreignKeys.get(k.id) ?? { columns: [], table: k.table, references: [] };
      fk.columns.push(k.from);
      if (k.to !== null) fk.references.push(k.to);
      foreignKeys.set(k.id, fk);
    }
    return {
      columns: columns
        .filter((c) => c.hidden !== 1)
        .map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.notnull === 0 && c.pk === 0,
          hasDefault: c.dflt_value !== null || c.hidden > 1 || c.name === rowid,
          maxLength: Number(/\((\d+)\)/.exec(c.type)?.[1]) || undefined,
        })),
      foreignKeys: [...foreignKeys.values()],
      checks: checkBodies(master.sql),
    };
  }

  async close() {
    this.db.close();
  }
}

class SqliteAdmin implements Admin {
  constructor(private readonly dir: string) {}

  #file(name: string) {
    return path.join(this.dir, `${name}.db`);
  }

  async databases(prefix: string) {
    return (await readdir(this.dir)).filter((f) => f.endsWith(".db") && f.startsWith(prefix)).map((f) => f.slice(0, -3));
  }

  async create(name: string) {
    const db = await openDb(this.#file(name));
    // Persisted in the file: the app and slicetest can then read and write at the same time.
    db.exec("PRAGMA journal_mode = WAL");
    db.close();
  }

  async clone(template: string, name: string) {
    const db = await openDb(this.#file(template));
    try {
      db.prepare("VACUUM INTO ?").run(this.#file(name));
    } finally {
      db.close();
    }
    const copy = await openDb(this.#file(name));
    copy.exec("PRAGMA journal_mode = WAL");
    copy.close();
  }

  async drop(name: string) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(this.#file(name) + suffix, { force: true });
  }

  /** A lock file, for runs sharing the directory (with `reuse`). */
  async withLock<T>(key: string, fn: () => Promise<T>) {
    const lock = path.join(this.dir, `${key}.lock`);
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        await (await open(lock, "wx")).close();
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST" || Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true });
    }
  }

  urlFor(name: string) {
    return sqliteUrl(this.#file(name));
  }

  async close() {}
}

export const sqliteEngine: Engine = {
  name: "sqlite",
  defaultImage: "",
  local: true,
  /** No container: a directory of database files, kept between runs with `reuse`. */
  async startContainer(_image, reuse) {
    await load();
    const dir = reuse ? path.join(os.tmpdir(), "slicetest-sqlite") : await mkdtemp(path.join(os.tmpdir(), "slicetest-sqlite-"));
    await mkdir(dir, { recursive: true });
    return { url: sqliteUrl(dir), stop: () => rm(dir, { recursive: true, force: true }) };
  },
  async admin(url) {
    const dir = sqlitePath(url);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    return new SqliteAdmin(dir);
  },
  driver: (url) => SqliteDriver.connect(url),
  atlasUrl: (url) => `sqlite://${sqlitePath(url)}`,
};
