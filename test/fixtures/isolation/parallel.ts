import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { scenario } from "slicetest";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Barrier files, not timing: asserting only after seeing the other file's marker proves the files overlapped.
export function parallelScenario(owner: string, other: string) {
  scenario(`file ${owner}: rows, stub calls and the app are its own while file ${other} runs`, async ({ http, db, stub, app }) => {
    const dir = process.env.ISOLATION_BARRIER!;
    stub("upstream").on("GET", "/ping").reply(200, { from: owner });
    await db.insert("items", { owner });
    writeFileSync(path.join(dir, owner), String(app.port));

    const marker = path.join(dir, other);
    for (const start = Date.now(); !existsSync(marker); ) {
      if (Date.now() - start > 12_000) throw new Error(`file ${other} never ran at the same time as file ${owner}: the files ran one after the other`);
      await sleep(50);
    }
    expect(readFileSync(marker, "utf8")).not.toBe(String(app.port)); // another app process

    await sleep(200); // let the other file write too
    expect((await db.rows("items")).map((r) => r.owner)).toEqual([owner]);
    expect((await http.get("/via-stub")).json).toEqual({ from: owner });
    expect(stub("upstream").calls()).toHaveLength(1);
  }, 30_000);
}
