// Spike: cold-load the hosted editor, log what it shows, screenshot.
import { chromium } from "playwright";

const profile = process.argv[2] ?? "/tmp/c3cli-spike-profile";
const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1400, height: 900 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on("console", (m) => console.log(`[console.${m.type()}]`, m.text().slice(0, 300)));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
const t0 = Date.now();
await page.goto("https://editor.construct.net/", { waitUntil: "domcontentloaded" });
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(5000);
  const state = await page.evaluate(() => ({
    title: document.title,
    dialogs: [...document.querySelectorAll("dialog[open], .dialog, ui-dialog")].map((d) => (d as HTMLElement).innerText.slice(0, 200)),
    bodyClasses: document.body.className,
  }));
  console.log(`t=${Date.now() - t0}ms`, JSON.stringify(state));
}
await page.screenshot({ path: "reports/spike-load.png" });
await ctx.close();
