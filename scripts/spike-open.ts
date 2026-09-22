// Spike: open a project through the menu + Playwright filechooser.
// usage: tsx scripts/spike-open.ts file|folder <path>
import { chromium } from "playwright";
import path from "node:path";

const [mode, target] = process.argv.slice(2);
const label = mode === "folder" ? "Open local project folder" : "Open local file";
const ctx = await chromium.launchPersistentContext("/tmp/c3cli-spike-profile", { headless: true, viewport: { width: 1400, height: 900 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const log: string[] = [];
page.on("console", (m) => log.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
page.on("pageerror", (e) => log.push(`[pageerror] ${e.message}`));
await page.goto("https://editor.construct.net/", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#mainMenuButton", { timeout: 60000 });
await page.waitForTimeout(3000);
await page.keyboard.press("Escape");
await page.click("#mainMenuButton");
await page.locator("ui-menuitem[sub-menu]").first().click();
const t0 = Date.now();
const chooserP = page.waitForEvent("filechooser", { timeout: 10000 }).catch((e) => e as Error);
await page.locator(`ui-menuitem[title="${mode === "folder" ? "Choose a folder-based project on this device to open." : "Choose a file on this device to open."}"]`).click();
const chooser = await chooserP;
if (chooser instanceof Error) { console.log("NO FILECHOOSER:", chooser.message); }
else {
  console.log("filechooser fired; isMultiple:", chooser.isMultiple());
  await chooser.setFiles(path.resolve(target));
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(2500);
    const s = await page.evaluate(() => ({
      title: document.title,
      dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => `${d.id}: ${(d as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 160)}`),
      projectBar: (document.querySelector("#projectBar, [id*=project i][class*=tree i], ui-treeview") as HTMLElement | null)?.innerText.replace(/\s+/g, " ").slice(0, 120) ?? null,
    }));
    console.log(`+${Date.now() - t0}ms`, JSON.stringify(s));
  }
}
await page.screenshot({ path: `reports/spike-open-${mode}.png` });
console.log(log.filter((l) => !/Stop!|scam|developer tools/.test(l)).slice(-25).join("\n"));
await ctx.close();
