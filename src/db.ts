import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Driver, Row, Table } from "./drivers/driver.js";
import { Factory } from "./factory.js";
import type { QueryList, QueryLog } from "./query-log.js";

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


export type { Row } from "./drivers/driver.js";

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

export interface ChangesOptions {
  /** Columns or tables to leave out: `updated_at` (in every table), `orders.synced_at`, `sessions.*`. Added to `db.ignoreChanges`. */
  ignore?: string[];
}

/** Changed tables only, keyed by table name (`schema.table` outside `public`). */
export type Changes = Record<string, TableChanges>;


type Snapshot = Map<string, Row[]>;

/** Test-side handle to the database the app under test is using. */
export class Db {
  #driver: Driver;
  #tables?: Table[];
  /** SQL scripts, or rows per table from a YAML / JSON file. */
  #seeds: (string | [table: string, rows: Row[]][])[] = [];
  /** Contents right after the reset (and seed); undefined means every table was empty. */
  #start?: Snapshot;
  #checkpoint?: Snapshot | "start";
  #factory: Factory;
  #queryLog?: QueryLog;

  private constructor(
    driver: Driver,
    readonly url: string,
    private readonly opts: { schemas: string[]; keep: string[]; ignoreChanges?: string[] },
  ) {
    this.#driver = driver;
    this.#factory = new Factory(
      (table) => driver.describe(table),
      (table, row) => this.#insertRow(table, row),
    );
  }

  static async connect(driver: Driver, url: string, opts: { schemas: string[]; keep: string[]; ignoreChanges?: string[]; seedFiles?: string[] }) {
    const db = new Db(driver, url, opts);
    db.#seeds = await Promise.all((opts.seedFiles ?? []).map(async (file) => {
      const text = await readFile(file, "utf8");
      return /\.(ya?ml|json)$/i.test(file) ? seedRows(file, text) : text;
    }));
    return db;
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.#driver.query<T>(sql, params);
  }

  /** Rows of a table, optionally filtered, ordered by the first column unless `orderBy` is given. */
  async rows<T extends Row = Row>(table: string, where: Where = {}, opts: RowsOptions = {}): Promise<T[]> {
    const { clause, params } = this.#where(where);
    const ident = (c: string) => this.#driver.ident(c);
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
    const text = strings.reduce((acc, s, i) => acc + this.#driver.param(i) + s);
    return this.query<T>(text, values);
  }

  async count(table: string, where: Where = {}): Promise<number> {
    const { clause, params } = this.#where(where);
    const [row] = await this.query<{ n: string }>(`SELECT count(*) AS n FROM ${this.#driver.ident(table)}${clause}`, params);
    return Number(row!.n);
  }

  /** Insert rows and return them as stored (with defaults and generated ids). */
  async insert<T extends Row = Row>(table: string, rows: Row | Row[]): Promise<T[]> {
    const list = Array.isArray(rows) ? rows : [rows];
    const out: T[] = [];
    for (const row of list) out.push(...((await this.#insertRow(table, row)) as T[]));
    return out;
  }

  /** An explicit id would otherwise be handed out again by the sequence: the app's next insert would collide. */
  async #insertRow(table: string, row: Row) {
    const stored = await this.#driver.insert(table, row);
    await this.#driver.syncSequences?.(table, Object.keys(row));
    return stored;
  }

  /**
   * Insert a row that satisfies the schema, giving only the columns the test cares about.
   * Required columns get a value of their type (enums and `CHECK (... IN (...))` their first
   * allowed value) and required foreign keys a parent row made the same way.
   *
   * ```ts
   * const order = await db.make("orders", { status: "paid" }); // also creates the customer it needs
   * ```
   */
  async make<T extends Row = Row>(table: string, overrides: Row = {}): Promise<T> {
    return (await this.#factory.make(table, overrides)) as T;
  }

  /** `count` rows made like `make()`; `overrides` may depend on the index. */
  async makeMany<T extends Row = Row>(table: string, count: number, overrides: Row | ((i: number) => Row) = {}): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < count; i++) out.push(await this.make<T>(table, typeof overrides === "function" ? overrides(i) : overrides));
    return out;
  }

  /** @internal Set by the runtime when `db.queries` is on. */
  attachQueryLog(log: QueryLog) {
    this.#queryLog = log;
  }

  /**
   * SQL the app ran during this scenario, or only while `fn` ran. Needs `db: { queries: true }`.
   * The test's own `db` calls aren't included.
   *
   * ```ts
   * const queries = await db.queries(() => http.get("/posts"));
   * expect(queries.repeated()).toEqual([]);   // no statement shape ran 3+ times: no N+1
   * expect(queries.length).toBeLessThanOrEqual(3);
   * ```
   */
  async queries(fn?: () => unknown): Promise<QueryList> {
    const log = this.#queryLog;
    if (!log) throw new Error("slicetest: db.queries() needs `db: { queries: true }` in the config (Postgres or MySQL); the app then connects through a proxy that records its SQL.");
    if (!fn) return log.queries();
    const mark = log.mark();
    await fn();
    // Let statements already on the wire arrive.
    await new Promise((r) => setTimeout(r, 10));
    return log.queries(mark);
  }

  /** Empty every data table without dropping the app's connections, then re-apply the seed. */
  async reset() {
    // Listed again each time: a table the app or a scenario created since the last reset must be emptied too.
    this.#tables = await this.#listTables();
    await this.#driver.truncate(this.#tables);
    this.#factory.reset();
    this.#start = undefined;
    this.#checkpoint = undefined;
    if (this.#seeds.length) {
      for (const seed of this.#seeds) {
        if (typeof seed === "string") await this.#driver.exec(seed);
        else {
          for (const [table, rows] of seed) for (const row of rows) await this.#insertRow(table, row);
        }
      }
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
  async changes(opts: ChangesOptions = {}): Promise<Changes> {
    const base = this.#checkpoint === undefined || this.#checkpoint === "start" ? this.#start : this.#checkpoint;
    return diff(this.#tables ?? [], base, await this.#snapshot(), [...(this.opts.ignoreChanges ?? []), ...(opts.ignore ?? [])]);
  }

  /** Make `changes()` report only what happens from now on. */
  async checkpoint() {
    this.#checkpoint = await this.#snapshot();
  }

  /** Changes since the scenario started, regardless of checkpoints. Used for failure output. */
  async changesSinceStart(): Promise<Changes> {
    return diff(this.#tables ?? [], this.#start, await this.#snapshot(), this.opts.ignoreChanges ?? []);
  }

  /** Every tracked table's rows, in one round trip. */
  async #snapshot(): Promise<Snapshot> {
    const tables = (this.#tables ??= await this.#listTables());
    const snap: Snapshot = new Map();
    const order = (t: Table) => (t.key.length ? ` ORDER BY ${t.key.map((c) => this.#driver.column(c)).join(", ")}` : "");
    const results = await this.#driver.queryAll(tables.map((t) => `SELECT * FROM ${t.quoted}${order(t)}`));
    tables.forEach((t, i) => snap.set(t.name, results[i]!));
    return snap;
  }

  /**
   * Tables to empty: ordinary tables in the configured schemas, minus migration
   * bookkeeping, `keep` (bare or `schema.table`) and tables owned by extensions
   * such as PostGIS's `spatial_ref_sys`.
   */
  async #listTables(): Promise<Table[]> {
    return this.#driver.listTables(this.opts.schemas, [...MIGRATION_TABLES, ...this.opts.keep]);
  }

  /** `WHERE ...` for a filter: `null` is IS NULL, an array is IN (...), anything else `=`. */
  #where(where: Where) {
    const d = this.#driver;
    const conds: string[] = [];
    const params: unknown[] = [];
    for (const [col, value] of Object.entries(where)) {
      if (value === null || value === undefined) conds.push(`${d.ident(col)} IS NULL`);
      else if (Array.isArray(value)) conds.push(d.inList(col, value, params));
      else {
        params.push(value);
        conds.push(`${d.ident(col)} = ${d.param(params.length)}`);
      }
    }
    return { clause: conds.length ? ` WHERE ${conds.join(" AND ")}` : "", params };
  }

  async close() {
    await this.#driver.close();
  }
}

/** A data seed file: `table: [rows]`, in file order; each row a mapping of columns. */
function seedRows(file: string, text: string): [string, Row[]][] {
  let doc: unknown;
  try {
    doc = path.extname(file).toLowerCase() === ".json" ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new Error(`slicetest: seed ${file}: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`slicetest: seed ${file} must map tables to rows, e.g. plans: [{ id: 1, name: free }]`);
  return Object.entries(doc).map(([table, rows]) => {
    if (!Array.isArray(rows) || !rows.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
      throw new Error(`slicetest: seed ${file}: "${table}" must be a list of rows, e.g. ${table}: [{ id: 1, name: free }]`);
    }
    return [table, rows as Row[]];
  });
}

/**
 * What `ignore` leaves out of one table: `"*"` for the whole table, else the columns.
 * `updated_at` is that column in every table, `orders.synced_at` in one, `sessions.*` the whole table
 * (the last segment is the column, so `billing.invoices.*` works for other schemas).
 */
export function ignored(ignore: readonly string[], table: string): "*" | Set<string> {
  const columns = new Set<string>();
  for (const entry of ignore) {
    const dot = entry.lastIndexOf(".");
    if (dot === -1) {
      columns.add(entry);
      continue;
    }
    const t = entry.slice(0, dot);
    if (t !== table && !(t === table.split(".").pop() && !t.includes("."))) continue;
    const column = entry.slice(dot + 1);
    if (column === "*") return "*";
    columns.add(column);
  }
  return columns;
}

function diff(tables: Table[], before: Snapshot | undefined, after: Snapshot, ignore: readonly string[] = []): Changes {
  const out: Changes = {};
  for (const table of tables) {
    const skip = ignored(ignore, table.name);
    if (skip === "*") continue;
    const strip = (rows: Row[]) => (skip.size ? rows.map((r) => Object.fromEntries(Object.entries(r).filter(([c]) => !skip.has(c)))) : rows);
    const a = strip(before?.get(table.name) ?? []);
    const b = strip(after.get(table.name) ?? []);
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



/** The `db` of an app without a database (`db: false`): resetting is a no-op, anything else explains. */
export function noDatabase(): Db {
  const off = () => {
    throw new Error("slicetest: the app has no database (db: false), so db.* isn't available. Configure `db` to use it.");
  };
  return new Proxy({} as Db, {
    get(_, prop) {
      if (prop === "reset" || prop === "close") return async () => {};
      if (prop === "changesSinceStart") return async () => ({});
      if (prop === "then") return undefined;
      // The real methods are async, so this rejects like they would.
      return async () => off();
    },
  });
}
