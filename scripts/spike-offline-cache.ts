// Spike: what the editor puts in Cache Storage for a release, and when. Usage: tsx scripts/spike-offline-cache.ts <url> [seconds]
import { launch } from "../src/editor.ts";
const [url, secs = "90"] = process.argv.slice(2);
const session = await launch({ headed: false });
const { context: ctx, page } = session;
await page.addInitScript(() => {
  for (const n of ["offline", "root-offline"]) { const c = new BroadcastChannel(n); c.onmessage = (e) => console.log(`[bc ${n}] ${JSON.stringify(e.data)}`); }
});
const t0 = Date.now(), at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
page.on("console", (m) => { if (/\[bc |offline|SW/i.test(m.text())) console.log(at(), m.text().slice(0, 200)); });
ctx.on("serviceworker", (w) => console.log(at(), "sw", w.url()));
const res = await page.goto(url, { waitUntil: "domcontentloaded" });
console.log(at(), "loaded", res?.status(), page.url());
let last = "";
while (Date.now() - t0 < Number(secs) * 1000) {
  const s = JSON.stringify(await page.evaluate(async () => Object.fromEntries(await Promise.all((await caches.keys()).map(async (k) => [k, (await (await caches.open(k)).keys()).length])))).catch((e) => String(e).slice(0, 100)));
  if (s !== last) { console.log(at(), s); last = s; }
  if (Object.entries(JSON.parse(s.startsWith("{") ? s : "{}")).some(([k, n]) => /\/r\d.*-v/.test(k) && Number(n) > 5)) { await page.waitForTimeout(2000); break; }
  await page.waitForTimeout(500);
}
console.log(at(), "end", JSON.stringify(await page.evaluate(async () => Object.fromEntries(await Promise.all((await caches.keys()).map(async (k) => [k, (await (await caches.open(k)).keys()).length])))).catch((e) => String(e).slice(0, 100))));
const odd = await page.evaluate(async () => {
  const out: string[] = [];
  for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) if (/\?|\/$|^(?!https:\/\/editor)/.test(r.url) || !/\/r\d/.test(r.url)) out.push(`${k} ${r.url}`);
  return out;
});
console.log("odd keys:", odd.slice(0, 40));
await session.close();
