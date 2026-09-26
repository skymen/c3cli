// Manual integration check (network): open by drop and every way of saving, on each branch.
// Works on scratch copies only.
// usage: tsx scripts/check-open-save.ts <scratch dir> [--branches stable,beta,lts]
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { C3Editor, resolveRelease } from "../src/api.ts";
import type { Branch } from "../src/release.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { branches: { type: "string", default: "stable,beta,lts" } } });
const scratch = path.resolve(positionals[0] ?? "");
if (!positionals[0]) throw new Error("usage: check-open-save.ts <scratch dir>");
const fixtures = { folder: "fixtures/folder/untitled", file: "fixtures/c3p/untitled.c3p" };
const log = (s: string) => console.log(s);
let failures = 0;
const check = (ok: boolean, what: string) => { if (!ok) failures++; log(`  ${ok ? "ok  " : "FAIL"} ${what}`); };

for (const branch of values.branches!.split(",") as Branch[]) {
  const release = await resolveRelease({ branch });
  log(`${branch} (${release.name})`);
  const dir = path.join(scratch, release.name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const editor = await C3Editor.launch({});
  try {
    for (const [kind, fixture] of Object.entries(fixtures)) {
      const input = path.join(dir, path.basename(fixture));
      await cp(fixture, input, { recursive: true });
      const ext = kind === "file" ? ".c3p" : "";
      // Open, save --to, save as folder and as .c3p, export.
      let p = await editor.open(input, { release: release.name });
      check(p.report.outcome === "opened", `${kind}: open → ${p.report.outcome} in ${p.report.durationMs} ms`);
      if (p.report.outcome === "opened") {
        const to = await p.save(path.join(dir, `saved-${kind}${ext}`));
        check(to.ok && !!to.diff, `${kind}: save --to → ${to.ok ? `${to.written.length} written, ${to.diff!.filesChanged} differ` : to.error}`);
        const before = await readFile(kind === "file" ? input : path.join(input, "project.c3proj"));
        const asFolder = await p.saveAs(path.join(dir, `saveas-${kind}`));
        check(asFolder.ok && asFolder.written.length > 5, `${kind}: saveAs folder → ${asFolder.ok ? `${asFolder.written.length} files` : asFolder.error}`);
        const asFile = await p.saveAs(path.join(dir, `saveas-${kind}.c3p`));
        const size = asFile.ok ? (await stat(asFile.to)).size : 0;
        check(asFile.ok && size > 1000, `${kind}: saveAs .c3p → ${asFile.ok ? `${size} bytes` : asFile.error}`);
        const same = (await readFile(kind === "file" ? input : path.join(input, "project.c3proj"))).equals(before);
        check(same, `${kind}: the input is untouched by save --to and saveAs`);
        const ex = await p.export(path.join(dir, `export-${kind}.zip`));
        check(ex.outcome === "exported", `${kind}: export → ${ex.outcome}${ex.error ? ` ${ex.error}` : ""}`);
        const pv = await p.runPreview({ seconds: 2 });
        check(pv.started, `${kind}: preview → ${pv.started ? `runtime in ${pv.runtimeIn}` : pv.error}`);
      }
      await p.close();
      // In place.
      p = await editor.open(input, { release: release.name });
      if (p.report.outcome === "opened") {
        const s = await p.save();
        check(s.ok && s.inPlace && s.written.length > 0, `${kind}: save in place → ${s.ok ? s.written.join(", ") : s.error}`);
      }
      await p.close();
    }
    // A project at the root of a big folder: nothing is copied, so the size doesn't matter.
    const big = path.join(dir, "big");
    await cp(fixtures.folder, big, { recursive: true });
    await mkdir(path.join(big, ".git"), { recursive: true });
    await mkdir(path.join(big, "tools"), { recursive: true });
    await writeFile(path.join(big, "tools", "blob.bin"), Buffer.alloc(1024 * 1024 * 1024));
    const p = await editor.open(big, { release: release.name });
    check(p.report.outcome === "opened" && p.report.durationMs < 5000, `1 GB extra folder: open → ${p.report.outcome} in ${p.report.durationMs} ms`);
    await p.close();
    await rm(path.join(big, "tools"), { recursive: true, force: true });
  } finally {
    await editor.close();
  }
}
log(failures ? `${failures} failure(s)` : "all ok");
process.exitCode = failures ? 1 : 0;
