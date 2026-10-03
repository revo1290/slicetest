import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Version numbers compare as numbers: Flyway's `V2__` comes before `V10__`. */
const byVersion = new Intl.Collator("en", { numeric: true }).compare;

/**
 * Files `migrate: { sql }` applies, in order: the file itself, or a directory's `.sql` files sorted
 * by name with numbers compared as numbers. Rollback files are left out: golang-migrate / sqlx /
 * Diesel `*.down.sql` and Flyway undo migrations (`U2__…`).
 */
export async function sqlMigrationFiles(target: string): Promise<string[]> {
  if (!(await stat(target)).isDirectory()) return [target];
  return (await readdir(target))
    .filter((f) => f.toLowerCase().endsWith(".sql") && !/\.down\.sql$/i.test(f) && !/^U\d+(\.\d+)*__/.test(f))
    .sort(byVersion)
    .map((f) => path.join(target, f));
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
