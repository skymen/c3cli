// Spike: can a dropped folder handle get write permission (requestPermission, CDP grants)?
import { chromium } from "playwright";
const dir = process.argv[2];
const headed = process.argv.includes("--headed");
const PAGE = `<!doctype html><script>
window.__log = [];
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => { e.preventDefault(); window.__h = await e.dataTransfer.items[0].getAsFileSystemHandle(); });
</script>`;
const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext();
const page = await context.newPage();
await page.route("https://spike.c3cli.test/**", (r) => r.fulfill({ contentType: "text/html", body: PAGE }));
await page.goto("https://spike.c3cli.test/");
const cdp = await context.newCDPSession(page);
for (const name of ["file-system-write", "fileSystemWrite", "file-system", "local-fonts"]) {
  const r = await cdp.send("Browser.setPermission" as any, { permission: { name }, setting: "granted", origin: "https://spike.c3cli.test" }).then(() => "ok", (e: Error) => e.message);
  console.log("Browser.setPermission", name, "->", r);
}
const data = { items: [], files: [dir], dragOperationsMask: 1 };
for (const type of ["dragEnter", "dragOver", "drop"]) await cdp.send("Input.dispatchDragEvent", { type, x: 100, y: 100, data } as any);
await page.waitForFunction(() => (window as any).__h);
const res = await page.evaluate(async () => {
  const h = (window as any).__h;
  const before = await h.queryPermission({ mode: "readwrite" });
  const req = await Promise.race([h.requestPermission({ mode: "readwrite" }).catch((e: Error) => "throws " + e.name + ": " + e.message), new Promise((r) => setTimeout(() => r("no answer in 3 s"), 3000))]);
  return { before, req, after: await h.queryPermission({ mode: "readwrite" }) };
});
console.log(headed ? "headed" : "headless", JSON.stringify(res));
await browser.close();
