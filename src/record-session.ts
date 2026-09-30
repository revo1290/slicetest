/**
 * The test file `npx slicetest record` runs: one scenario that lasts until the
 * user is done, so the session gets the same app, database and stubs as tests.
 */
import { SESSION_ENV, runSession, type RecordSession } from "./record.js";
import { scenario } from "./scenario.js";

const session = JSON.parse(process.env[SESSION_ENV] ?? "null") as RecordSession | null;
if (!session) throw new Error("slicetest: this file is run by `npx slicetest record`");

scenario("slicetest record", (ctx) => runSession(ctx, session), 24 * 60 * 60 * 1000);
