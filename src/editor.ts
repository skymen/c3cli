// Drive the hosted editor: launch a browser profile, load a release, click through its menus,
// and save with it. Projects get into the editor by dropping their real path on it, and the
// editor writes them back through the bridge (src/bridge.ts, tasks/open-project.md).
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Release } from "./release.ts";
import { BRIDGE_SCRIPT, type Bridge, type Root } from "./bridge.ts";

// Thrown when the requested release doesn't exist: a usage error, not an editor failure.
export class ReleaseNotFound extends Error {}


export interface Session { context: BrowserContext; page: Page; cdpUrl: string | null; close(): Promise<void> }

// Without `profile`, each run gets a fresh temporary profile that is deleted on close:
// no leftover addons, recovery prompts or settings between runs.
// With `cdp`, Chromium also listens on a random local DevTools port so other processes
// (daemon clients) can drive its pages; the URL is read from DevToolsActivePort.
export async function launch(opts: { profile?: string; headed: boolean; cdp?: boolean; locale?: string }): Promise<Session> {
  const temp = opts.profile ? null : await mkdtemp(path.join(os.tmpdir(), "c3cli-profile-"));
  const userDataDir = opts.profile ?? temp!;
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !opts.headed,
    viewport: { width: 1400, height: 900 },
    // A fresh profile takes the editor's language from the browser's; a profile where
    // someone picked a language in C3's settings keeps it.
    locale: opts.locale ?? "en-US",
    args: opts.cdp ? ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"] : [],
  });
  await context.addInitScript(BRIDGE_SCRIPT);
  const page = context.pages()[0] ?? (await context.newPage());
  let cdpUrl: string | null = null;
  if (opts.cdp) {
    const [port] = (await readFile(path.join(userDataDir, "DevToolsActivePort"), "utf8")).split("\n");
    cdpUrl = `http://127.0.0.1:${port.trim()}`;
  }
  return {
    context, page, cdpUrl,
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

// The progress dialog covers the page while the editor works (saving, loading); a menu
// click during it times out.
async function waitForProgress(page: Page, timeoutMs = 60_000) {
  await page.waitForFunction(() => !document.querySelector("#progressDialog[open]"), null, { timeout: timeoutMs, polling: 250 }).catch(() => {});
}

// Click Menu → <item>, a top-level item picked by its title attribute (Settings…).
export async function clickMainMenuItem(page: Page, title: string): Promise<void> {
  await waitForProgress(page);
  await page.click("#mainMenuButton");
  await page.waitForTimeout(300);
  await page.locator(`ui-menuitem[title="${title}"]`).click();
}

// Click Menu → Project → <item>, the item picked by its title attribute.
export async function clickProjectMenuItem(page: Page, title: string): Promise<void> {
  await waitForProgress(page);
  await page.click("#mainMenuButton");
  await page.locator("ui-menuitem[sub-menu]").first().click();
  // The submenu animates in; a click during the animation is silently dropped.
  await page.waitForTimeout(500);
  await page.locator(`ui-menuitem[title="${title}"]`).click();
}

// Click Menu → Project → <submenu> → <item>, the submenu by its label and the item by title.
export async function clickProjectSubmenuItem(page: Page, submenu: string, title: string): Promise<void> {
  await waitForProgress(page);
  await page.click("#mainMenuButton");
  await page.locator("ui-menuitem[sub-menu]").first().click();
  await page.waitForTimeout(500);
  const labels = await page.locator("ui-menuitem[sub-menu]").evaluateAll((els) =>
    els.map((e) => ((e as HTMLElement).offsetParent ? (e as HTMLElement).innerText.trim().split("\n")[0] : "")));
  const index = labels.indexOf(submenu);
  if (index < 0) throw new Error(`no "${submenu}" submenu in the Project menu`);
  await page.locator("ui-menuitem[sub-menu]").nth(index).click();
  await page.waitForTimeout(500);
  await page.locator(`ui-menuitem[title="${title}"]`).click();
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

// Menu → Project → New (`title` is its tooltip), then Create in the New project dialog with
// C3's defaults and `name`. Resolves once the window title is one of `titles`.
export async function newProjectInEditor(page: Page, title: string, name: string, titles: string[], timeoutMs: number): Promise<void> {
  await dismissDialogs(page);
  await clickProjectMenuItem(page, title);
  await page.waitForSelector("#newProjectDialog[open]", { timeout: 10_000 });
  await page.fill("#newProjectDialog #npProjectNameInput", name);
  await page.click("#newProjectDialog .okButton");
  await page.waitForFunction(({ titles, name }) => titles.includes(document.title) || document.title.startsWith(`${name} - Construct 3 `), { titles, name }, { timeout: timeoutMs })
    .catch(() => { throw new Error(`the editor did not show the new project "${name}"`); });
}

// Trigger the editor's own save (Ctrl/Cmd+S). Where the writes land (in place, a mirror
// copy) is set on the bridge beforehand. Resolves with the files written, once writes stop
// for quietMs.
export async function saveInEditor(page: Page, bridge: Bridge, timeoutMs: number, quietMs = 1500): Promise<string[]> {
  await dismissDialogs(page);
  const since = Date.now();
  await page.keyboard.press("ControlOrMeta+s");
  if (!(await bridge.quiet(since, timeoutMs, quietMs))) {
    const dialog = await openDialogText(page);
    throw new Error(`the editor did not write anything after Ctrl/Cmd+S${dialog ? ` (${dialog})` : ""}`);
  }
  return bridge.changedSince(since);
}

// Menu → Project → Save as → <item>, answered with `target` (a new root caught by the
// bridge). Unlike Ctrl+S, which only rewrites files C3 considers changed, this writes every
// file from what the editor holds in memory. Afterwards the editor's project is `target`.
// Resolves with the files written, once writes stop for quietMs.
export async function saveAsInEditor(page: Page, bridge: Bridge, target: Root, menu: { submenu: string; title: string }, timeoutMs: number, quietMs = 1500): Promise<string[]> {
  await dismissDialogs(page);
  const since = Date.now();
  try {
    await clickProjectSubmenuItem(page, menu.submenu, menu.title);
  } catch {
    // Once more, after whatever was in the way (seen with several tabs: a late dialog).
    await dismissDialogs(page);
    await clickProjectSubmenuItem(page, menu.submenu, menu.title);
  }
  // A fresh profile gets a "Set up backups" nag before the picker: "Save anyway".
  const nag = async () => { await page.click("#confirmDialog[open] .cancelConfirmButton", { timeout: 200 }).catch(() => {}); };
  if (!(await bridge.quiet(since, timeoutMs, quietMs, nag))) {
    const dialog = await openDialogText(page);
    throw new Error(`the editor wrote nothing after Save as${dialog ? ` (${dialog})` : ""}`);
  }
  return bridge.changedSince(since, target);
}

async function openDialogText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const d = document.querySelector("dialog[open]:not(#progressDialog)") as HTMLElement | null;
    return d ? `${d.id}: ${d.innerText.replace(/\s+/g, " ").trim().slice(0, 200)}` : null;
  }).catch(() => null);
}
