// Spike: open via the real menu items, with the pickers shimmed to return OPFS handles
// that we pre-fill with the project. usage: tsx scripts/spike-opfs.ts file|folder <path>
import { chromium } from "playwright";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const [mode, target] = process.argv.slice(2);

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p, base))); else out.push(path.relative(base, p));
  }
  return out;
}

const ctx = await chromium.launchPersistentContext("/tmp/c3cli-spike-profile", { headless: true, viewport: { width: 1400, height: 900 } });
// Plain string: tsx's keepNames would otherwise inject an undefined __name() into the page.
await ctx.addInitScript(`
  window.__c3cliPick = null; window.__c3cliCalls = [];
  const take = () => { window.__c3cliCalls.push(String(!!window.__c3cliPick)); const h = window.__c3cliPick; window.__c3cliPick = null; if (!h) throw new DOMException("The user aborted a request.", "AbortError"); return h; };
  window.showDirectoryPicker = async () => take();
  window.showOpenFilePicker = async () => [take()];
`);
const page = ctx.pages()[0] ?? (await ctx.newPage());
const log: string[] = [];
page.on("console", (m) => log.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
page.on("pageerror", (e) => log.push(`[pageerror] ${e.message}`));
await page.goto("https://editor.construct.net/", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#mainMenuButton", { timeout: 60000 });
await page.waitForTimeout(3000);
await page.keyboard.press("Escape");

// Stage the project in OPFS.
const runId = `run-${Date.now()}`;
const tStage = Date.now();
if (mode === "folder") {
  const files = await listFiles(target);
  await page.evaluate(async (runId) => {
    const root = await navigator.storage.getDirectory();
    const runs = await root.getDirectoryHandle("c3cli", { create: true });
    (window as any).__c3cliRun = await runs.getDirectoryHandle(runId, { create: true });
  }, runId);
  for (const rel of files) {
    const b64 = (await readFile(path.join(target, rel))).toString("base64");
    await page.evaluate(async ({ rel, b64 }) => {
      let dir: FileSystemDirectoryHandle = (window as any).__c3cliRun;
      const parts = rel.split("/");
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const fh = await dir.getFileHandle(parts.at(-1)!, { create: true });
      const w = await fh.createWritable();
      await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      await w.close();
    }, { rel: rel.split(path.sep).join("/"), b64 });
  }
  await page.evaluate(() => { const w = window as any; w.__c3cliPick = w.__c3cliRun; });
  console.log(`staged ${files.length} files in ${Date.now() - tStage}ms`);
} else {
  const b64 = (await readFile(target)).toString("base64");
  await page.evaluate(async ({ runId, name, b64 }) => {
    const root = await navigator.storage.getDirectory();
    const runs = await root.getDirectoryHandle("c3cli", { create: true });
    const dir = await runs.getDirectoryHandle(runId, { create: true });
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    await w.close();
    (window as any).__c3cliPick = fh;
  }, { runId, name: path.basename(target), b64 });
  console.log(`staged file in ${Date.now() - tStage}ms`);
}

await page.click("#mainMenuButton");
await page.locator("ui-menuitem[sub-menu]").first().click();
await page.waitForTimeout(500);
const t0 = Date.now();
await page.locator(`ui-menuitem[title="${mode === "folder" ? "Choose a folder-based project on this device to open." : "Choose a file on this device to open."}"]`).click();
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(2500);
  const s = await page.evaluate(() => ({
    title: document.title,
    tabs: [...document.querySelectorAll("ui-tab, .tab, [role=tab]")].map((t) => (t as HTMLElement).innerText.trim()).filter(Boolean).slice(0, 8),
    dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => `${d.id}: ${(d as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 200)}`),
    pickLeft: (window as any).__c3cliPick !== null, calls: (window as any).__c3cliCalls,
  }));
  console.log(`+${Date.now() - t0}ms`, JSON.stringify(s));
}
await page.screenshot({ path: `reports/spike-opfs-${mode}.png` });
console.log(log.filter((l) => !/Stop!|scam|developer tools|Registered|sandboxing|autofocusing/.test(l)).slice(-25).join("\n"));
await ctx.close();
