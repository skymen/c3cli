// Web (HTML5) export through the editor's own export wizard, captured as a download.
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

    const dlP = page.waitForEvent("download", { timeout: 15_000 });
    await page.click("#webExportReportDialog a.downloadExportedProject");
    const dl = await dlP;
    await dl.saveAs(zipPath);
    await page.click("#webExportReportDialog .okButton").catch(() => {});
    return { ...r, outcome: "exported", zipPath, suggestedName: dl.suggestedFilename() };
  } catch (e) {
    r.dialogs.push(...(await openDialogs().catch(() => [])));
    return { ...r, error: (e as Error).message.split("\n")[0] };
  }
}
