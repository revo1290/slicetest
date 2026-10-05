/**
 * What `Db` needs from a database engine. Everything dialect-specific
 * (quoting, placeholders, catalog queries, how to empty tables) lives behind
 * this interface so the rest of slicetest stays engine-agnostic.
 */

export interface Row {
  [column: string]: unknown;
}

export interface Table {
  /** Display name: `name` in the default schema, else `schema.name`. */
  name: string;
  quoted: string;
  /** Primary-key columns, in order; empty when there is none. */
  key: string[];
}

export interface Column {
  name: string;
  /** The declared type as the engine reports it, e.g. `character varying(20)`, `int`, `TEXT`. */
  type: string;
  nullable: boolean;
  /** Has a default, is generated, an identity or auto-increment column: inserts may leave it out. */
  hasDefault: boolean;
  maxLength?: number;
  /** Labels of an enum type. */
  values?: string[];
}

export interface ForeignKey {
  columns: string[];
  /** Referenced table, named like `Table.name`. */
  table: string;
  /** Referenced columns; empty means the referenced table's primary key (SQLite). */
  references: string[];
}

/** What `db.make()` needs to build a valid row. */
export interface TableShape {
  columns: Column[];
  foreignKeys: ForeignKey[];
  /** Bodies of CHECK constraints, as the engine prints them. */
  checks: string[];
}

export interface Driver {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Several parameterless SELECTs in one round trip. */
  queryAll(sqls: string[]): Promise<Row[][]>;
  /** Run a script of several statements, e.g. a seed file. */
  exec(script: string): Promise<void>;
  /** Quote an identifier; `schema.table` is split on the dot. */
  ident(name: string): string;
  /** Quote a single column name, dots and all. */
  column(name: string): string;
  /** Bind placeholder for the n-th (1-based) parameter. */
  param(n: number): string;
  /** A `column IN (...)` condition for `values`, appending its parameters to `params`. */
  inList(column: string, values: unknown[], params: unknown[]): string;
  /** Data tables to reset, minus `keep` (bare or `schema.table`) and engine-owned tables. */
  listTables(schemas: string[], keep: string[]): Promise<Table[]>;
  /** Empty `tables` and restart their id sequences, without dropping the app's connections. */
  truncate(tables: Table[]): Promise<void>;
  /** Insert one row and return it as stored (defaults and generated ids filled in). */
  insert(table: string, row: Row): Promise<Row[]>;
  /**
   * Move `table`'s id sequences past the ids it holds, after rows were inserted with explicit ids.
   * Only Postgres needs it: MySQL's AUTO_INCREMENT and SQLite's rowid follow the largest id themselves.
   */
  syncSequences?(table: string): Promise<void>;
  /** Columns, foreign keys and checks of `table`. Throws when there is no such table. */
  describe(table: string): Promise<TableShape>;
  close(): Promise<void>;
}

/** Server-level operations: the databases slicetest creates for templates and workers. */
export interface Admin {
  /** Names of databases starting with `prefix`. */
  databases(prefix: string): Promise<string[]>;
  create(name: string): Promise<void>;
  /** Create `name` as a copy of `template` (schema and data). */
  clone(template: string, name: string): Promise<void>;
  /** Drop `name`, disconnecting anyone still using it. */
  drop(name: string): Promise<void>;
  /** Run `fn` while holding a server-wide lock, so concurrent runs build a shared template once. */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Connection URL for database `name` on this server. */
  urlFor(name: string): string;
  close(): Promise<void>;
}

export interface Engine {
  name: string;
  /** Container image used when no `db.url` is given. */
  defaultImage: string;
  /** Runs in-process (SQLite): no container runtime needed. */
  local?: boolean;
  startContainer(image: string, reuse: boolean): Promise<{ url: string; stop(): Promise<unknown> }>;
  admin(url: string): Promise<Admin>;
  driver(url: string): Promise<Driver>;
  /** The URL to hand Atlas for database `url`. */
  atlasUrl(url: string): string;
}
