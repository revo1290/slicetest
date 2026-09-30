import type { Connection, FieldPacket, ResultSetHeader, TypeCastField } from "mysql2/promise";
import mysql from "mysql2/promise";
import type { Admin, Driver, Engine, Row, Table } from "./driver.js";

/**
 * Makes rows look like the Postgres driver's, so the same scenarios pass on
 * both: BOOLEAN (`TINYINT(1)`) columns come back as booleans, BIGINT ids as
 * numbers when they fit, DATETIME as UTC.
 */
const options = {
  supportBigNumbers: true,
  bigNumberStrings: false,
  timezone: "Z",
  multipleStatements: true,
  typeCast(field: TypeCastField, next: () => unknown) {
    if (field.type === "TINY" && field.length === 1) {
      const v = field.string();
      return v === null ? null : v === "1";
    }
    return next();
  },
};

async function connect(url: string) {
  const conn = await mysql.createConnection({ uri: url, ...options });
  // Without a listener, a dropped connection would crash the worker; the next query reports it instead.
  conn.on("error", () => {});
  return conn;
}

function rowsOf(result: unknown): Row[] {
  return Array.isArray(result) ? (result as Row[]) : [];
}

export class MysqlDriver implements Driver {
  #keys = new Map<string, string[]>();

  private constructor(private readonly conn: Connection) {}

  static async connect(url: string) {
    return new MysqlDriver(await connect(url));
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.conn.query(sql, params);
    return rowsOf(rows) as T[];
  }

  async queryAll(sqls: string[]): Promise<Row[][]> {
    if (sqls.length === 0) return [];
    // With multipleStatements, several SELECTs come back as one array of result sets.
    const [results] = await this.conn.query(sqls.join(";\n"));
    return sqls.length === 1 ? [rowsOf(results)] : (results as unknown[]).map(rowsOf);
  }

  async exec(script: string) {
    await this.conn.query(script);
  }

  ident(name: string) {
    return name
      .split(".")
      .map((part) => this.column(part))
      .join(".");
  }

  column(name: string) {
    return `\`${name.replace(/`/g, "``")}\``;
  }

  param(_n: number) {
    return "?";
  }

  inList(column: string, values: unknown[], params: unknown[]) {
    if (values.length === 0) return "FALSE";
    params.push(...values);
    return `${this.ident(column)} IN (${values.map(() => "?").join(", ")})`;
  }

  /**
   * Base tables in the configured schemas. In MySQL a schema is a database;
   * `public` (the default) stands for the database the URL points at.
   */
  async listTables(schemas: string[], keep: string[]): Promise<Table[]> {
    const [{ current }] = (await this.query<{ current: string }>("SELECT DATABASE() AS current")) as [{ current: string }];
    const names = schemas.map((s) => (s === "public" ? current : s));
    const rows = await this.query<{ schema: string; name: string; key: string | null }>(
      `SELECT t.TABLE_SCHEMA AS \`schema\`, t.TABLE_NAME AS name,
              (SELECT GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR '\\n')
                 FROM information_schema.KEY_COLUMN_USAGE k
                WHERE k.TABLE_SCHEMA = t.TABLE_SCHEMA AND k.TABLE_NAME = t.TABLE_NAME AND k.CONSTRAINT_NAME = 'PRIMARY') AS \`key\`
         FROM information_schema.TABLES t
        WHERE t.TABLE_TYPE = 'BASE TABLE' AND t.TABLE_SCHEMA IN (?)
        ORDER BY 1, 2`,
      [names],
    );
    return rows
      .map((r) => ({
        name: r.schema === current ? r.name : `${r.schema}.${r.name}`,
        quoted: `${this.ident(r.schema)}.${this.ident(r.name)}`,
        key: r.key ? r.key.split("\n") : [],
        bare: r.name,
      }))
      .filter((t) => !keep.includes(t.bare) && !keep.includes(t.name))
      .map(({ bare: _, ...t }) => t);
  }

  /**
   * TRUNCATE also restarts AUTO_INCREMENT, but it is DDL and costs a few
   * milliseconds per table, so only tables that have rows or a used counter are
   * truncated. Foreign key checks are off for this session only.
   */
  async truncate(tables: Table[]) {
    if (tables.length === 0) return;
    const [, , counters, ...filled] = await this.queryAll([
      // Otherwise information_schema serves AUTO_INCREMENT from a cache that can be a day old.
      "SET SESSION information_schema_stats_expiry = 0",
      "SELECT 1",
      `SELECT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME) AS t, AUTO_INCREMENT AS n FROM information_schema.TABLES WHERE AUTO_INCREMENT > 1`,
      ...tables.map((t) => `SELECT 1 AS x FROM ${t.quoted} LIMIT 1`),
    ]);
    const used = new Set(counters!.map((r) => this.ident(String(r.t))));
    const dirty = tables.filter((t, i) => filled[i]!.length > 0 || used.has(t.quoted));
    if (dirty.length === 0) return;
    await this.conn.query(`SET FOREIGN_KEY_CHECKS = 0; ${dirty.map((t) => `TRUNCATE TABLE ${t.quoted}`).join("; ")}; SET FOREIGN_KEY_CHECKS = 1`);
  }

  /** MySQL has no RETURNING: insert, then read the row back by its primary key. */
  async insert(table: string, row: Row) {
    const cols = Object.keys(row);
    const sql =
      cols.length === 0
        ? `INSERT INTO ${this.ident(table)} () VALUES ()`
        : `INSERT INTO ${this.ident(table)} (${cols.map((c) => this.column(c)).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    const [res] = (await this.conn.query(sql, Object.values(row))) as [ResultSetHeader, FieldPacket[]];
    const key = await this.#primaryKey(table);
    const where: Row = {};
    for (const k of key) {
      if (k in row) where[k] = row[k];
      else if (key.length === 1 && res.insertId) where[k] = res.insertId;
      else return [row];
    }
    if (key.length === 0) return [row];
    const conds = Object.keys(where).map((k) => `${this.column(k)} = ?`);
    return this.query(`SELECT * FROM ${this.ident(table)} WHERE ${conds.join(" AND ")}`, Object.values(where));
  }

  async #primaryKey(table: string) {
    let key = this.#keys.get(table);
    if (!key) {
      const [schema, name] = table.includes(".") ? table.split(".", 2) : [null, table];
      const rows = await this.query<{ c: string }>(
        `SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
          ORDER BY ORDINAL_POSITION`,
        [schema, name],
      );
      key = rows.map((r) => r.c);
      this.#keys.set(table, key);
    }
    return key;
  }

  async close() {
    await this.conn.end();
  }
}

function withDatabase(url: string, database: string) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

function quote(name: string) {
  return `\`${name.replace(/`/g, "``")}\``;
}

class MysqlAdmin implements Admin {
  constructor(
    private readonly conn: Connection,
    private readonly url: string,
  ) {}

  async databases(prefix: string) {
    const [rows] = await this.conn.query("SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA");
    return rowsOf(rows)
      .map((r) => String(r.name))
      .filter((n) => n.startsWith(prefix));
  }

  async create(name: string) {
    await this.conn.query(`CREATE DATABASE ${quote(name)}`);
  }

  /**
   * MySQL has no template databases: recreate each table from `SHOW CREATE
   * TABLE` (foreign keys included) and copy its rows, then views and triggers.
   * Stored routines and events are not copied.
   */
  async clone(template: string, name: string) {
    await this.create(name);
    const target = await connect(withDatabase(this.url, name));
    try {
      await target.query("SET FOREIGN_KEY_CHECKS = 0");
      const [tables] = await this.conn.query(
        "SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
        [template],
      );
      const list = rowsOf(tables) as { name: string; type: string }[];
      for (const t of list.filter((t) => t.type === "BASE TABLE")) {
        const [[create]] = (await this.conn.query(`SHOW CREATE TABLE ${quote(template)}.${quote(t.name)}`)) as [Row[], unknown];
        await target.query(String(create!["Create Table"]));
        const [cols] = await this.conn.query(
          "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND EXTRA NOT LIKE '%GENERATED%' ORDER BY ORDINAL_POSITION",
          [template, t.name],
        );
        const names = rowsOf(cols).map((c) => quote(String(c.c))).join(", ");
        await target.query(`INSERT INTO ${quote(t.name)} (${names}) SELECT ${names} FROM ${quote(template)}.${quote(t.name)}`);
      }
      // Views may depend on each other; retry the ones that fail until no progress is made.
      let views = list.filter((t) => t.type === "VIEW");
      while (views.length > 0) {
        const failed: typeof views = [];
        let lastError: unknown;
        for (const v of views) {
          const [[create]] = (await this.conn.query(`SHOW CREATE VIEW ${quote(template)}.${quote(v.name)}`)) as [Row[], unknown];
          const sql = String(create!["Create View"]).split(`${quote(template)}.`).join("");
          await target.query(sql).catch((e) => {
            failed.push(v);
            lastError = e;
          });
        }
        if (failed.length === views.length) throw lastError;
        views = failed;
      }
      const [triggers] = await this.conn.query(`SHOW TRIGGERS FROM ${quote(template)}`);
      for (const trg of rowsOf(triggers)) {
        const [[create]] = (await this.conn.query(`SHOW CREATE TRIGGER ${quote(template)}.${quote(String(trg.Trigger))}`)) as [Row[], unknown];
        await target.query(String(create!["SQL Original Statement"]));
      }
    } catch (e) {
      await this.drop(name).catch(() => {});
      throw e;
    } finally {
      await target.end().catch(() => {});
    }
  }

  /** DROP DATABASE waits for open transactions, so disconnect everyone using it first. */
  async drop(name: string) {
    const [rows] = await this.conn.query("SELECT ID AS id FROM information_schema.PROCESSLIST WHERE DB = ? AND ID <> CONNECTION_ID()", [name]);
    for (const r of rowsOf(rows)) await this.conn.query(`KILL ${Number(r.id)}`).catch(() => {});
    await this.conn.query(`DROP DATABASE IF EXISTS ${quote(name)}`);
  }

  async withLock<T>(key: string, fn: () => Promise<T>) {
    const lock = key.slice(0, 64);
    await this.conn.query("SELECT GET_LOCK(?, -1)", [lock]);
    try {
      return await fn();
    } finally {
      await this.conn.query("SELECT RELEASE_LOCK(?)", [lock]);
    }
  }

  urlFor(name: string) {
    return withDatabase(this.url, name);
  }

  async close() {
    await this.conn.end();
  }
}

export const mysqlEngine: Engine = {
  name: "mysql",
  defaultImage: "mysql:8.4",
  async startContainer(image, reuse) {
    const { MySqlContainer } = await import("@testcontainers/mysql").catch(() => {
      throw new Error("slicetest: starting a MySQL container needs the @testcontainers/mysql package: npm i -D @testcontainers/mysql (or set db.url)");
    });
    const definition = new MySqlContainer(image);
    if (reuse) definition.withReuse();
    const container = await definition.start();
    // Root, because slicetest creates and drops databases.
    return { url: container.getConnectionUri(true), stop: () => container.stop() };
  },
  async admin(url) {
    return new MysqlAdmin(await connect(url), url);
  },
  driver: (url) => MysqlDriver.connect(url),
  atlasUrl: (url) => url,
};
