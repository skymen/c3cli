// Manual integration check (network): many open + saveAs on several tabs at once, the load
// under which saveAs used to flake (c3merge's lab: 2 of 126, 3 tabs; progress dialog in the
// way, or OPFS NotFoundError).
// usage: tsx scripts/check-saveas.ts <scratch dir> [--tabs 3] [--runs 40]
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { C3Editor, resolveRelease } from "../src/api.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { tabs: { type: "string", default: "3" }, runs: { type: "string", default: "40" } } });
if (!positionals[0]) throw new Error("usage: check-saveas.ts <scratch dir>");
const scratch = path.resolve(positionals[0]);
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });
const tabs = Number(values.tabs), runs = Number(values.runs);
const release = await resolveRelease({});
const inputs = ["fixtures/folder/untitled", "fixtures/folder/battleship", "fixtures/folder/test-gizmos", "fixtures/c3p/3d-lighting.c3p"];
const editor = await C3Editor.launch({ tabs, warm: { release: release.name } });
const t0 = Date.now();
const failures: string[] = [];
let next = 0;
await Promise.all(Array.from({ length: tabs }, async () => {
  for (let i = next++; i < runs; i = next++) {
    const input = inputs[i % inputs.length];
    const p = await editor.open(input, { release: release.name });
    try {
      if (p.report.outcome !== "opened") { failures.push(`${i} ${input}: ${p.report.outcome}`); continue; }
      const s = await p.saveAs(path.join(scratch, String(i)));
      if (!s.ok) failures.push(`${i} ${input}: ${s.error}`);
    } finally {
      await p.close();
    }
  }
}));
await editor.close();
console.log(`${runs} open + saveAs on ${tabs} tabs (${release.name}): ${failures.length} failure(s), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const f of failures) console.log(`  ${f}`);
process.exitCode = failures.length ? 1 : 0;
