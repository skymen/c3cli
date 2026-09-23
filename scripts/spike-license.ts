// Spike: watch the account/license labels after load, then open Account → View details.
// Uses an existing logged-in profile; types no credentials.
import { launch, loadEditor } from "../src/editor.ts";
import { readAccount } from "../src/login.ts";
import { resolveBranch } from "../src/release.ts";

const profile = process.argv[2];
const s = await launch({ profile, headed: false });
const page = s.page;
const logs: string[] = [];
page.on("console", (m) => { if (/licen|account|login|auth|subscri/i.test(m.text())) logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`); });
page.on("response", (r) => { if (/account\.construct\.net|api\.construct|licen/i.test(r.url())) logs.push(`[http ${r.status()}] ${r.url().replace(/\?.*/, "")}`); });
await loadEditor(page, await resolveBranch("stable"), 60000);
let last = "";
for (let i = 0; i < 40; i++) {
  const a = await readAccount(page);
  const cur = `${a.name} / ${a.license}`;
  if (cur !== last) { console.log(`t+${(i * 0.5).toFixed(1)}s  ${cur}`); last = cur; }
  await page.waitForTimeout(500);
}
await page.click("#mainMenuButton");
await page.locator("ui-menuitem[sub-menu]", { hasText: "Account" }).first().click();
await page.waitForTimeout(500);
await page.locator("ui-menuitem", { hasText: /^View details$/ }).first().click();
await page.waitForTimeout(3000);
console.log("DETAILS:", await page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => d.id + ": " + (d as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 900))));
console.log(logs.slice(0, 30).join("\n"));
await s.close();
