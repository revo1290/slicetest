import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolveOptions, type SlicetestOptions } from "./config.js";
import { SESSION_ENV, type RecordSession, type Summary } from "./record.js";

const ext = path.extname(fileURLToPath(import.meta.url));
const sessionFile = fileURLToPath(new URL(`./record-session${ext}`, import.meta.url));

/** The main-process side of `npx slicetest record`: run the session, tell the user where to send requests, stop on Enter. */
export async function record(configPath: string, options: SlicetestOptions, { out, port = 0 }: { out?: string; port?: number }) {
  const root = path.dirname(configPath);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const file = path.resolve(root, out ?? path.join("scenarios", `recorded-${stamp}.scenario.yaml`));
  if (existsSync(file)) throw new Error(`slicetest record: ${path.relative(process.cwd(), file)} already exists. Pass --out <file>.`);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`slicetest record: --port must be a port number, got ${port}`);
  await mkdir(path.dirname(file), { recursive: true });
  const dir = await mkdtemp(path.join(os.tmpdir(), "slicetest-record-"));
  const session: RecordSession = {
    stateFile: path.join(dir, "state.json"),
    stopFile: path.join(dir, "stop"),
    out: file,
    port,
    stubs: resolveOptions(options, root).stubs,
  };
  process.env[SESSION_ENV] = JSON.stringify(session);
  const stop = () => void writeFile(session.stopFile, "").catch(() => {});
  process.once("SIGINT", stop);

  const { startVitest } = await import("vitest/node");
  const { slicetest } = await import("./vitest.js");
  const announce = watchState(session.stateFile, (state) => {
    process.stdout.write(
      `\nRecording. Use the app through ${state.url} (it forwards to ${state.app}).\n` +
        "Everything it does is captured: responses, calls to stubs, database changes.\n" +
        "Press Enter (or Ctrl+C) to finish and write the scenario.\n\n",
    );
    const rl = createInterface({ input: process.stdin });
    rl.once("line", () => {
      rl.close();
      stop();
    });
    process.stdin.once("end", stop);
  });
  try {
    const vitest = await startVitest(
      [],
      { config: false, root, include: [sessionFile.replace(/\\/g, "/")], exclude: [], watch: false, run: true, reporters: ["dot"] },
      { plugins: [slicetest(options)] },
    );
    await vitest?.close();
    const state = existsSync(session.stateFile) ? (JSON.parse(await readFile(session.stateFile, "utf8")) as { done?: boolean; summary?: Summary }) : {};
    if (!state.done || !state.summary) {
      process.stderr.write("slicetest record: the session ended before anything was written (see the output above).\n");
      process.exitCode = 1;
      return;
    }
    // The session is written; a failure after it (e.g. an unmatched stub call) is reported in the file's header.
    process.exitCode = 0;
    const s = state.summary;
    process.stdout.write(
      `\nWrote ${path.relative(process.cwd(), file)}: ${s.requests} request(s), ${s.stubs} stub route(s), changes in ${s.tables.length ? s.tables.join(", ") : "no tables"}.\n` +
        (s.skippedAssets ? `Left out ${s.skippedAssets} request(s) for static files.\n` : "") +
        (s.unanswered.length ? `Calls no stub answered (see the file's header): ${s.unanswered.join(", ")}\n` : "") +
        `Replay it with: npx slicetest ${path.relative(root, file).replace(/\\/g, "/")}\n`,
    );
  } finally {
    announce.cancel();
    process.off("SIGINT", stop);
    // The Enter listener would otherwise keep the process alive.
    process.stdin.destroy();
    delete process.env[SESSION_ENV];
    await rm(dir, { recursive: true, force: true });
  }
}

function watchState(file: string, onReady: (state: { url: string; app: string }) => void) {
  let cancelled = false;
  void (async () => {
    while (!cancelled) {
      if (existsSync(file)) {
        try {
          const state = JSON.parse(await readFile(file, "utf8"));
          if (state.url) return onReady(state);
        } catch {
          // Partly written; read it again.
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return {
    cancel: () => {
      cancelled = true;
    },
  };
}
