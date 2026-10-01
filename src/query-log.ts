import net from "node:net";

export interface Query {
  sql: string;
  /** Milliseconds since the log started. */
  at: number;
}

const TRANSACTION = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|SET|SHOW|DISCARD|DEALLOCATE)\b/i;

/** A list of queries, with helpers for spotting N+1 patterns. */
export class QueryList extends Array<Query> {
  /** Statements grouped by shape (literals and parameters replaced by `?`), most frequent first. */
  shapes(): { sql: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const q of this) {
      const shape = normalizeSql(q.sql);
      counts.set(shape, (counts.get(shape) ?? 0) + 1);
    }
    return [...counts].map(([sql, count]) => ({ sql, count })).sort((a, b) => b.count - a.count);
  }

  /** Without transaction control and session statements (`BEGIN`, `COMMIT`, `SAVEPOINT`, `SET`, …), which some drivers add around every query. */
  withoutTransactions() {
    return queryList(this.filter((q) => !TRANSACTION.test(q.sql)));
  }

  /** Shapes run at least `min` times (default 3): the usual signature of an N+1. */
  repeated(min = 3) {
    return this.shapes().filter((s) => s.count >= min);
  }
}

export function queryList(queries: Query[]) {
  const list = new QueryList();
  list.push(...queries);
  return list;
}

/** `SELECT * FROM t WHERE id = 7 AND name = 'x'` → `SELECT * FROM t WHERE id = ? AND name = ?`. */
export function normalizeSql(sql: string) {
  return sql
    .replace(/\s+/g, " ")
    .trim()
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\$\d+/g, "?")
    .replace(/(?<![\w"`.])-?\d+(\.\d+)?\b/g, "?")
    .replace(/\(\s*\?(\s*,\s*\?)+\s*\)/g, "(?)");
}

type Engine = "postgres" | "mysql";

/**
 * A TCP proxy between the app and its database that reads the wire protocol
 * and records every statement the app runs, whatever its language or driver.
 * Postgres: simple queries and extended-protocol executions. MySQL: COM_QUERY
 * and prepared-statement executions. Connections that switch to TLS are
 * forwarded but not read.
 */
export class QueryLog {
  #queries: Query[] = [];
  #started = performance.now();
  #sockets = new Set<net.Socket>();

  private constructor(
    private readonly server: net.Server,
    readonly port: number,
  ) {}

  static async start(engine: Engine, upstream: { host: string; port: number }) {
    let log!: QueryLog;
    const server = net.createServer((client) => log.#connect(engine, client, upstream));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    log = new QueryLog(server, (server.address() as net.AddressInfo).port);
    return log;
  }

  /** `url` with its host and port pointing at the proxy. */
  proxyUrl(url: string) {
    const u = new URL(url);
    u.hostname = "127.0.0.1";
    u.port = String(this.port);
    return u.toString();
  }

  /** Queries since the last `reset()`, or since `mark` (an index from `mark()`). */
  queries(since = 0) {
    return queryList(this.#queries.slice(since));
  }

  mark() {
    return this.#queries.length;
  }

  reset() {
    this.#queries = [];
  }

  #record(sql: string) {
    this.#queries.push({ sql, at: Math.round(performance.now() - this.#started) });
  }

  #connect(engine: Engine, client: net.Socket, upstream: { host: string; port: number }) {
    const server = net.connect(upstream.port, upstream.host);
    this.#sockets.add(client).add(server);
    const close = () => {
      client.destroy();
      server.destroy();
      this.#sockets.delete(client);
      this.#sockets.delete(server);
    };
    client.on("error", close).on("close", close);
    server.on("error", close).on("close", close);
    const reader = engine === "postgres" ? new PostgresReader((sql) => this.#record(sql)) : new MysqlReader((sql) => this.#record(sql));
    client.on("data", (chunk: Buffer) => {
      try {
        reader.fromClient(chunk);
      } catch {
        reader.opaque = true;
      }
      server.write(chunk);
    });
    server.on("data", (chunk: Buffer) => {
      try {
        reader.fromServer(chunk);
      } catch {
        reader.opaque = true;
      }
      client.write(chunk);
    });
  }

  async close() {
    for (const s of this.#sockets) s.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

const cstring = (buf: Buffer, start: number) => {
  const end = buf.indexOf(0, start);
  return [buf.toString("utf8", start, end), end + 1] as const;
};

class PostgresReader {
  opaque = false;
  #buf: Buffer = Buffer.alloc(0);
  #startup = true;
  #awaitingSsl = false;
  #statements = new Map<string, string>();
  #portals = new Map<string, string>();

  constructor(private readonly record: (sql: string) => void) {}

  fromServer(chunk: Buffer) {
    if (!this.#awaitingSsl) return;
    this.#awaitingSsl = false;
    // 'S' (TLS) or 'G' (GSSAPI encryption): the rest is encrypted.
    if (chunk[0] === 0x53 || chunk[0] === 0x47) this.opaque = true;
  }

  fromClient(chunk: Buffer) {
    if (this.opaque) return;
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      if (this.#startup) {
        if (this.#buf.length < 8) return;
        const len = this.#buf.readInt32BE(0);
        if (this.#buf.length < len) return;
        const code = this.#buf.readInt32BE(4);
        this.#buf = this.#buf.subarray(len);
        if (code === 80877103 || code === 80877104) this.#awaitingSsl = true;
        else if (code !== 80877102) this.#startup = false;
        continue;
      }
      if (this.#buf.length < 5) return;
      const type = String.fromCharCode(this.#buf[0]!);
      const len = this.#buf.readInt32BE(1);
      if (this.#buf.length < len + 1) return;
      const msg = this.#buf.subarray(5, len + 1);
      this.#buf = this.#buf.subarray(len + 1);
      this.#message(type, msg);
    }
  }

  #message(type: string, msg: Buffer) {
    if (type === "Q") {
      this.record(cstring(msg, 0)[0]);
    } else if (type === "P") {
      const [name, next] = cstring(msg, 0);
      this.#statements.set(name, cstring(msg, next)[0]);
    } else if (type === "B") {
      const [portal, next] = cstring(msg, 0);
      this.#portals.set(portal, this.#statements.get(cstring(msg, next)[0]) ?? "");
    } else if (type === "E") {
      const sql = this.#portals.get(cstring(msg, 0)[0]);
      if (sql) this.record(sql);
    }
  }
}

const CLIENT_QUERY_ATTRIBUTES = 1 << 27;

class MysqlReader {
  opaque = false;
  #client: Buffer = Buffer.alloc(0);
  #server: Buffer = Buffer.alloc(0);
  #prepares: string[] = [];
  #attributes = false;
  #statements = new Map<number, string>();

  constructor(private readonly record: (sql: string) => void) {}

  #read(buf: Buffer, each: (seq: number, payload: Buffer) => void): Buffer {
    while (buf.length >= 4) {
      const len = buf.readUIntLE(0, 3);
      if (buf.length < len + 4) break;
      each(buf[3]!, buf.subarray(4, len + 4));
      buf = buf.subarray(len + 4);
    }
    return Buffer.from(buf);
  }

  fromClient(chunk: Buffer) {
    if (this.opaque) return;
    this.#client = this.#read(Buffer.concat([this.#client, chunk]), (seq, p) => {
      // The handshake response asking for TLS is a short packet with CLIENT_SSL set.
      if (seq === 1 && p.length === 32 && (p.readUInt32LE(0) & 0x800) !== 0) this.opaque = true;
      if (seq === 1 && p.length >= 4) this.#attributes = (p.readUInt32LE(0) & CLIENT_QUERY_ATTRIBUTES) !== 0;
      // Commands start a new sequence; handshake and auth packets don't.
      if (seq !== 0 || p.length === 0) return;
      if (p[0] === 0x03) this.record(this.#queryText(p));
      else if (p[0] === 0x16) this.#prepares.push(p.toString("utf8", 1));
      else if (p[0] === 0x17 && p.length >= 5) {
        const sql = this.#statements.get(p.readUInt32LE(1));
        if (sql) this.record(sql);
      }
    });
  }

  /** COM_QUERY text; with query attributes it follows a parameter count, a set count and the attributes. */
  #queryText(p: Buffer) {
    if (!this.#attributes) return p.toString("utf8", 1);
    const count = p[1]!;
    // Drivers send no attributes (count 0, one set); anything else is read past heuristically.
    if (count === 0) return p.toString("utf8", 3);
    const text = p.toString("utf8", 3);
    const start = text.search(/\b(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE|CALL|SET|BEGIN|COMMIT|ROLLBACK|START)\b/i);
    return start >= 0 ? text.slice(start) : text;
  }

  fromServer(chunk: Buffer) {
    if (this.opaque || this.#prepares.length === 0) {
      this.#server = Buffer.alloc(0);
      return;
    }
    this.#server = this.#read(Buffer.concat([this.#server, chunk]), (seq, p) => {
      if (seq !== 1 || this.#prepares.length === 0) return;
      const sql = this.#prepares.shift()!;
      if (p[0] === 0x00 && p.length >= 5) this.#statements.set(p.readUInt32LE(1), sql);
    });
  }
}
