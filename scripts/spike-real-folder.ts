// Spike: can the page get a real handle to a folder on disk, without copying it?
// A: CDP Input.dispatchDragEvent with a real path → dataTransfer.items[0].getAsFileSystemHandle()
// B: showDirectoryPicker answered through Playwright's filechooser.
import { chromium } from "playwright";
const dir = process.argv[2];
const headed = process.argv.includes("--headed");
const PAGE = `<!doctype html><button id=pick>pick</button><script>
window.__log = [];
const log = (...a) => { window.__log.push(a.join(" ")); };
async function probe(h) {
  log("kind", h.kind, "name", h.name, "isFSDH", h instanceof FileSystemDirectoryHandle);
  const names = []; for await (const [n] of h.entries()) names.push(n); log("entries", names.join(","));
  log("perm read", await h.queryPermission({ mode: "read" }), "readwrite", await h.queryPermission({ mode: "readwrite" }));
  try { const f = await (await h.getFileHandle("project.c3proj")).getFile(); log("read", await f.text()); } catch (e) { log("read err", e.name, e.message); }
  try { const w = await (await h.getFileHandle("written-by-page.txt", { create: true })).createWritable(); await w.write("hi"); await w.close(); log("write ok"); } catch (e) { log("write err", e.name, e.message); }
  window.__done = true;
}
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const items = [...e.dataTransfer.items];
  log("drop items", items.length, items.map((i) => i.kind + ":" + i.type).join(","), "files", e.dataTransfer.files.length);
  try { const h = await items[0].getAsFileSystemHandle(); if (!h) { log("handle null"); window.__done = true; return; } await probe(h); }
  catch (err) { log("handle err", err.name, err.message); window.__done = true; }
});
document.getElementById("pick").onclick = async () => {
  try { await probe(await showDirectoryPicker({ mode: "readwrite" })); } catch (e) { log("picker err", e.name, e.message); window.__done = true; }
};
</script>`;
const browser = await chromium.launch({ headless: !headed });
for (const route of ["drag", "picker"]) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("https://spike.c3cli.test/**", (r) => r.fulfill({ contentType: "text/html", body: PAGE }));
  await page.goto("https://spike.c3cli.test/");
  if (route === "drag") {
    const cdp = await context.newCDPSession(page);
    const data = { items: [], files: [dir], dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) await cdp.send("Input.dispatchDragEvent", { type, x: 200, y: 200, data } as any).catch((e) => console.log("cdp", type, e.message));
  } else {
    page.on("filechooser", async (fc) => { console.log("filechooser fired, directory:", (fc as any).isMultiple?.()); await fc.setFiles(dir).catch((e) => console.log("setFiles", e.message)); });
    await page.click("#pick");
  }
  await page.waitForFunction(() => (window as any).__done, null, { timeout: 5000 }).catch(() => console.log("(timeout)"));
  console.log(`--- ${route}\n` + (await page.evaluate(() => (window as any).__log.join("\n"))));
  await context.close();
}
await browser.close();
