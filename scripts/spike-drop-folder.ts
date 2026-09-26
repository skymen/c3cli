// Spike: open a project folder in the real editor by dropping it (CDP Input.dispatchDragEvent
// with its real path), no copy. Logs every permission call C3 makes on the handle.
// usage: tsx scripts/spike-drop-folder.ts <folder> [--headed]
import { launch, loadEditor } from "../src/editor.ts";
import { resolveBranch } from "../src/release.ts";
import { readProjectInfo } from "../src/project.ts";
import { collect, waitForOutcome } from "../src/observe.ts";

const dir = process.argv[2];
const session = await launch({ headed: process.argv.includes("--headed") });
const { context, page } = session;
await context.addInitScript(`
  window.__perm = [];
  if (typeof FileSystemHandle !== "undefined") for (const m of ["queryPermission", "requestPermission"]) {
    const orig = FileSystemHandle.prototype[m];
    FileSystemHandle.prototype[m] = async function (d) {
      const r = await orig.call(this, d).catch((e) => "throws " + e.name);
      window.__perm.push(m + "(" + JSON.stringify(d) + ") on " + this.kind + " " + this.name + " -> " + r);
      if (typeof r === "string" && r.startsWith("throws")) throw new DOMException(r, "NotAllowedError");
      return r;
    };
  }
`);
const release = await resolveBranch("stable");
const collector = collect(page);
await page.reload({ waitUntil: "domcontentloaded" });
await loadEditor(page, release, 60_000);
const info = await readProjectInfo(dir);
const t0 = Date.now();
const cdp = await context.newCDPSession(page);
const data = { items: [], files: [dir], dragOperationsMask: 1 };
for (const type of ["dragEnter", "dragOver", "drop"]) await cdp.send("Input.dispatchDragEvent", { type, x: 700, y: 450, data } as any);
const result = await waitForOutcome(page, { projectName: info.name, assetUrl: release.assetUrl, timeoutMs: 30_000, installBundledAddons: true });
console.log("release", release.name, "outcome", result.outcome, "in", Date.now() - t0, "ms, title:", result.title);
console.log("dialogs", JSON.stringify(result.dialogs.map((d) => [d.id, d.langKey, d.body.slice(0, 160)])));
if (process.argv.includes("--save")) {
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(4000);
  const open = await page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => d.id + ": " + (d as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 200)));
  console.log("after Ctrl+S, dialogs:", JSON.stringify(open));
}
console.log("perm calls:\n  " + (await page.evaluate(() => (window as any).__perm)).join("\n  "));
console.log("errors", JSON.stringify([...collector.pageErrors, ...collector.consoleErrors.filter((e) => !/400|adapters/.test(e))].slice(0, 8)));
await page.screenshot({ path: process.env.SHOT ?? "/dev/null" });
await session.close();
