// Spike: dismiss welcome, open main menu, dump items (and the Project submenu).
import { chromium } from "playwright";

const ctx = await chromium.launchPersistentContext("/tmp/c3cli-spike-profile", { headless: true, viewport: { width: 1400, height: 900 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://editor.construct.net/", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#mainMenuButton", { timeout: 60000 });
await page.waitForTimeout(3000);
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
console.log("dialog after Esc:", await page.evaluate(() => document.querySelector("dialog[open]")?.id ?? null));
const dump = () => page.evaluate(() =>
  [...document.querySelectorAll("ui-menuitem, .menuItem, [role=menuitem], ui-menu li, li")]
    .filter((e) => (e as HTMLElement).offsetParent)
    .map((e) => ({ tag: e.tagName, id: e.id, cls: (e as HTMLElement).className, attrs: [...e.attributes].map((a) => `${a.name}=${a.value}`).join(" ").slice(0, 120), text: (e as HTMLElement).innerText.trim().split("\n")[0] })));
await page.click("#mainMenuButton");
await page.waitForTimeout(800);
console.log("MAIN", JSON.stringify(await dump(), null, 0));
await page.locator("ui-menuitem[sub-menu]").first().click();
await page.waitForTimeout(800);
console.log("PROJECT", JSON.stringify(await dump(), null, 0));
await page.screenshot({ path: "reports/spike-menu.png" });
await ctx.close();
