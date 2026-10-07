// Install addons (.c3addon files) that a project uses but doesn't bundle, the way a user
// does: View → Addon manager → Install new addon…, confirm each install, then reload the
// editor. They live in the browser profile. Not by dropping them:
// the editor's drop handler skips legacy SDK v1 plugins and behaviors without a word.
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { clickMainSubmenuItem } from "./editor.ts";
import { matchLangKey, type EditorText } from "./lang.ts";
import { parseBundledAddon } from "./observe.ts";
import { readZipEntry } from "./project.ts";
import { unzipProject } from "./unzip.ts";

export interface AddonFile {
  file: string;
  // From the addon's addon.json.
  id: string | null;
  name: string | null;
  version: string | null;
  type: string | null;
}

export interface AddonResult extends AddonFile {
  // updated: it was installed already (any version) and has been replaced; refused: the
  // editor wouldn't install it (e.g. an SDK v1 addon after r449); unknown: no answer from
  // the editor about this file.
  outcome: "installed" | "updated" | "refused" | "unknown";
  message?: string;
  langKey?: string | null;
}

// The .c3addon files in `paths`: files, folders (searched recursively) and zips of them.
// Zips are extracted to a temporary folder; call cleanup() when done.
export async function collectAddons(paths: string[]): Promise<{ addons: AddonFile[]; cleanup(): Promise<void> }> {
  const temps: string[] = [];
  const found: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.toLowerCase().endsWith(".c3addon")) found.push(p);
    }
  };
  try {
    for (const p of paths.map((x) => path.resolve(x))) {
      const st = await stat(p).catch(() => null);
      if (!st) throw new Error(`no such addon file or folder: ${p}`);
      if (st.isDirectory()) await walk(p);
      else if (p.toLowerCase().endsWith(".c3addon")) found.push(p);
      else if (p.toLowerCase().endsWith(".zip")) {
        const dir = await mkdtemp(path.join(os.tmpdir(), "c3cli-addons-"));
        temps.push(dir);
        await unzipProject(p, dir);
        await walk(dir);
      } else throw new Error(`not a .c3addon, folder or .zip: ${p}`);
    }
    if (!found.length) throw new Error(`no .c3addon files in ${paths.join(", ")}`);
    const addons = await Promise.all(found.map(async (file): Promise<AddonFile> => {
      const json = await readZipEntry(file, "addon.json").then((s) => (s ? JSON.parse(s.replace(/^\uFEFF/, "")) : null)).catch(() => null);
      return { file, id: json?.id ?? null, name: json?.name ?? null, version: json?.version ?? null, type: json?.type ?? null };
    }));
    return { addons, cleanup: async () => { for (const d of temps) await rm(d, { recursive: true, force: true }); } };
  } catch (e) {
    for (const d of temps) await rm(d, { recursive: true, force: true });
    throw e;
  }
}

// Pick the addons in the Addon manager and answer the editor's dialogs: one install prompt
// per addon (or a refusal), then "install finished". The editor handles them in the order
// given. Reload the editor afterwards to use them.
export async function installAddons(page: Page, text: EditorText, addons: AddonFile[], timeoutMs: number): Promise<AddonResult[]> {
  const results: (AddonResult | null)[] = addons.map(() => null);
  // The first file without an answer yet, preferring one that matches what the editor shows.
  const next = (match: (a: AddonFile) => boolean) => {
    const open = addons.map((a, i) => i).filter((i) => !results[i]);
    return open.find((i) => match(addons[i])) ?? open[0];
  };
  const finished = text.t("ui.dialogs.addonManager.install-confirmation.message");
  await clickMainSubmenuItem(page, text.t("main-menu.view-menu.menu-name"), text.t("main-menu.view-menu.addon-manager"));
  await page.waitForSelector("#addonManagerDialog[open]", { timeout: 10_000 });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 10_000 }), page.click("#addonManagerDialog .installAddon")]);
  await chooser.setFiles(addons.map((a) => a.file));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const d = await page.evaluate(() => {
      const el = document.querySelector("dialog[open]:not(#progressDialog):not(#addonManagerDialog)") as HTMLElement | null;
      if (!el) return null;
      const lines = el.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
      return { id: el.id, body: lines.slice(1).join("\n"), shown: el.innerText };
    });
    if (!d) continue;
    if (d.id === "addonConfirmInstallDialog") {
      const shown = parseBundledAddon(d.body, true, text);
      const same = (a: AddonFile) => a.name === shown.name && a.version === shown.version;
      // An update, once confirmed, may still get an install prompt: it's that file's.
      if (!addons.some((a, i) => results[i]?.outcome === "updated" && same(a))) {
        const i = next(same);
        if (i !== undefined) results[i] = { ...addons[i], outcome: "installed" };
      }
      await page.click("#addonConfirmInstallDialog .okButton");
    } else {
      const body = d.body.replace(/\s+/g, " ");
      const done = body.includes(finished);
      const langKey = done ? null : matchLangKey(text.templates, body);
      if (langKey === "ui.update-addon-prompt.message") {
        // "This addon has already been installed… Would you like to update it?": yes, the
        // file given is the one wanted. The prompt names versions, not the id.
        const i = next((a) => !!a.version && body.includes(a.version));
        if (i !== undefined) results[i] = { ...addons[i], outcome: "updated", message: body.slice(0, 300), langKey };
        await page.click(`#${d.id} .confirmButton`).catch(() => page.keyboard.press("Escape"));
      } else {
        if (!done) {
          const i = next((a) => !!a.id && body.includes(a.id));
          if (i !== undefined) results[i] = { ...addons[i], outcome: "refused", message: body.slice(0, 300), langKey };
        }
        await page.click(`#${d.id} .okButton`).catch(() => page.keyboard.press("Escape"));
        if (done) break;
      }
    }
    // The editor reuses the dialog for the next addon: wait until it's closed or shows something else.
    await page.waitForFunction(({ id, shown }) => (document.querySelector(`#${id}[open]`) as HTMLElement | null)?.innerText !== shown, d, { timeout: 5000 }).catch(() => {});
  }
  await page.click("#addonManagerDialog .okButton", { timeout: 5000 }).catch(() => {});
  return addons.map((a, i) => results[i] ?? { ...a, outcome: "unknown" as const });
}
