import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Version numbers compare as numbers: Flyway's `V2__` comes before `V10__`. */
const byVersion = new Intl.Collator("en", { numeric: true }).compare;

/**
 * Files `migrate: { sql }` applies, in order: the file itself, or a directory's `.sql` files (and
 * Diesel's `<version>_<name>/up.sql`) sorted by name with numbers compared as numbers. Rollback
 * files are left out: golang-migrate / sqlx `*.down.sql`, Diesel's `down.sql` and Flyway undo
 * migrations (`U2__…`).
 */
export async function sqlMigrationFiles(target: string): Promise<string[]> {
  if (!(await stat(target)).isDirectory()) return [target];
  const entries = await readdir(target, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".sql") && !/\.down\.sql$/i.test(e.name) && !/^U\d+(\.\d+)*__/.test(e.name)).map((e) => e.name);
  // Diesel: one directory per migration, holding up.sql and down.sql.
  const dirs = entries.filter((e) => e.isDirectory() && existsSync(path.join(target, e.name, "up.sql"))).map((e) => path.join(e.name, "up.sql"));
  return [...files, ...dirs].sort(byVersion).map((f) => path.join(target, f));
}

/** Where a migration's rollback section starts in goose (`-- +goose Down`) and dbmate (`-- migrate:down`) files. */
const DOWN = /^--\s*(\+goose\s+down|migrate:down)\b/im;

/** The statements of a migration file that migrate up: without a goose or dbmate down section. */
export function upSection(sql: string): string {
  const m = DOWN.exec(sql);
  return m ? sql.slice(0, m.index) : sql;
}

/** Apply `files` in order with `exec`, naming the file that fails. */
export async function applySqlFiles(files: string[], exec: (sql: string) => Promise<unknown>, root: string) {
  for (const file of files) {
    try {
      await exec(upSection(await readFile(file, "utf8")));
    } catch (e) {
      throw new Error(`slicetest: db.migrate.sql: ${path.relative(root, file) || file}: ${(e as Error).message}`, { cause: e });
    }
  }
}
