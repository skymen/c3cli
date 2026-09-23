// Spike: open a project and walk Menu → Project → Export → Web (HTML5) → zip, dumping the
// dialogs after every step. usage: tsx scripts/spike-export.ts <project> [out.zip]
import { clickOpen, launch, loadEditor, stageProject } from "../src/editor.ts";
import { waitForOutcome } from "../src/observe.ts";
import { readProjectInfo } from "../src/project.ts";
import { resolveBranch } from "../src/release.ts";

const [target = "fixtures/c3p/untitled.c3p", out = "/tmp/c3cli-export-test.zip"] = process.argv.slice(2);
const project = await readProjectInfo(target);
const release = await resolveBranch("stable");
const s = await launch({ headed: false });
const page = s.page;
await loadEditor(page, release, 60000);
await stageProject(page, project, "export");
await clickOpen(page, project.kind);
console.log("open:", (await waitForOutcome(page, { projectName: project.name, assetUrl: release.assetUrl, timeoutMs: 60000, installBundledAddons: true })).outcome);
await page.keyboard.press("Escape");

const dump = async (label: string) => {
  const d = await page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => ({
    id: d.id,
    text: (d as HTMLElement).innerText.replace(/\n+/g, " ⏎ ").slice(0, 500),
    buttons: [...d.querySelectorAll("button")].map((b) => `${b.className}:${b.innerText.trim()}`),
  })));
  console.log(`${label}:`, JSON.stringify(d));
};
const step = async (label: string, fn: () => Promise<unknown>) => {
  try { await fn(); } catch (e) { console.log(`${label} FAILED: ${(e as Error).message.split("\n")[0]}`); await dump("dialogs at failure"); await page.screenshot({ path: "reports/spike-export-fail.png" }); await s.close(); process.exit(1); }
  await page.waitForTimeout(1500);
  await dump(label);
};

await step("menu → export", async () => {
  await page.click("#mainMenuButton");
  await page.locator("ui-menuitem[sub-menu]").first().click();
  await page.waitForTimeout(500);
  await page.locator('ui-menuitem[title="Export the project for publishing to a platform."]').click();
});
await step("pick Web (HTML5) → next", async () => {
  await page.locator("#exportSelectPlatformDialog ui-iconviewitem", { hasText: "Web (HTML5)" }).first().click({ timeout: 5000 });
  await page.click("#exportSelectPlatformDialog .nextButton", { timeout: 5000 });
});
page.on("download", (d) => console.log("download event:", d.suggestedFilename()));
await step("options → next", async () => {
  await page.click("#exportStandardOptionsDialog .nextButton", { timeout: 5000 });
});
await step("wait for report", async () => {
  await page.waitForSelector("#webExportReportDialog[open]", { timeout: 60000 });
});
const dlP = page.waitForEvent("download", { timeout: 15000 });
await page.click("#webExportReportDialog a.downloadExportedProject");
const dl = await dlP;
await dl.saveAs(out);
console.log("saved", dl.suggestedFilename(), "→", out);
await s.close();
