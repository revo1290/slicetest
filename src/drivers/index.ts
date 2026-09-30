import type { ResolvedOptions } from "../config.js";
import type { Engine } from "./driver.js";
import { postgres } from "./postgres.js";

export type { Admin, Driver, Engine, Row, Table } from "./driver.js";

/** The database engine a run uses. MySQL's driver is an optional dependency, loaded only when asked for. */
export async function engineFor(opts: Pick<ResolvedOptions, "db">): Promise<Engine> {
  if (opts.db.engine === "mysql") {
    const mod = await import("./mysql.js").catch((e: unknown) => {
      if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
        throw new Error('slicetest: db.engine "mysql" needs the mysql2 package: npm i -D mysql2');
      }
      throw e;
    });
    return mod.mysqlEngine;
  }
  return postgres;
}
