// Spike: find the login form. Types nothing; just inspects.
import { launch, loadEditor } from "../src/editor.ts";
import { resolveBranch } from "../src/release.ts";

const s = await launch({ headed: false });
const page = s.page;
await loadEditor(page, await resolveBranch("stable"), 60000);
await page.click("#mainMenuButton");
const account = page.locator("ui-menuitem[sub-menu]", { hasText: "Account" }).first();
await account.click();
await page.waitForTimeout(500);
console.log("ACCOUNT MENU:", await page.evaluate(() => [...document.querySelectorAll("ui-menuitem")].filter((e) => (e as HTMLElement).offsetParent).map((e) => `${(e as HTMLElement).innerText.trim().split("\n")[0]} | ${e.getAttribute("title") ?? ""}`).slice(-8)));
const popupP = s.context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
await page.locator("ui-menuitem", { hasText: /^Log in$/ }).first().click();
await page.waitForTimeout(4000);
const popup = await popupP;
console.log("POPUP:", popup?.url() ?? null);
console.log("DIALOGS:", await page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => d.id + ": " + (d as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 200))));
console.log("FRAMES:", page.frames().map((f) => f.url()).filter((u) => u && u !== "about:blank"));
for (const f of page.frames()) {
  const inputs = await f.evaluate(() => [...document.querySelectorAll("input, button[type=submit], form")].map((i) => `${i.tagName}#${i.id}[name=${i.getAttribute("name")}][type=${i.getAttribute("type")}][autocomplete=${i.getAttribute("autocomplete")}]`)).catch(() => []);
  if (inputs.length) console.log("FRAME", f.url(), "\n  " + inputs.slice(0, 20).join("\n  "));
}
console.log("USER LABEL:", await page.evaluate(() => [...document.querySelectorAll("*")].filter((e) => e.childElementCount === 0 && /^(Guest|Free edition)$/.test((e as HTMLElement).innerText?.trim() ?? "")).map((e) => `${e.tagName}#${e.id}.${(e as HTMLElement).className} parent=#${e.parentElement?.id}.${e.parentElement?.className}`)));
const frame = page.frames().find((f) => f.url().startsWith("https://account.construct.net/login"))!;
// One deliberately fake attempt: made-up user, not a real password.
await frame.fill("#username", "c3cli-nonexistent-test-user-0923");
await frame.fill("#password", "definitely-not-a-real-password");
await frame.click("#login");
await page.waitForTimeout(5000);
const f2 = page.frames().find((f) => f.url().startsWith("https://account.construct.net/"));
console.log("FRAME AFTER:", f2?.url());
console.log("ERROR TEXT:", await f2?.evaluate(() => [...document.querySelectorAll("[class*=error i], [id*=error i], .validation, .alert, [role=alert]")].map((e) => `${e.tagName}#${e.id}.${(e as HTMLElement).className}: ${(e as HTMLElement).innerText.trim().slice(0, 150)}`)).catch((e) => e.message));
await page.screenshot({ path: "reports/spike-login.png" });
await s.close();
