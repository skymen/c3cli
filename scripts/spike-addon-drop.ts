// Spike (step 0.3 of the drop plan): drop .c3addon files onto the editor. Which dialogs
// follow, can several go in one drop, does a reload make them active?
// usage: tsx scripts/spike-addon-drop.ts <file.c3addon>... [--open <project>]
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { Bridge, drop } from "../src/bridge.ts";
import { launch, loadEditor } from "../src/editor.ts";
import { waitForOutcome } from "../src/observe.ts";
import { readProjectInfo } from "../src/project.ts";
import { resolveBranch } from "../src/release.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { open: { type: "string" } } });
const release = await resolveBranch("stable");
const s = await launch({ headed: false });
const page = s.page;
await loadEditor(page, release, 60_000);
const dialogs = () => page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => `${d.id}: ${(d as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 220)}`));
// All files in one browser-level drop.
const cdp = await s.context.newCDPSession(page);
const data = { items: [], files: positionals.map((f) => path.resolve(f)), dragOperationsMask: 1 };
for (const type of ["dragEnter", "dragOver", "drop"]) await cdp.send("Input.dispatchDragEvent", { type, x: 700, y: 450, data } as any);
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(500);
  const d = await dialogs();
  if (d.length) console.log(`t+${(i + 1) * 0.5}s`, JSON.stringify(d));
  if (await page.locator("#addonConfirmInstallDialog[open]").count()) { await page.click("#addonConfirmInstallDialog .okButton"); console.log("  → clicked install"); continue; }
  if (d.length) { await page.keyboard.press("Escape"); console.log("  → escape"); }
}
await loadEditor(page, release, 60_000);
const installed = await page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  return dbs.map((d) => d.name);
});
console.log("indexedDB after reload:", JSON.stringify(installed));
if (values.open) {
  const bridge = await Bridge.attach(page);
  const info = await readProjectInfo(values.open);
  await bridge.open(path.resolve(values.open), info.kind);
  const r = await waitForOutcome(page, { projectName: info.name, assetUrl: release.assetUrl, timeoutMs: 30_000, installBundledAddons: true });
  console.log(`open ${values.open}: ${r.outcome} ${r.missingAddons.map((a) => a.id).join(" ")}`);
}
await s.close();
