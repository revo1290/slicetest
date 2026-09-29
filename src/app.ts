import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ResolvedOptions } from "./config.js";

const LOG_LINES = 200;
/** How long to wait for stdout/stderr to drain after the process exits. */
const DRAIN_MS = 100;
const KILL_GRACE_MS = 3000;
const WINDOWS = process.platform === "win32";

type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

/** The app under test, running as a real child process. */
export class App {
  #child: ChildProcess;
  #log: string[] = [];
  /** Lines ever received, so callers can ask for output since a point in time. */
  #lineCount = 0;
  #exit?: Exit;
  #exited: Promise<Exit>;
  #onLine?: (line: string) => void;

  private constructor(
    child: ChildProcess,
    readonly url: string,
  ) {
    this.#child = child;
    for (const stream of [child.stdout!, child.stderr!]) {
      // Keep partial lines (and split multi-byte characters) until the rest arrives.
      const decoder = new StringDecoder("utf8");
      let partial = "";
      const push = (line: string) => {
        if (!line) return;
        this.#log.push(line);
        this.#lineCount++;
        if (this.#log.length > LOG_LINES) this.#log.shift();
        this.#onLine?.(line);
      };
      stream.on("data", (chunk: Buffer) => {
        const lines = (partial + decoder.write(chunk)).split(/\r?\n/);
        partial = lines.pop()!;
        lines.forEach(push);
      });
      stream.on("end", () => push(partial + decoder.end()));
    }
    this.#exited = new Promise((resolve) => {
      const done = (exit: Exit) => {
        this.#exit ??= exit;
        resolve(this.#exit);
      };
      child.on("error", (error) => done({ code: null, signal: null, error }));
      // 'exit' can fire before the output is read; prefer 'close', but don't wait
      // forever when a grandchild still holds the pipes open.
      child.on("exit", (code, signal) => setTimeout(() => done({ code, signal }), DRAIN_MS).unref());
      child.on("close", (code, signal) => done({ code, signal }));
    });
  }

  static async start(opts: ResolvedOptions["app"], root: string, vars: Record<string, string>) {
    const port = await freePort();
    vars = { ...vars, "app.port": String(port) };
    const env = opts.env ?? { PORT: "{{app.port}}", DATABASE_URL: "{{db.url}}" };
    const child = spawn(interpolate(opts.command, vars, "app.command"), {
      shell: true,
      cwd: path.resolve(root, opts.cwd ?? "."),
      env: { ...process.env, ...mapValues(env, (v) => interpolate(v, vars, "app.env")) },
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX: own process group, so stop() also kills whatever the shell spawned.
      // Windows: detaching would open a console window; taskkill /T walks the tree instead.
      detached: !WINDOWS,
      windowsHide: true,
    });
    const app = new App(child, `http://127.0.0.1:${port}`);
    running.add(app);
    try {
      await app.#waitReady(opts);
    } catch (e) {
      await app.stop();
      throw e;
    }
    return app;
  }

  get exited() {
    return this.#exit;
  }

  /**
   * The exit event is delivered asynchronously, so a crash caused by the last
   * request may not be visible yet. Give it a moment before trusting `exited`.
   */
  async settle(ms = 20) {
    if (this.#exit) return this.#exit;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.#exited, new Promise((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
    return this.#exit;
  }

  /** The app's recent output (last 200 lines), or only what it printed after `since` (a value from `mark()`). */
  logs(since?: number) {
    if (since === undefined) return this.#log.join("\n");
    const n = Math.min(this.#lineCount - since, this.#log.length);
    return n > 0 ? this.#log.slice(-n).join("\n") : "";
  }

  mark() {
    return this.#lineCount;
  }

  /**
   * POSIX: SIGTERM the whole process group, then SIGKILL whatever is left (including orphaned grandchildren).
   * Windows has no signals to ask politely with, so the tree is terminated at once.
   */
  async stop() {
    running.delete(this);
    const pid = this.#child.pid;
    if (pid === undefined) return;
    if (WINDOWS) {
      if (!this.#exit) killTree(pid);
      await this.settle(KILL_GRACE_MS);
      return;
    }
    if (!this.#exit) {
      killGroup(pid, "SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.#exited, new Promise((r) => (timer = setTimeout(r, KILL_GRACE_MS)))]);
      clearTimeout(timer);
    }
    killGroup(pid, "SIGKILL");
  }

  /** Synchronous last resort for process exit. */
  killNow() {
    const pid = this.#child.pid;
    if (pid === undefined) return;
    if (WINDOWS) killTree(pid);
    else killGroup(pid, "SIGKILL");
  }

  async #waitReady(opts: ResolvedOptions["app"]) {
    const timeout = opts.readyTimeout ?? 30_000;
    const deadline = Date.now() + timeout;
    const ready = opts.ready;
    let logSeen = false;
    if ("log" in ready) {
      // Drop g/y so test() doesn't keep state between lines.
      const pattern = new RegExp(ready.log, ready.flags.replace(/[gy]/g, ""));
      logSeen = this.#log.some((l) => pattern.test(l));
      this.#onLine = (line) => (logSeen ||= pattern.test(line));
    }
    try {
      while (Date.now() < deadline) {
        if (this.#exit) {
          const why = this.#exit.error ? this.#exit.error.message : `code ${this.#exit.code}, signal ${this.#exit.signal}`;
          throw new Error(`slicetest: app exited before becoming ready (${why})\n${this.logs()}`);
        }
        if ("log" in ready) {
          if (logSeen) return;
        } else {
          try {
            const res = await fetch(this.url + ready.path, { signal: AbortSignal.timeout(1000) });
            await res.body?.cancel();
            // Our child may not own the port yet if something else grabbed it; only trust a live child.
            if (res.status < 500 && !this.#exit) return;
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`slicetest: app did not become ready within ${timeout}ms\n${this.logs()}`);
    } finally {
      this.#onLine = undefined;
    }
  }
}

/** Apps still running, killed synchronously if the worker exits without tearing down. */
const running = new Set<App>();
process.once("exit", () => {
  for (const app of running) app.killNow();
});

/** Windows: terminate the shell and everything it started. Synchronous so it also works on process exit. */
function killTree(pid: number) {
  spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone.
  }
}

export function interpolate(template: string, vars: Record<string, string>, where = "app.env") {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      throw new Error(`slicetest: unknown placeholder {{${key}}} in ${where}. Available: ${Object.keys(vars).map((k) => `{{${k}}}`).join(", ")}`);
    }
    return vars[key]!;
  });
}

function mapValues<T, U>(obj: Record<string, T>, fn: (v: T) => U) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}
