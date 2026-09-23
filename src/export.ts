// Web (HTML5) export through the editor's own export wizard, captured as a download.
import { writeFile } from "node:fs/promises";
import type { Page } from "playwright";
import { dismissDialogs, clickProjectMenuItem } from "./editor.ts";

export const MINIFY_MODES = ["none", "bundle", "simple", "advanced", "debug-advanced"] as const;
export const LOSSLESS_FORMATS = ["png", "webp"] as const;
export const LOSSY_FORMATS = ["jpeg", "webp", "avif"] as const;

// Only options that are set get changed; the rest keep the editor's (per-project) defaults.
export interface ExportOptions {
  minify?: (typeof MINIFY_MODES)[number];
  offline?: boolean;
  lossless?: (typeof LOSSLESS_FORMATS)[number];
  lossy?: (typeof LOSSY_FORMATS)[number];
}

export type ExportOutcome = "exported" | "refused-by-edition" | "export-failed";

export interface ExportResult {
  outcome: ExportOutcome;
  zipPath: string | null;
  suggestedName: string | null;
  reportText: string | null;
  dialogs: { id: string; text: string }[];
  error?: string;
}

const CHUNK = 8 * 1024 * 1024;

// Fetch a blob: URL inside the page and copy it out in base64 chunks.
async function readBlob(page: Page, href: string): Promise<Buffer> {
  const size = await page.evaluate(async (href) => {
    const buf = await (await fetch(href)).arrayBuffer();
    (window as any).__c3cliBlob = new Uint8Array(buf);
    return buf.byteLength;
  }, href);
  const parts: Buffer[] = [];
  for (let at = 0; at < size; at += CHUNK) {
    const b64 = await page.evaluate(({ at, n }) => {
      const bytes: Uint8Array = (window as any).__c3cliBlob.subarray(at, at + n);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }, { at, n: CHUNK });
    parts.push(Buffer.from(b64, "base64"));
  }
  await page.evaluate(() => { delete (window as any).__c3cliBlob; });
  return Buffer.concat(parts);
}

const EXPORT_TITLE = "Export the project for publishing to a platform.";

export async function exportWeb(page: Page, opts: ExportOptions, zipPath: string, timeoutMs: number): Promise<ExportResult> {
  const r: ExportResult = { outcome: "export-failed", zipPath: null, suggestedName: null, reportText: null, dialogs: [] };
  const openDialogs = () => page.evaluate(() =>
    [...document.querySelectorAll("dialog[open]")].map((d) => ({ id: d.id, text: (d as HTMLElement).innerText.trim() })));
  // Wait for one of the expected dialogs; anything else that shows up is an unexpected stop.
  const waitFor = async (ids: string[], ms: number): Promise<string> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const open = await openDialogs();
      const hit = open.find((d) => ids.includes(d.id));
      if (hit) return hit.id;
      const stray = open.find((d) => !["progressDialog", "exportSelectPlatformDialog", "exportStandardOptionsDialog"].includes(d.id));
      if (stray) { r.dialogs.push(stray); return stray.id; }
      await page.waitForTimeout(250);
    }
    throw new Error(`timed out waiting for ${ids.join(" or ")}`);
  };

  try {
    await dismissDialogs(page);
    await clickProjectMenuItem(page, EXPORT_TITLE);
    await waitFor(["exportSelectPlatformDialog"], 10_000);
    // Platform tiles carry no id or data attribute; the English label is the only handle.
    await page.locator("#exportSelectPlatformDialog ui-iconviewitem", { hasText: "Web (HTML5)" }).first().click();
    await page.click("#exportSelectPlatformDialog .nextButton");

    const next = await waitFor(["exportStandardOptionsDialog", "freeEditionLimitDialog"], 15_000);
    if (next === "freeEditionLimitDialog") {
      r.dialogs.push(...(await openDialogs()).filter((d) => d.id === next));
      await page.click("#freeEditionLimitDialog .cancelButton").catch(() => {});
      return { ...r, outcome: "refused-by-edition" };
    }
    if (next !== "exportStandardOptionsDialog") return { ...r, error: `unexpected dialog: ${next}` };

    const d = "#exportStandardOptionsDialog";
    await page.selectOption(`${d} #exportTo`, "zip");
    if (opts.minify) await page.selectOption(`${d} #exportMinifyMode`, opts.minify);
    if (opts.lossless) await page.selectOption(`${d} #exportLosslessImageFormat`, opts.lossless);
    if (opts.lossy) await page.selectOption(`${d} #exportLossyImageFormat`, opts.lossy);
    if (opts.offline !== undefined) await page.setChecked(`${d} #exportOfflineSupport`, opts.offline);
    await page.click(`${d} .nextButton`);

    const done = await waitFor(["webExportReportDialog"], timeoutMs);
    // Paid-only options (e.g. any minify mode) raise the same limit dialog here.
    if (done === "freeEditionLimitDialog") {
      await page.click("#freeEditionLimitDialog .cancelButton").catch(() => {});
      return { ...r, outcome: "refused-by-edition" };
    }
    if (done !== "webExportReportDialog") return { ...r, error: `export stopped at dialog ${done}` };
    r.reportText = (await openDialogs()).find((x) => x.id === done)?.text ?? null;

    // The download link is a blob: URL. Read it from the page directly instead of going
    // through a download, which also works when the page is driven over CDP (daemon).
    const link = page.locator("#webExportReportDialog a.downloadExportedProject");
    const [href, name] = await Promise.all([link.getAttribute("href"), link.getAttribute("download")]);
    if (!href) return { ...r, error: "the export report has no download link" };
    await writeFile(zipPath, await readBlob(page, href));
    await page.click("#webExportReportDialog .okButton").catch(() => {});
    return { ...r, outcome: "exported", zipPath, suggestedName: name };
  } catch (e) {
    r.dialogs.push(...(await openDialogs().catch(() => [])));
    return { ...r, error: (e as Error).message.split("\n")[0] };
  }
}
