// Spike (step 0.1/0.4 of the drop plan): with src/bridge.ts, open a folder by drop, save it
// into a mirror copy, in place, "save as" into a caught folder and a caught .c3p, delete
// through the bridge, and look at the New project dialog.
// usage: tsx scripts/spike-capture.ts <scratch dir> [--release rX]
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { Bridge } from "../src/bridge.ts";
import { clickProjectMenuItem, clickProjectSubmenuItem, dismissDialogs, launch, listFiles, loadEditor } from "../src/editor.ts";
import { collect, waitForOutcome } from "../src/observe.ts";
import { readProjectInfo } from "../src/project.ts";
import { exactRelease, resolveBranch } from "../src/release.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { release: { type: "string" } } });
const scratch = path.resolve(positionals[0]);
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });
const A = path.join(scratch, "project"), D = path.join(scratch, "mirror"), B = path.join(scratch, "saveas"), C = path.join(scratch, "saveas.c3p");
await cp("fixtures/folder/untitled", A, { recursive: true });

const hashes = async (dir: string) => Object.fromEntries(await Promise.all((await listFiles(dir)).map(async (f) =>
  [f, createHash("sha1").update(await readFile(path.join(dir, f))).digest("hex").slice(0, 8)] as const)));
const changed = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

const release = values.release ? exactRelease(values.release) : await resolveBranch("stable");
const session = await launch({ headed: false });
const { page } = session;
const collector = collect(page);
await loadEditor(page, release, 60_000);
const bridge = await Bridge.attach(page);
const info = await readProjectInfo(A);
const t0 = Date.now();
const root = await bridge.open(A, "folder");
const r = await waitForOutcome(page, { projectName: info.name, assetUrl: release.assetUrl, timeoutMs: 30_000, installBundledAddons: true });
console.log(`${release.name} open: ${r.outcome} in ${Date.now() - t0} ms, ops ${bridge.ops.length}`);

const nudge = async () => {
  await page.mouse.click(700, 600);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
};
const save = async (label: string) => {
  const since = Date.now();
  await dismissDialogs(page);
  await page.keyboard.press("ControlOrMeta+s");
  const ok = await bridge.quiet(since, 20_000);
  console.log(`${label}: quiet=${ok}, wrote ${JSON.stringify(bridge.changedSince(since))}`);
};

// 1. Mirror: a copy of A takes the writes; A stays untouched.
const beforeA = await hashes(A);
await cp(A, D, { recursive: true });
await bridge.mirror(root, D);
await nudge();
await save("mirror save");
await bridge.unmirror(root);
console.log(`  A changed: ${JSON.stringify(changed(beforeA, await hashes(A)))}; D vs A: ${JSON.stringify(changed(beforeA, await hashes(D)))}`);

// 2. Writes are refused outside a save.
await nudge();
const since2 = Date.now();
await page.keyboard.press("ControlOrMeta+s");
await page.waitForTimeout(3000);
const dlg = await page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => d.id + ": " + (d as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 200)));
console.log(`refused save: ops ${bridge.changedSince(since2).length}, dialogs ${JSON.stringify(dlg)}, A changed: ${JSON.stringify(changed(beforeA, await hashes(A)))}`);
await dismissDialogs(page);

// 3. In place.
root.writeTo = root.path;
await nudge();
await save("in-place save");
root.writeTo = null;
console.log(`  A changed: ${JSON.stringify(changed(beforeA, await hashes(A)))}`);

// 4. Save as project folder into a caught folder.
await mkdir(B);
const title0 = await page.title();
await bridge.pick(B, "folder");
console.log(`after caught drop: title ${JSON.stringify(await page.title())} (was ${JSON.stringify(title0)}), dialogs ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => d.id)))}`);
let since = Date.now();
await clickProjectSubmenuItem(page, "Save as", "Save the project to a folder.");
const nag = async () => { await page.click("#confirmDialog[open] .cancelConfirmButton", { timeout: 200 }).catch(() => {}); };
console.log(`save as folder: quiet=${await bridge.quiet(since, 30_000, 1500, nag)}, ${(await listFiles(B)).length} files in B`);

// 5. Save as single file into a caught (empty) .c3p.
await writeFile(C, "");
await bridge.pick(C, "file");
since = Date.now();
await clickProjectSubmenuItem(page, "Save as", "Save the project to a new local file (.c3p).");
console.log(`save as .c3p: quiet=${await bridge.quiet(since, 30_000, 1500, nag)}, ${(await readFile(C)).length} bytes, zip=${(await readFile(C)).subarray(0, 2).toString() === "PK"}`);

// 6. removeEntry and remove() through a caught folder.
const E = path.join(scratch, "rm");
await mkdir(path.join(E, "sub"), { recursive: true });
await writeFile(path.join(E, "a.txt"), "a");
await writeFile(path.join(E, "sub", "b.txt"), "b");
await bridge.pick(E, "folder");
const rmres = await page.evaluate(async () => {
  const w = window as any;
  const h = w.__c3cliPick; w.__c3cliPick = null;
  await h.removeEntry("a.txt");
  await h.removeEntry("sub", { recursive: true });
  const f = await (await h.getFileHandle("new.txt", { create: true })).createWritable();
  await f.write("hello"); await f.close();
  const names: string[] = []; for await (const [n] of h.entries()) names.push(n);
  return names;
});
console.log(`remove: page sees ${JSON.stringify(rmres)}, disk ${JSON.stringify(await readdir(E))}, new.txt=${await readFile(path.join(E, "new.txt"), "utf8")}`);

// 7. New project dialog.
await clickProjectMenuItem(page, "Create a new project or template.");
await page.waitForTimeout(1500);
const np = await page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => ({
  id: d.id,
  inputs: [...d.querySelectorAll("input, select, textarea")].map((i) => `${i.tagName.toLowerCase()}#${i.id}.${(i as HTMLElement).className}[${(i as HTMLInputElement).type ?? ""}]=${(i as HTMLInputElement).value}`),
  buttons: [...d.querySelectorAll("button, ui-button")].map((b) => `${b.tagName.toLowerCase()}.${(b as HTMLElement).className}:${(b as HTMLElement).innerText.trim()}`),
})));
console.log("new project dialog:", JSON.stringify(np, null, 1));
console.log("errors", JSON.stringify([...collector.pageErrors, ...collector.consoleErrors.filter((e) => !/400|adapters/.test(e))].slice(0, 8)));
await session.close();
