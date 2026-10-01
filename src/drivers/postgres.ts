import pg from "pg";
import type { Admin, Driver, Engine, Row, Table, TableShape } from "./driver.js";

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

export class PostgresDriver implements Driver {
  private constructor(private readonly client: pg.Client) {}

  static async connect(url: string) {
    const client = new pg.Client({ connectionString: url, types });
    // Without a listener, a dropped connection would crash the worker; the next query reports it instead.
    client.on("error", () => {});
    await client.connect();
    return new PostgresDriver(client);
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.client.query<T>(sql, params)).rows;
  }

  async queryAll(sqls: string[]): Promise<Row[][]> {
    if (sqls.length === 0) return [];
    // The simple query protocol runs several statements in one round trip.
    const res = (await this.client.query(sqls.join(";\n"))) as unknown as pg.QueryResult<Row> | pg.QueryResult<Row>[];
    return (Array.isArray(res) ? res : [res]).map((r) => r.rows);
  }

  async exec(script: string) {
    await this.client.query(script);
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
    return `$${n}`;
  }

  inList(column: string, values: unknown[], params: unknown[]) {
    params.push(values);
    return `${this.ident(column)} = ANY($${params.length})`;
  }

  /** Ordinary and partitioned tables, skipping partitions and tables owned by extensions (e.g. PostGIS's `spatial_ref_sys`). */
  async listTables(schemas: string[], keep: string[]): Promise<Table[]> {
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
      [schemas, keep],
    );
    return rows.map((r) => ({
      name: r.schema === "public" ? r.name : `${r.schema}.${r.name}`,
      quoted: `${this.ident(r.schema)}.${this.ident(r.name)}`,
      key: r.key ?? [],
    }));
  }

  async truncate(tables: Table[]) {
    if (tables.length > 0) await this.client.query(`TRUNCATE ${tables.map((t) => t.quoted).join(", ")} RESTART IDENTITY CASCADE`);
  }

  async insert(table: string, row: Row) {
    const cols = Object.keys(row);
    const sql =
      cols.length === 0
        ? `INSERT INTO ${this.ident(table)} DEFAULT VALUES RETURNING *`
        : `INSERT INTO ${this.ident(table)} (${cols.map((c) => this.ident(c)).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`;
    return this.query(sql, Object.values(row));
  }

  async describe(table: string): Promise<TableShape> {
    const [{ oid } = { oid: null }] = await this.query<{ oid: number | null }>("SELECT to_regclass($1)::oid AS oid", [this.ident(table)]);
    if (oid === null) throw new Error(`slicetest: there is no table "${table}"`);
    const columns = await this.query<{ name: string; type: string; nullable: boolean; has_default: boolean; max: number | null; values: string[] | null }>(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
              (a.atthasdef OR a.attidentity <> '' OR a.attgenerated <> '') AS has_default,
              information_schema._pg_char_max_length(a.atttypid, a.atttypmod) AS max,
              (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = a.atttypid) AS values
         FROM pg_attribute a
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [oid],
    );
    const keys = await this.query<{ columns: string[]; schema: string; table: string; references: string[] }>(
      `SELECT (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) AS columns,
              n.nspname AS schema, r.relname AS table,
              (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n, ord)
                JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n) AS references
         FROM pg_constraint c
         JOIN pg_class r ON r.oid = c.confrelid
         JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE c.contype = 'f' AND c.conrelid = $1
        ORDER BY c.conname`,
      [oid],
    );
    const checks = await this.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'c' AND conrelid = $1", [oid]);
    return {
      columns: columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, hasDefault: c.has_default, maxLength: c.max ?? undefined, values: c.values ?? undefined })),
      foreignKeys: keys.map((k) => ({ columns: k.columns, table: k.schema === "public" ? k.table : `${k.schema}.${k.table}`, references: k.references })),
      checks: checks.map((c) => c.def),
    };
  }

  async close() {
    await this.client.end();
  }
}

function withDatabase(url: string, database: string) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

function quote(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

class PostgresAdmin implements Admin {
  constructor(
    private readonly client: pg.Client,
    private readonly url: string,
  ) {}

  async databases(prefix: string) {
    const { rows } = await this.client.query<{ datname: string }>("SELECT datname FROM pg_database WHERE starts_with(datname, $1)", [prefix]);
    return rows.map((r) => r.datname);
  }

  async create(name: string) {
    await this.client.query(`CREATE DATABASE ${quote(name)}`);
  }

  async clone(template: string, name: string) {
    await this.client.query(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(template)}`);
  }

  async drop(name: string) {
    await this.client.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
  }

  async withLock<T>(key: string, fn: () => Promise<T>) {
    await this.client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
    try {
      return await fn();
    } finally {
      await this.client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
    }
  }

  urlFor(name: string) {
    return withDatabase(this.url, name);
  }

  async close() {
    await this.client.end();
  }
}

export const postgres: Engine = {
  name: "postgres",
  defaultImage: "postgres:17-alpine",
  async startContainer(image, reuse) {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const definition = new PostgreSqlContainer(image);
    // A reused container is left running and found again by its configuration on the next run.
    if (reuse) definition.withReuse();
    const container = await definition.start();
    return { url: container.getConnectionUri(), stop: () => container.stop() };
  },
  async admin(url) {
    const client = new pg.Client({ connectionString: url });
    client.on("error", () => {});
    await client.connect();
    return new PostgresAdmin(client, url);
  },
  driver: (url) => PostgresDriver.connect(url),
  atlasUrl(url) {
    const u = new URL(url);
    if (!u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "disable");
    return u.toString();
  },
};
