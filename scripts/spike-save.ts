// Spike: open a project from OPFS, save it with the editor, read the saved copy back out
// and diff it against the input. usage: tsx scripts/spike-save.ts <folder|.c3p> <outDir>
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { clickOpen, launch, listFiles, loadEditor, stageProject } from "../src/editor.ts";
import { collect, waitForOutcome } from "../src/observe.ts";
import { readProjectInfo } from "../src/project.ts";
import { resolveBranch } from "../src/release.ts";

const [target, outDir] = process.argv.slice(2);
const project = await readProjectInfo(target);
const release = await resolveBranch("stable");
const s = await launch({ profile: "/tmp/c3cli-save-profile", headed: false });
const c = collect(s.page);
await loadEditor(s.page, release, 60000);
await stageProject(s.page, project, "save");
await clickOpen(s.page, project.kind);
const r = await waitForOutcome(s.page, { projectName: project.name, assetUrl: release.assetUrl, timeoutMs: 60000, installBundledAddons: true });
console.log("open:", r.outcome);

const snap = () => s.page.evaluate(async () => {
  const out: Record<string, number> = {};
  const walk = async (d: FileSystemDirectoryHandle, pre: string) => {
    for await (const [name, h] of (d as any).entries()) {
      if (h.kind === "directory") await walk(h, pre + name + "/");
      else out[pre + name] = (await h.getFile()).lastModified;
    }
  };
  await walk((window as any).__c3cliRun, "");
  return out;
});
const before = await snap();
await s.page.keyboard.press("ControlOrMeta+s");
await s.page.waitForTimeout(4000);
const after = await snap();
const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
console.log("files touched by save:", changed.length, changed.slice(0, 10));
console.log("dialogs now:", await s.page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => d.id + ": " + (d as HTMLElement).innerText.slice(0, 120).replace(/\s+/g, " "))));

// Read the whole staged copy back out.
const files: { rel: string; b64: string }[] = await s.page.evaluate(async () => {
  const out: { rel: string; b64: string }[] = [];
  const walk = async (d: FileSystemDirectoryHandle, pre: string) => {
    for await (const [name, h] of (d as any).entries()) {
      if (h.kind === "directory") await walk(h, pre + name + "/");
      else {
        const bytes = new Uint8Array(await (await h.getFile()).arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        out.push({ rel: pre + name, b64: btoa(bin) });
      }
    }
  };
  await walk((window as any).__c3cliRun, "");
  return out;
});
await rm(outDir, { recursive: true, force: true });
for (const f of files) {
  await mkdir(path.dirname(path.join(outDir, f.rel)), { recursive: true });
  await writeFile(path.join(outDir, f.rel), Buffer.from(f.b64, "base64"));
}
console.log("read back", files.length, "files; page errors:", c.pageErrors.length);
await s.close();
