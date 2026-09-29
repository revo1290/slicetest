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
  close(): Promise<void>;
}
