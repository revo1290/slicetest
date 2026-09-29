import { readFile } from "node:fs/promises";
import pg from "pg";

/** Tables that record applied migrations. Truncating them would make tools re-run migrations. */
const MIGRATION_TABLES = [
  "atlas_schema_revisions",
  "schema_migrations",
  "_prisma_migrations",
  "__drizzle_migrations",
  "knex_migrations",
  "knex_migrations_lock",
  "alembic_version",
  "flyway_schema_history",
  "goose_db_version",
  "_sqlx_migrations",
  "__diesel_schema_migrations",
  "django_migrations",
  "databasechangelog",
  "databasechangeloglock",
  "SequelizeMeta",
  "ar_internal_metadata",
  "__EFMigrationsHistory",
];

export function withDatabase(url: string, database: string) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export interface Row {
  [column: string]: unknown;
}

/**
 * Column filters. `null` means IS NULL and an array means IN (...);
 * every other value is compared with `=`.
 */
export type Where = Record<string, unknown>;

export interface RowsOptions {
  /** Column(s) to sort by; prefix with `-` for descending. Default: the first column. */
  orderBy?: string | string[];
  limit?: number;
}

const INT8 = 20;

/** int8 columns (bigserial ids, count(*)) come back as numbers when they fit, instead of strings. */
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === INT8 && format !== "binary") {
      return (v: string) => {
        const n = Number(v);
        return Number.isSafeInteger(n) ? n : v;
      };
    }
    return pg.types.getTypeParser(oid, format as "text");
  },
};

/** Rows added, changed and removed in one table. */
export interface TableChanges<T extends Row = Row> {
  inserted: T[];
  /**
   * Matched by primary key (`key`); `changed` lists the columns that differ.
   * Tables without a primary key only report inserts and deletes.
   */
  updated: { key: Row; before: T; after: T; changed: string[] }[];
  deleted: T[];
}

/** Changed tables only, keyed by table name (`schema.table` outside `public`). */
export type Changes = Record<string, TableChanges>;

interface Table {
  /** Display name: `name` in public, else `schema.name`. */
  name: string;
  quoted: string;
  key: string[];
}

type Snapshot = Map<string, Row[]>;

/** Test-side handle to the database the app under test is using. */
export class Db {
  #client: pg.Client;
  #tables?: Table[];
  #seed?: string;
  /** Contents right after the reset (and seed); undefined means every table was empty. */
  #start?: Snapshot;
  #checkpoint?: Snapshot | "start";

  private constructor(
    client: pg.Client,
    readonly url: string,
    private readonly opts: { schemas: string[]; keep: string[] },
  ) {
    this.#client = client;
  }

  static async connect(url: string, opts: { schemas: string[]; keep: string[]; seedFile?: string }) {
    const client = new pg.Client({ connectionString: url, types });
    // Without a listener, a dropped connection would crash the worker; the next query reports it instead.
    client.on("error", () => {});
    await client.connect();
    const db = new Db(client, url, opts);
    if (opts.seedFile) db.#seed = await readFile(opts.seedFile, "utf8");
    return db;
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.#client.query<T>(sql, params)).rows;
  }

  /** Rows of a table, optionally filtered, ordered by the first column unless `orderBy` is given. */
  async rows<T extends Row = Row>(table: string, where: Where = {}, opts: RowsOptions = {}): Promise<T[]> {
    const { clause, params } = whereClause(where);
    const order = [opts.orderBy ?? []]
      .flat()
      .map((c) => (c.startsWith("-") ? `${ident(c.slice(1))} DESC` : ident(c)))
      .join(", ");
    const limit = opts.limit === undefined ? "" : ` LIMIT ${Math.trunc(opts.limit)}`;
    return this.query<T>(`SELECT * FROM ${ident(table)}${clause} ORDER BY ${order || "1"}${limit}`, params);
  }

  /** The single row matching `where`. Throws, listing what was found, unless there is exactly one. */
  async one<T extends Row = Row>(table: string, where: Where = {}): Promise<T> {
    const rows = await this.rows<T>(table, where, { limit: 3 });
    if (rows.length === 1) return rows[0]!;
    const found = rows.length === 0 ? "none" : `${rows.length === 3 ? "3 or more" : rows.length}, e.g.\n${rows.map((r) => `  ${JSON.stringify(r)}`).join("\n")}`;
    throw new Error(`slicetest: expected exactly one row in ${table} where ${JSON.stringify(where)}, found ${found}`);
  }

  /** Tagged-template query: values become bind parameters. */
  sql<T extends Row = Row>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> {
    const text = strings.reduce((acc, s, i) => acc + `$${i}` + s);
    return this.query<T>(text, values);
  }

  async count(table: string, where: Where = {}): Promise<number> {
    const { clause, params } = whereClause(where);
    const [row] = await this.query<{ n: string }>(`SELECT count(*) AS n FROM ${ident(table)}${clause}`, params);
    return Number(row!.n);
  }

  /** Insert rows and return them as stored (with defaults and generated ids). */
  async insert<T extends Row = Row>(table: string, rows: Row | Row[]): Promise<T[]> {
    const list = Array.isArray(rows) ? rows : [rows];
    const out: T[] = [];
    for (const row of list) {
      const cols = Object.keys(row);
      const sql =
        cols.length === 0
          ? `INSERT INTO ${ident(table)} DEFAULT VALUES RETURNING *`
          : `INSERT INTO ${ident(table)} (${cols.map(ident).join(", ")}) VALUES (${cols
              .map((_, i) => `$${i + 1}`)
              .join(", ")}) RETURNING *`;
      out.push(...(await this.query<T>(sql, Object.values(row))));
    }
    return out;
  }

  /** Empty every data table without dropping the app's connections, then re-apply the seed. */
  async reset() {
    this.#tables ??= await this.#listTables();
    if (this.#tables.length > 0) {
      await this.#client.query(`TRUNCATE ${this.#tables.map((t) => t.quoted).join(", ")} RESTART IDENTITY CASCADE`);
    }
    this.#start = undefined;
    this.#checkpoint = undefined;
    if (this.#seed) {
      await this.#client.query(this.#seed);
      this.#start = await this.#snapshot();
    }
  }

  /**
   * What changed in the database since the scenario started (after the seed),
   * or since the last `checkpoint()`: inserted, updated and deleted rows per table.
   *
   * ```ts
   * await db.checkpoint();                 // ignore the rows the test arranged
   * await http.post("/polls", { ... });
   * expect(await db.changes()).toEqual({ polls: { inserted: [expect.objectContaining({ title: "x" })], updated: [], deleted: [] } });
   * ```
   */
  async changes(): Promise<Changes> {
    const base = this.#checkpoint === undefined || this.#checkpoint === "start" ? this.#start : this.#checkpoint;
    return diff(this.#tables ?? [], base, await this.#snapshot());
  }

  /** Make `changes()` report only what happens from now on. */
  async checkpoint() {
    this.#checkpoint = await this.#snapshot();
  }

  /** Changes since the scenario started, regardless of checkpoints. Used for failure output. */
  async changesSinceStart(): Promise<Changes> {
    return diff(this.#tables ?? [], this.#start, await this.#snapshot());
  }

  /** Every tracked table's rows, in one round trip. */
  async #snapshot(): Promise<Snapshot> {
    const tables = (this.#tables ??= await this.#listTables());
    const snap: Snapshot = new Map();
    if (tables.length === 0) return snap;
    const order = (t: Table) => (t.key.length ? ` ORDER BY ${t.key.map((c) => `"${c.replace(/"/g, `""`)}"`).join(", ")}` : "");
    const sql = tables.map((t) => `SELECT * FROM ${t.quoted}${order(t)}`).join(";\n");
    const res = (await this.#client.query(sql)) as unknown as pg.QueryResult<Row> | pg.QueryResult<Row>[];
    const results = Array.isArray(res) ? res : [res];
    tables.forEach((t, i) => snap.set(t.name, results[i]!.rows));
    return snap;
  }

  /**
   * Tables to empty: ordinary tables in the configured schemas, minus migration
   * bookkeeping, `keep` (bare or `schema.table`) and tables owned by extensions
   * such as PostGIS's `spatial_ref_sys`.
   */
  async #listTables(): Promise<Table[]> {
    const keep = [...MIGRATION_TABLES, ...this.opts.keep];
    const rows = await this.query<{ schema: string; name: string; key: string[] | null }>(
      `SELECT n.nspname AS schema, c.relname AS name,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM pg_index i
                 CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
                WHERE i.indrelid = c.oid AND i.indisprimary) AS key
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND NOT c.relispartition
          AND n.nspname = ANY($1)
          AND NOT (c.relname = ANY($2) OR n.nspname || '.' || c.relname = ANY($2))
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
             WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
        ORDER BY 1, 2`,
      [this.opts.schemas, keep],
    );
    return rows.map((r) => ({
      name: r.schema === "public" ? r.name : `${r.schema}.${r.name}`,
      quoted: `${ident(r.schema)}.${ident(r.name)}`,
      key: r.key ?? [],
    }));
  }

  async close() {
    await this.#client.end();
  }
}

function diff(tables: Table[], before: Snapshot | undefined, after: Snapshot): Changes {
  const out: Changes = {};
  for (const table of tables) {
    const a = before?.get(table.name) ?? [];
    const b = after.get(table.name) ?? [];
    const changes = table.key.length > 0 ? diffByKey(a, b, table.key) : diffAsBags(a, b);
    if (changes.inserted.length || changes.updated.length || changes.deleted.length) out[table.name] = changes;
  }
  return out;
}

function diffByKey(before: Row[], after: Row[], key: string[]): TableChanges {
  const keyOf = (r: Row) => serialize(key.map((k) => r[k]));
  const old = new Map(before.map((r) => [keyOf(r), r]));
  const changes: TableChanges = { inserted: [], updated: [], deleted: [] };
  for (const row of after) {
    const k = keyOf(row);
    const prev = old.get(k);
    old.delete(k);
    if (!prev) {
      changes.inserted.push(row);
      continue;
    }
    const changed = [...new Set([...Object.keys(prev), ...Object.keys(row)])].filter((c) => serialize(prev[c]) !== serialize(row[c]));
    if (changed.length) changes.updated.push({ key: Object.fromEntries(key.map((k) => [k, row[k]])), before: prev, after: row, changed });
  }
  changes.deleted.push(...old.values());
  return changes;
}

/** Without a primary key, rows are compared as a multiset: an update shows up as a delete plus an insert. */
function diffAsBags(before: Row[], after: Row[]): TableChanges {
  const left = new Map<string, Row[]>();
  for (const r of before) {
    const k = serialize(r);
    left.set(k, [...(left.get(k) ?? []), r]);
  }
  const inserted: Row[] = [];
  for (const r of after) {
    const same = left.get(serialize(r));
    if (same?.length) same.pop();
    else inserted.push(r);
  }
  return { inserted, updated: [], deleted: [...left.values()].flat() };
}

function serialize(v: unknown) {
  return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
}

/** Short summary of `changes()` for failure output. */
export function formatChanges(changes: Changes, maxRows = 3) {
  const lines: string[] = [];
  const show = (sign: string, rows: unknown[]) => {
    for (const r of rows.slice(0, maxRows)) lines.push(`    ${sign} ${truncate(serialize(r))}`);
    if (rows.length > maxRows) lines.push(`    ${sign} …and ${rows.length - maxRows} more`);
  };
  for (const [table, c] of Object.entries(changes)) {
    const counts = [
      c.inserted.length && `${c.inserted.length} inserted`,
      c.updated.length && `${c.updated.length} updated`,
      c.deleted.length && `${c.deleted.length} deleted`,
    ].filter(Boolean);
    lines.push(`  ${table}: ${counts.join(", ")}`);
    show("+", c.inserted);
    for (const u of c.updated.slice(0, maxRows)) {
      const key = Object.entries(u.key).map(([k, v]) => `${k}=${serialize(v)}`).join(" ");
      const cols = u.changed.map((col) => `${col}: ${serialize(u.before[col])} → ${serialize(u.after[col])}`).join(", ");
      lines.push(`    ~ ${key}  ${truncate(cols)}`);
    }
    if (c.updated.length > maxRows) lines.push(`    ~ …and ${c.updated.length - maxRows} more`);
    show("-", c.deleted);
  }
  return lines.join("\n");
}

function truncate(s: string, max = 200) {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function whereClause(where: Where) {
  const conds: string[] = [];
  const params: unknown[] = [];
  for (const [col, value] of Object.entries(where)) {
    if (value === null || value === undefined) {
      conds.push(`${ident(col)} IS NULL`);
    } else if (Array.isArray(value)) {
      params.push(value);
      conds.push(`${ident(col)} = ANY($${params.length})`);
    } else {
      params.push(value);
      conds.push(`${ident(col)} = $${params.length}`);
    }
  }
  return { clause: conds.length ? ` WHERE ${conds.join(" AND ")}` : "", params };
}

/** Quote an identifier; `schema.table` is split on the dot. */
function ident(name: string) {
  return name
    .split(".")
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(".");
}
