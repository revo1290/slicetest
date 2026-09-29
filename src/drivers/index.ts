import type { ResolvedOptions } from "../config.js";
import type { Engine } from "./driver.js";
import { postgres } from "./postgres.js";

export type { Admin, Driver, Engine, Row, Table } from "./driver.js";

/** The database engine a run uses. */
export function engineFor(_opts: Pick<ResolvedOptions, "db">): Engine {
  return postgres;
}
