import type { Column, Row, TableShape } from "./drivers/driver.js";

/**
 * `db.make()`: rows that satisfy the schema without spelling it out. Required
 * columns the caller doesn't give get a value of their type, enum and
 * `CHECK (col IN (...))` columns their first allowed value, and required
 * foreign keys a parent row made the same way. Values are numbered per
 * scenario, so they are unique and the same on every run.
 */
export class Factory {
  #n = 0;
  #shapes = new Map<string, Promise<TableShape>>();

  constructor(
    private readonly describe: (table: string) => Promise<TableShape>,
    private readonly insert: (table: string, row: Row) => Promise<Row[]>,
  ) {}

  /** Restart numbering; called when the database is reset. */
  reset() {
    this.#n = 0;
  }

  async make(table: string, overrides: Row = {}, path: string[] = []): Promise<Row> {
    const shape = await this.#shape(table);
    for (const col of Object.keys(overrides)) {
      if (!shape.columns.some((c) => c.name === col)) {
        throw new Error(`slicetest: db.make("${table}"): there is no column "${col}" (columns: ${shape.columns.map((c) => c.name).join(", ")})`);
      }
    }
    const n = ++this.#n;
    const row: Row = { ...overrides };
    const byName = new Map(shape.columns.map((c) => [c.name, c]));
    const needed = (name: string) => {
      const c = byName.get(name);
      return !!c && !c.nullable && !c.hasDefault && !(name in row);
    };

    for (const fk of shape.foreignKeys) {
      // Only fill keys that must be set and that the caller left entirely to us.
      if (!fk.columns.some(needed) || fk.columns.some((c) => c in overrides)) continue;
      if (fk.table === table || path.includes(fk.table)) {
        const chain = [...path, table, fk.table].join(" → ");
        throw new Error(`slicetest: db.make("${table}") can't create a parent for ${fk.columns.join(", ")}: the foreign keys form a cycle (${chain}). Pass ${fk.columns.join(", ")} yourself.`);
      }
      const parent = await this.make(fk.table, {}, [...path, table]);
      const refs = fk.references.length ? fk.references : (await this.#primaryKey(fk.table, parent));
      fk.columns.forEach((c, i) => (row[c] = parent[refs[i]!]));
    }

    for (const c of shape.columns) {
      if (needed(c.name)) row[c.name] = valueFor(table, c, n, allowedValues(c.name, shape.checks));
    }

    try {
      const [stored] = await this.insert(table, row);
      return stored ?? row;
    } catch (e) {
      const generated = Object.fromEntries(Object.entries(row).filter(([k]) => !(k in overrides)));
      throw new Error(
        `slicetest: db.make("${table}") failed: ${(e as Error).message}\n` +
          `  generated: ${JSON.stringify(generated)}\n` +
          `  pass the columns that need specific values, e.g. db.make("${table}", { ${Object.keys(generated)[0] ?? "column"}: ... })`,
        { cause: e },
      );
    }
  }

  #shape(table: string) {
    let shape = this.#shapes.get(table);
    if (!shape) {
      shape = this.describe(table);
      this.#shapes.set(table, shape);
      shape.catch(() => this.#shapes.delete(table));
    }
    return shape;
  }

  /** SQLite foreign keys may omit the referenced columns: they mean the parent's primary key, or its rowid. */
  async #primaryKey(table: string, parent: Row) {
    const shape = await this.#shape(table);
    const key = shape.columns.filter((c) => c.hasDefault && /^integer$/i.test(c.type)).map((c) => c.name);
    return key.length ? key : Object.keys(parent).slice(0, 1);
  }
}

/** String literals allowed by a CHECK on `column` such as `status IN ('open', 'closed')` or `status = ANY (ARRAY[...])`. */
export function allowedValues(column: string, checks: string[]): string[] | undefined {
  const esc = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mention = new RegExp(`(^|[^\\w])[\`"]?${esc}[\`"]?\\)?(::\\w+(\\s\\w+)?)?\\s*(in\\s*\\(|=\\s*any\\s*\\()`, "i");
  for (const check of checks) {
    if (!mention.test(check)) continue;
    const literals = [...check.matchAll(/(?:_\w+)?'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
    if (literals.length) return literals;
  }
  return undefined;
}

const EPOCH = Date.UTC(2026, 0, 1);

/** A value of `column`'s type, distinct for each `n`. */
export function valueFor(table: string, column: Column, n: number, allowed?: string[]): unknown {
  const values = column.values?.length ? column.values : allowed;
  if (values?.length) return values[0];
  const t = column.type.toLowerCase();
  if (/\[\]$/.test(t)) return "{}";
  if (/^bool/.test(t) || t === "tinyint(1)") return false;
  if (/uuid/.test(t)) return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  if (/json/.test(t)) return "{}";
  if (/^(timestamp|datetime)/.test(t)) return new Date(EPOCH + n * 1000).toISOString().slice(0, 19).replace("T", " ");
  if (/^date/.test(t)) return new Date(EPOCH + (n - 1) * 86_400_000).toISOString().slice(0, 10);
  if (/^time/.test(t)) return "00:00:00";
  if (/int|serial|numeric|decimal|real|double|float|money|number/.test(t)) return n;
  if (/bytea|blob|binary/.test(t)) return Buffer.from(String(n));
  if (/^inet/.test(t)) return `10.0.${Math.floor(n / 256) % 256}.${n % 256}`;
  if (t === "" || /char|text|clob|string|citext|name/.test(t)) return text(table, column, n);
  throw new Error(`slicetest: db.make("${table}") doesn't know how to make a value for ${column.name} (${column.type}); pass it yourself: db.make("${table}", { ${column.name}: ... })`);
}

function text(table: string, column: Column, n: number) {
  const name = column.name.toLowerCase();
  let s = /e_?mail/.test(name) ? `${table}-${n}@example.test` : /url|website|link/.test(name) ? `https://example.test/${table}/${n}` : `${column.name}-${n}`;
  const max = column.maxLength;
  if (max !== undefined && s.length > max) s = String(n).padStart(max, "0").slice(-max);
  return s;
}
