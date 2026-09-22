// Spike: inspect the welcome dialog and main menu DOM on the hosted editor.
import { chromium } from "playwright";

const ctx = await chromium.launchPersistentContext("/tmp/c3cli-spike-profile", { headless: true, viewport: { width: 1400, height: 900 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://editor.construct.net/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
const info = await page.evaluate(() => {
  const d = document.querySelector("dialog[open]") as HTMLElement | null;
  return {
    url: location.href,
    dialog: d && { id: d.id, cls: d.className, buttons: [...d.querySelectorAll("button, ui-button, [role=button]")].map((b) => ({ id: b.id, cls: (b as HTMLElement).className, text: (b as HTMLElement).innerText.trim() })) },
    menuCandidates: [...document.querySelectorAll("[id*=menu i], [class*=menu i]")].slice(0, 15).map((e) => ({ tag: e.tagName, id: e.id, cls: (e as HTMLElement).className, text: (e as HTMLElement).innerText?.trim().slice(0, 40) })),
  };
});
console.log(JSON.stringify(info, null, 1));
await ctx.close();
