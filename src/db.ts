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

/** Test-side handle to the database the app under test is using. */
export class Db {
  #client: pg.Client;
  #tables?: string[];
  #seed?: string;

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
      await this.#client.query(`TRUNCATE ${this.#tables.join(", ")} RESTART IDENTITY CASCADE`);
    }
    if (this.#seed) await this.#client.query(this.#seed);
  }

  /**
   * Tables to empty: ordinary tables in the configured schemas, minus migration
   * bookkeeping, `keep` (bare or `schema.table`) and tables owned by extensions
   * such as PostGIS's `spatial_ref_sys`.
   */
  async #listTables() {
    const keep = [...MIGRATION_TABLES, ...this.opts.keep];
    const rows = await this.query<{ schema: string; name: string }>(
      `SELECT n.nspname AS schema, c.relname AS name
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
    return rows.map((r) => `${ident(r.schema)}.${ident(r.name)}`);
  }

  async close() {
    await this.#client.end();
  }
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
