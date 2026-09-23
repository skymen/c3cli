// Watch the editor after an open: collect console/page errors and dialogs, and decide the
// outcome from layered signals (dialog DOM, window title), never from timing alone.
import type { Page } from "playwright";
import { matchLangKey, loadLang } from "./lang.ts";

export type Outcome =
  | "opened"
  | "missing-addons"
  | "refused-newer-release"
  | "refused-by-edition"
  | "refused"
  | "crashed"
  | "timeout";

export interface DialogInfo { id: string; langKey: string | null; title: string; body: string; buttons: string[] }

export interface MissingAddon { type: string; name: string; id: string; author: string | null }

export interface BundledAddon { name: string | null; version: string | null; type: string | null; author: string | null; installed: boolean }

export interface Collector { log: string[]; consoleErrors: string[]; pageErrors: string[] }

const NOISE = /^%c|Registered (root )?service worker|sandbox attribute can escape|Blocked autofocusing/;

export function collect(page: Page): Collector {
  const c: Collector = { log: [], consoleErrors: [], pageErrors: [] };
  page.on("console", (m) => {
    const text = m.text();
    if (NOISE.test(text)) return;
    if (m.type() === "error") c.consoleErrors.push(text);
    else c.log.push(`[${m.type()}] ${text}`);
  });
  page.on("pageerror", (e) => c.pageErrors.push(e.stack ?? e.message));
  return c;
}

// Dialogs that come and go on their own and never block an open.
const TRANSIENT = ["progressDialog"];

async function readDialogs(page: Page): Promise<Omit<DialogInfo, "langKey">[]> {
  return page.evaluate((transient) =>
    [...document.querySelectorAll("dialog[open]")].filter((d) => !transient.includes(d.id)).map((d) => {
      const lines = (d as HTMLElement).innerText.split("\n").map((l) => l.trim()).filter(Boolean);
      const buttons = [...d.querySelectorAll("button, ui-button")].map((b) => (b as HTMLElement).innerText.trim()).filter(Boolean);
      const body = lines.slice(1).filter((l) => !buttons.includes(l)).join("\n");
      return { id: d.id, title: lines[0] ?? "", body, buttons };
    }), TRANSIENT);
}

function classify(d: DialogInfo): Outcome {
  if (d.id === "missingAddonsDialog") return "missing-addons";
  const key = d.langKey ?? "";
  if (key.includes("saved-in-newer-release")) return "refused-newer-release";
  if (d.id.toLowerCase().includes("freeeditionlimit") || key.includes("freeEditionLimit")) return "refused-by-edition";
  return "refused";
}

// Several dialogs can stack up; the most specific reason wins over a generic refusal.
const PRIORITY: Outcome[] = ["refused-newer-release", "refused-by-edition", "missing-addons", "refused"];
function worst(dialogs: DialogInfo[]): Outcome {
  const outcomes = dialogs.map(classify);
  return PRIORITY.find((o) => outcomes.includes(o)) ?? "refused";
}

// Whole text first; then line by line, for dialogs that append data (addon lists) to a template.
function dialogLangKey(lang: Awaited<ReturnType<typeof loadLang>>, d: Omit<DialogInfo, "langKey">): string | null {
  const lines = d.body.split("\n");
  return matchLangKey(lang, `${d.title} ${d.body}`) ?? matchLangKey(lang, d.body)
    ?? lines.map((l) => matchLangKey(lang, l)).find(Boolean) ?? null;
}

// Lines after the header look like "Effect Foil Effect (dumivid_HolographicFoil) by dumivid".
export function parseMissingAddons(dialogs: DialogInfo[]): MissingAddon[] {
  const d = dialogs.find((x) => x.id === "missingAddonsDialog");
  if (!d) return [];
  return d.body.split("\n").slice(1).flatMap((line) => {
    const m = /^(\S+)\s+(.*?)\s+\(([^)]+)\)(?:\s+by\s+(.+))?$/.exec(line.trim());
    return m ? [{ type: m[1], name: m[2], id: m[3], author: m[4] ?? null }] : [];
  });
}

// The install prompt lists "Name\nSSAOFOG\nVersion\n1.1.1\n…" under its header text.
export function parseBundledAddon(body: string, installed: boolean): BundledAddon {
  const lines = body.split("\n");
  const field = (label: string) => { const i = lines.indexOf(label); return i >= 0 ? lines[i + 1] ?? null : null; };
  return { name: field("Name"), version: field("Version"), type: field("Type"), author: field("Author"), installed };
}

export interface OpenResult { outcome: Outcome; dialogs: DialogInfo[]; bundledAddons: BundledAddon[]; title: string }

// Poll until the project is open (title shows its name) or a dialog blocks the open.
export async function waitForOutcome(page: Page, opts: {
  projectName: string | null; assetUrl: string; timeoutMs: number; settleMs?: number;
  installBundledAddons: boolean;
}): Promise<OpenResult> {
  const lang = await loadLang(opts.assetUrl);
  // Post-open dialogs (deprecated features) appear 25–45 ms after the title changes
  // (measured 2026-09-23); 500 ms leaves a >10× margin.
  const settleMs = opts.settleMs ?? 500;
  const deadline = Date.now() + opts.timeoutMs;
  const startTitle = await page.title();
  const seen = new Map<string, DialogInfo>();
  const snapshot = async () => {
    for (const d of await readDialogs(page)) {
      const k = `${d.id}\n${d.body}`;
      if (!seen.has(k)) seen.set(k, { ...d, langKey: dialogLangKey(lang, d) });
    }
    return { title: await page.title(), open: (await readDialogs(page)).length > 0 };
  };
  // "<name> - Construct 3", with a suffix on some branches ("… - Construct 3 beta").
  const isOpened = (title: string) => opts.projectName
    ? title === `${opts.projectName} - Construct 3` || title.startsWith(`${opts.projectName} - Construct 3 `)
    : title !== startTitle && / - Construct 3( .*)?$/.test(title);

  const bundledAddons: BundledAddon[] = [];
  // Projects can bundle .c3addon files; the editor asks to install each before loading.
  const answerAddonPrompt = async () => {
    const d = (await readDialogs(page)).find((x) => x.id === "addonConfirmInstallDialog");
    if (!d) return false;
    bundledAddons.push(parseBundledAddon(d.body, opts.installBundledAddons));
    await page.click(`#addonConfirmInstallDialog ${opts.installBundledAddons ? ".okButton" : ".cancelButton"}`);
    await page.waitForFunction(() => !document.querySelector("#addonConfirmInstallDialog[open]"), null, { timeout: 5000 }).catch(() => {});
    return true;
  };

  let blockedSince: number | null = null;
  while (Date.now() < deadline) {
    if (await answerAddonPrompt()) { blockedSince = null; continue; }
    const s = await snapshot();
    if (isOpened(s.title)) {
      // Let post-open dialogs (repairs, warnings) show up before reporting.
      await page.waitForTimeout(settleMs);
      const after = await snapshot();
      return { outcome: "opened", dialogs: [...seen.values()], bundledAddons, title: after.title };
    }
    if (s.open) {
      blockedSince ??= Date.now();
      if (Date.now() - blockedSince >= 750) {
        const dialogs = [...seen.values()];
        return { outcome: worst(dialogs), dialogs, bundledAddons, title: s.title };
      }
    } else blockedSince = null;
    await page.waitForTimeout(250);
  }
  return { outcome: "timeout", dialogs: [...seen.values()], bundledAddons, title: await page.title() };
}
