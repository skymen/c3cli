// Drive the hosted editor: launch a browser profile, stage a project in OPFS, and
// open it through the editor's own "Open local file/folder" menu items with the pickers
// shimmed to return the staged handle (see tasks/open-project.md).
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Release } from "./release.ts";
import type { ProjectInfo } from "./project.ts";

// Thrown when the requested release doesn't exist: a usage error, not an editor failure.
export class ReleaseNotFound extends Error {}

// A string, not a function: tsx/esbuild's keepNames wraps named functions in __name(),
// which doesn't exist in the page. The first line also defines it, as a no-op, for every
// page.evaluate that declares a named helper.
const PICKER_SHIM = `
  globalThis.__name = (fn) => fn;
  window.__c3cliPick = null;
  const take = () => {
    const h = window.__c3cliPick;
    window.__c3cliPick = null;
    if (!h) throw new DOMException("The user aborted a request.", "AbortError");
    return h;
  };
  window.showDirectoryPicker = async () => take();
  window.showOpenFilePicker = async () => [take()];
`;

const MENU_TITLES = {
  folder: "Choose a folder-based project on this device to open.",
  file: "Choose a file on this device to open.",
};

const STAGE_BATCH_BYTES = 8 * 1024 * 1024;

export interface Session { context: BrowserContext; page: Page; close(): Promise<void> }

// Without `profile`, each run gets a fresh temporary profile that is deleted on close:
// no leftover addons, recovery prompts or settings between runs.
export async function launch(opts: { profile?: string; headed: boolean }): Promise<Session> {
  const temp = opts.profile ? null : await mkdtemp(path.join(os.tmpdir(), "c3cli-profile-"));
  const context = await chromium.launchPersistentContext(opts.profile ?? temp!, {
    headless: !opts.headed,
    viewport: { width: 1400, height: 900 },
  });
  await context.addInitScript(PICKER_SHIM);
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    context, page,
    close: async () => {
      await context.close();
      if (temp) await rm(temp, { recursive: true, force: true });
    },
  };
}

// Load the editor and get it to an idle start page. Returns the dialogs dismissed on the way.
export async function loadEditor(page: Page, release: Release, timeoutMs: number): Promise<string[]> {
  const res = await page.goto(release.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  if (res && !res.ok()) throw new ReleaseNotFound(`editor release ${release.name} not available (HTTP ${res.status()} for ${release.url})`);
  await page.waitForSelector("#mainMenuButton", { timeout: timeoutMs });
  await page.waitForTimeout(1500);
  return dismissDialogs(page);
}

// Close open dialogs with Escape (modal ones swallow keyboard shortcuts like F5 and
// Ctrl+S). Returns the ids of the dialogs closed.
export async function dismissDialogs(page: Page): Promise<string[]> {
  const dismissed: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = await page.evaluate(() => document.querySelector("dialog[open]")?.id ?? null);
    if (id === null) break;
    dismissed.push(id);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  return dismissed;
}

// Copy the project into OPFS under c3cli/<runId> and arm the picker shim with its handle.
export async function stageProject(page: Page, project: ProjectInfo, runId: string): Promise<number> {
  await page.evaluate(async (runId) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("c3cli", { recursive: true }).catch(() => {});
    const runs = await root.getDirectoryHandle("c3cli", { create: true });
    (window as any).__c3cliRun = await runs.getDirectoryHandle(runId, { create: true });
  }, runId);

  const files = project.kind === "folder"
    ? (await listFiles(project.path)).map((rel) => ({ rel, abs: path.join(project.path, rel) }))
    : [{ rel: path.basename(project.path), abs: project.path }];

  let batch: { rel: string; b64: string }[] = [];
  let batchBytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    await page.evaluate(async (batch) => {
      for (const { rel, b64 } of batch) {
        let dir: FileSystemDirectoryHandle = (window as any).__c3cliRun;
        const parts = rel.split("/");
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        const w = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
        await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        await w.close();
      }
    }, batch);
    batch = [];
    batchBytes = 0;
  };
  for (const f of files) {
    const buf = await readFile(f.abs);
    batch.push({ rel: f.rel.split(path.sep).join("/"), b64: buf.toString("base64") });
    batchBytes += buf.length;
    if (batchBytes >= STAGE_BATCH_BYTES) await flush();
  }
  await flush();

  await page.evaluate(async ({ kind, name }) => {
    const w = window as any;
    w.__c3cliPick = kind === "folder" ? w.__c3cliRun : await w.__c3cliRun.getFileHandle(name);
  }, { kind: project.kind, name: path.basename(project.path) });
  return files.length;
}

// Click Menu → Project → <item>, the item picked by its title attribute.
export async function clickProjectMenuItem(page: Page, title: string): Promise<void> {
  await page.click("#mainMenuButton");
  await page.locator("ui-menuitem[sub-menu]").first().click();
  // The submenu animates in; a click during the animation is silently dropped.
  await page.waitForTimeout(500);
  await page.locator(`ui-menuitem[title="${title}"]`).click();
}

// Click Menu → Project → Open local file/folder. Throws if the editor never asked for a picker.
export async function clickOpen(page: Page, kind: ProjectInfo["kind"]): Promise<void> {
  await clickProjectMenuItem(page, MENU_TITLES[kind]);
  await page.waitForFunction(() => (window as any).__c3cliPick === null, null, { timeout: 5000 }).catch(() => {
    throw new Error("the editor did not ask for a file/folder picker after clicking the open menu item (menu changed?)");
  });
}

export async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p, base)));
    else out.push(path.relative(base, p));
  }
  return out;
}

// lastModified of every staged file, keyed by path relative to the staged project root.
export async function snapshotStaged(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async () => {
    const out: Record<string, number> = {};
    const walk = async (d: FileSystemDirectoryHandle, pre: string) => {
      for await (const [name, h] of (d as any).entries()) {
        if (h.kind === "directory") await walk(h, pre + name + "/");
        else out[pre + name] = (await h.getFile()).lastModified;
      }
    };
    await walk((window as any).__c3cliRun, "");
    return out;
  });
}

// Trigger the editor's own save (Ctrl/Cmd+S). It writes through the handle it was given
// at open time, i.e. into the staged OPFS copy. Resolves once writes stop for quietMs.
export async function saveInEditor(page: Page, timeoutMs: number, quietMs = 1500): Promise<string[]> {
  await dismissDialogs(page);
  const before = await snapshotStaged(page);
  await page.keyboard.press("ControlOrMeta+s");
  const deadline = Date.now() + timeoutMs;
  let last = before, lastChangeAt = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const now = await snapshotStaged(page);
    const moved = Object.keys(now).some((k) => now[k] !== last[k]) || Object.keys(last).some((k) => !(k in now));
    if (moved) { last = now; lastChangeAt = Date.now(); }
    else if (lastChangeAt && Date.now() - lastChangeAt >= quietMs) break;
  }
  if (!lastChangeAt) throw new Error("the editor did not write anything after Ctrl/Cmd+S");
  return Object.keys(last).filter((k) => last[k] !== before[k]).sort();
}

// Copy the staged OPFS project out to disk, one file per evaluate to bound message size.
export async function exportStaged(page: Page, outDir: string): Promise<number> {
  const rels = Object.keys(await snapshotStaged(page));
  for (const rel of rels) {
    const b64: string = await page.evaluate(async (rel) => {
      let dir: FileSystemDirectoryHandle = (window as any).__c3cliRun;
      const parts = rel.split("/");
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      const bytes = new Uint8Array(await (await (await dir.getFileHandle(parts.at(-1)!)).getFile()).arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }, rel);
    const dest = path.join(outDir, ...rel.split("/"));
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(b64, "base64"));
  }
  return rels.length;
}
