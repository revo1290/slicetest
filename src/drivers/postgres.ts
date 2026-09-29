import pg from "pg";
import type { Driver, Row, Table } from "./driver.js";

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

  async close() {
    await this.client.end();
  }
}
