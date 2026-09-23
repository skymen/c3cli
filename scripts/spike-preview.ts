// Spike: open a project, start preview, capture the preview window's console for N s.
// usage: tsx scripts/spike-preview.ts <project> [seconds]
import { clickOpen, launch, loadEditor, stageProject } from "../src/editor.ts";
import { waitForOutcome } from "../src/observe.ts";
import { readProjectInfo } from "../src/project.ts";
import { resolveBranch } from "../src/release.ts";

const [target, secs = "8"] = process.argv.slice(2);
const project = await readProjectInfo(target);
const release = await resolveBranch("stable");
const s = await launch({ profile: "/tmp/c3cli-save-profile", headed: false });
await loadEditor(s.page, release, 60000);
await stageProject(s.page, project, "preview");
await clickOpen(s.page, project.kind);
console.log("open:", (await waitForOutcome(s.page, { projectName: project.name, assetUrl: release.assetUrl, timeoutMs: 60000, installBundledAddons: true })).outcome);

console.log("toolbar candidates:", await s.page.evaluate(() =>
  [...document.querySelectorAll("#mainToolbar *, [id*=preview i], [title*=review i]")].filter((e) => (e as HTMLElement).offsetParent)
    .slice(0, 12).map((e) => `${e.tagName}#${e.id}.${(e as HTMLElement).className} title=${e.getAttribute("title")}`)));

const popupP = s.context.waitForEvent("page", { timeout: 20000 }).catch((e) => e as Error);
await s.page.keyboard.press("F5");
const popup = await popupP;
if (popup instanceof Error) { console.log("no preview window:", popup.message); await s.page.screenshot({ path: "reports/spike-preview-fail.png" }); }
else {
  const logs: string[] = [];
  popup.on("console", (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
  popup.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  console.log("preview url:", popup.url());
  popup.on("worker", (w) => logs.push(`[worker+] ${w.url()}`));
  await popup.waitForTimeout(2000);
  console.log("workers:", popup.workers().map((w) => w.url()));
  // Inject failures to see which channels surface them: worker throw, worker console.error, page throw.
  for (const w of popup.workers()) await w.evaluate(`setTimeout(() => { throw new Error("c3cli-probe worker throw"); }); console.error("c3cli-probe worker console.error");`).catch((e) => logs.push("[probe-fail] " + e.message));
  await popup.evaluate(`setTimeout(() => { throw new Error("c3cli-probe page throw"); })`);
  await popup.waitForTimeout(Number(secs) * 1000);
  await popup.screenshot({ path: "reports/spike-preview.png" }).catch(() => {});
  console.log(logs.slice(0, 30).join("\n"));
}
await s.close();
