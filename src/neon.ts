/**
 * Neon's HTTP query endpoint, served from the test database, so apps on the Neon
 * serverless driver (`neon()` from @neondatabase/serverless, drizzle-orm/neon-http,
 * @vercel/postgres's `sql`) run against the local Postgres without a code change.
 *
 * The driver posts each query to `https://api.<domain>/sql` for a connection string
 * at `<endpoint>.<domain>`; with `db.neon` the app gets such a string and the
 * intercepting proxy hands that host to this server.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";

/** The made-up domain of the connection string the app gets; `*.` of it is intercepted. */
export const NEON_DOMAIN = "neon.slicetest";

/** `url` (the real test database) with its host replaced by a Neon-style endpoint host. */
export function neonUrl(url: string) {
  const u = new URL(url);
  u.hostname = `ep-slicetest.${NEON_DOMAIN}`;
  u.port = "";
  u.searchParams.set("sslmode", "require");
  return u.toString();
}

// Values stay as Postgres's text: the driver parses them itself from each field's type.
const RAW = { getTypeParser: () => (value: string) => value } as unknown as pg.CustomTypesConfig;
const ERROR_FIELDS = ["severity", "code", "detail", "hint", "position", "internalPosition", "internalQuery", "where", "schema", "table", "column", "dataType", "constraint", "file", "line", "routine"] as const;

interface Query {
  query: string;
  params?: unknown[];
}

export class NeonEndpoint {
  readonly #server: http.Server;
  readonly #pool: pg.Pool;

  private constructor(databaseUrl: string) {
    this.#pool = new pg.Pool({ connectionString: databaseUrl, max: 5, types: RAW });
    this.#pool.on("error", () => {});
    this.#server = http.createServer((req, res) => {
      this.#handle(req, res).catch((e) => res.headersSent || res.writeHead(500).end(String(e)));
    });
  }

  /** `databaseUrl` is where queries really run: the worker database, or the `db.queries` proxy in front of it. */
  static async start(databaseUrl: string) {
    const endpoint = new NeonEndpoint(databaseUrl);
    await new Promise<void>((resolve) => endpoint.#server.listen(0, "127.0.0.1", resolve));
    return endpoint;
  }

  get port() {
    return (this.#server.address() as AddressInfo).port;
  }

  /** Serve a connection the intercepting proxy terminated. */
  attach(socket: import("node:net").Socket) {
    this.#server.emit("connection", socket);
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method !== "POST" || !req.url?.startsWith("/sql")) return send(404, { message: `slicetest's Neon endpoint only answers POST /sql, not ${req.method} ${req.url}` });
    let body: Query | { queries: Query[] };
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      body = JSON.parse(raw);
    } catch {
      return send(400, { message: "invalid JSON body" });
    }
    const arrayMode = req.headers["neon-array-mode"] === "true";
    const client = await this.#pool.connect();
    try {
      if ("queries" in body) {
        const level = req.headers["neon-batch-isolation-level"];
        const readOnly = req.headers["neon-batch-read-only"] === "true";
        const deferrable = req.headers["neon-batch-deferrable"] === "true";
        const mode = [level && `ISOLATION LEVEL ${String(level).replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase()}`, readOnly && "READ ONLY", deferrable && "DEFERRABLE"].filter(Boolean);
        await client.query(`BEGIN${mode.length ? ` ${mode.join(" ")}` : ""}`);
        try {
          const results = [];
          for (const q of body.queries) results.push(await run(client, q, arrayMode));
          await client.query("COMMIT");
          return send(200, { results });
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        }
      }
      return send(200, await run(client, body, arrayMode));
    } catch (e) {
      // Shaped like Neon's: a message plus Postgres's error fields, which the driver copies onto its error.
      const err = e as Record<string, unknown> & Error;
      return send(400, { message: err.message, ...Object.fromEntries(ERROR_FIELDS.filter((f) => err[f] !== undefined).map((f) => [f, err[f]])) });
    } finally {
      client.release();
    }
  }

  async close() {
    this.#server.closeAllConnections();
    await new Promise((resolve) => this.#server.close(resolve));
    await this.#pool.end();
  }
}

async function run(client: pg.PoolClient, { query, params = [] }: Query, arrayMode: boolean) {
  const result = await client.query({ text: query, values: params, rowMode: "array" });
  const fields = result.fields.map((f) => ({
    name: f.name,
    tableID: f.tableID,
    columnID: f.columnID,
    dataTypeID: f.dataTypeID,
    dataTypeSize: f.dataTypeSize,
    dataTypeModifier: f.dataTypeModifier,
    format: "text",
  }));
  const rows = arrayMode ? result.rows : (result.rows as unknown[][]).map((r) => Object.fromEntries(fields.map((f, i) => [f.name, r[i]])));
  return { command: result.command, rowCount: result.rowCount, rows, fields, rowAsArray: arrayMode };
}
