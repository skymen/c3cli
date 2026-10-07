// Export through the editor's own export wizard: Web (HTML5), and the desktop, mobile and
// playable-ad platforms (tasks/export-platforms.md). Every platform hands out zips from its
// export report dialog; c3cli reads them out of the page.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { dismissDialogs, clickProjectMenuItem } from "./editor.ts";
import { editorText, type EditorText } from "./lang.ts";
import type { Release } from "./release.ts";

export const MINIFY_MODES = ["none", "bundle", "simple", "advanced", "debug-advanced"] as const;
export const LOSSLESS_FORMATS = ["png", "webp"] as const;
export const LOSSY_FORMATS = ["jpeg", "webp", "avif"] as const;

// c3cli's platform names → the editor's tile (by lang key) and its own options dialog.
// `until`: the last release that has it (NW.js left in r450).
export const PLATFORMS = {
  web: { tile: "exporters.html5.name", dialog: null },
  android: { tile: "exporters.cordova.android.name", dialog: "cordovaOptionsDialog" },
  ios: { tile: "exporters.cordova.ios.name", dialog: "cordovaOptionsDialog" },
  windows: { tile: "exporters.windows-webview2.name", dialog: "wv2OptionsDialog" },
  macos: { tile: "exporters.macos-wkwebview.name", dialog: "macosOptionsDialog" },
  linux: { tile: "exporters.linux-cef.name", dialog: "linuxCefOptionsDialog" },
  nwjs: { tile: "exporters.nwjs.name", dialog: "nwjsOptionsDialog", until: 44999, untilName: "r449 (LTS)" },
  "playable-ad": { tile: "exporters.playable-ad-single-file.name", dialog: null },
  "playable-ad-zip": { tile: "exporters.playable-ad-zip.name", dialog: null },
} as const satisfies Record<string, { tile: string; dialog: string | null; until?: number; untilName?: string }>;

export type Platform = keyof typeof PLATFORMS;
export const PLATFORM_NAMES = Object.keys(PLATFORMS) as Platform[];

export type SettingValue = string | number | boolean | string[];

// Only options that are given get changed; the rest keep what the editor shows (its
// defaults, or with a kept --profile on r488+, the last choices for that project).
export interface ExportOptions {
  // Default "web".
  platform?: Platform;
  minify?: (typeof MINIFY_MODES)[number];
  // Web only.
  offline?: boolean;
  lossless?: (typeof LOSSLESS_FORMATS)[number];
  lossy?: (typeof LOSSY_FORMATS)[number];
  // The platform's own options, by name (exportSettingsHelp() lists them).
  settings?: Record<string, SettingValue>;
  // Go on past the editor's warnings (Confirm dialogs, e.g. Cordova's about an upper-case
  // app ID). Without it they stop the export as `refused`.
  acceptWarnings?: boolean;
}

export type ExportOutcome = "exported" | "refused-by-edition" | "refused" | "export-failed";

export interface ExportOutput { name: string; file: string }

export interface ExportResult {
  outcome: ExportOutcome;
  platform: Platform;
  // What the export report offered for download, written into the output folder.
  outputs: ExportOutput[];
  suggestedName: string | null;
  reportText: string | null;
  dialogs: { id: string; text: string }[];
  // Warnings gone past with acceptWarnings.
  warnings: string[];
  error?: string;
}

// ---- Platform options ------------------------------------------------------------------

// One way an option shows in the dialog, for a range of releases (release numbers, 49502).
type Control = { from?: number; until?: number } & (
  | { kind: "check"; sel: string; on?: string[]; off?: string[] } // on/off, plus named values
  | { kind: "select"; sel: string; values?: Record<string, string>; map?: (v: string) => string } // values: c3cli → option; neither: any option the page lists
  | { kind: "text"; sel: string }
  | { kind: "int"; sel: string; min: number; max: number }
  | { kind: "boxes"; boxes: Record<string, { sel: string; from?: number; until?: number }> } // a list: exactly these checked
  | { kind: "usage"; sel: string } // macOS camera/microphone: a checkbox and its usage text
);

interface SettingDef { help: string; controls: Control[]; inPermissions?: true }

const check = (sel: string, extra: Partial<Control> = {}): Control => ({ kind: "check", sel, ...extra }) as Control;
// "7.1" → "710", "15" → "1500": how the Cordova dialogs number OS versions.
const osVersion = (v: string) => {
  const n = Number(v);
  if (!/^\d+(\.\d)?$/.test(v) || !Number.isFinite(n)) throw new Error(`not a version like 7.1 or 16: ${v}`);
  return String(Math.round(n * 100));
};

const STANDARD: Record<string, SettingDef> = {
  "deduplicate-images": { help: "on/off", controls: [check("#exportDeduplicateImages")] },
  "optimize-images": { help: "on/off", controls: [check("#exportOptimizeImages")] },
};

const cordova = (os: "android" | "ios"): Record<string, SettingDef> => ({
  "min-version": {
    help: os === "android" ? "lowest Android version, 7.0 to 15.0" : "lowest iOS version, 16.0 to 18.0",
    controls: [{ kind: "select", sel: os === "android" ? ".androidVersion select" : ".iosVersion select", map: osVersion }],
  },
  "url-whitelist": { help: "space-separated URL patterns", controls: [{ kind: "text", sel: ".whitelist input" }] },
  ...(os === "android" ? { "version-code": { help: "Android version code, a whole number", controls: [{ kind: "int", sel: ".versionCode input", min: 0, max: 2147483647 } as Control] } } : {}),
  "hide-status-bar": { help: "on/off", controls: [check(".hideStatusBar input")] },
  "vibrate-permission": { help: "on/off", controls: [check(".vibratePermission input")] },
  "camera-permission": { help: "on/off", controls: [check(".cameraPermission input")] },
  "microphone-permission": { help: "on/off", controls: [check(".microphonePermission input")] },
});

const folderAccess = { none: "", read: "read-only", "read-write": "read-write" };

export const PLATFORM_SETTINGS: Record<Platform, Record<string, SettingDef>> = {
  web: {},
  "playable-ad": {},
  "playable-ad-zip": {},
  android: cordova("android"),
  ios: cordova("ios"),
  windows: {
    arch: { help: "architectures, comma-separated: x64, arm64 (x86 on r449 only)", controls: [{ kind: "boxes", boxes: {
      x86: { sel: "#wv2Platformx86", until: 44999 }, x64: { sel: "#wv2Platformx64" }, arm64: { sel: "#wv2PlatformArm64" } } }] },
    bundle: { help: "none, assets, or single-file (r479+); before r479 none or assets", controls: [
      { kind: "select", sel: "#wv2BundleSelect", from: 47900, values: { none: "none", assets: "bundle-assets", "single-file": "single-file" } },
      check("#wv2BundleAssets", { until: 47899, on: ["assets"], off: ["none"] }) ] },
    steam: { help: "none, overlay or capture (r503+); none or overlay (on/off) on r473 to r502", controls: [
      { kind: "select", sel: "#wv2SteamModeSelect", from: 50300, values: { none: "none", overlay: "overlay", capture: "capture" } },
      // The old checkbox is the overlay mode (r505's exporter reads `true` as "overlay").
      check("#wv2SteamMode", { from: 47300, until: 50299, on: ["overlay"], off: ["none"] }) ] },
    devtools: { help: "on/off", controls: [check("#wv2EnableDevTools")] },
    "window-caption": { help: "on/off (r451+)", controls: [check("#wv2WindowCaption", { from: 45100 })] },
    resizable: { help: "on/off", controls: [check("#wv2ResizableWindow")] },
    "ignore-gpu-blacklist": { help: "on/off", controls: [check("#wv2IgnoreGpuBlacklist")] },
    "remote-preview": { help: "on/off: export for Remote Preview", controls: [check("#wv2RemotePreviewMode")] },
    "command-line": { help: "extra command line options", controls: [{ kind: "text", sel: "#wv2CommandLine" }] },
  },
  macos: {
    "app-sandbox": { help: "on/off", controls: [check("#macosUseAppSandbox")] },
    "bundle-assets": { help: "on/off", controls: [check("#macosBundleAssets")] },
    devtools: { help: "on/off", controls: [check("#macosEnableDevTools")] },
    "window-caption": { help: "on/off (r451+)", controls: [check("#macosWindowCaption", { from: 45100 })] },
    resizable: { help: "on/off (r451+)", controls: [check("#macosResizableWindow", { from: 45100 })] },
    "signing-identity": { help: 'e.g. "Developer ID Application: Name (ABC123)"', controls: [{ kind: "text", sel: "#macosSigningIdentity" }] },
    camera: { help: "the usage text shown when asking for the camera, or off", controls: [{ kind: "usage", sel: "#macosAllowCamera" }], inPermissions: true },
    microphone: { help: "the usage text shown when asking for the microphone, or off", controls: [{ kind: "usage", sel: "#macosAllowMicrophone" }], inPermissions: true },
    "internet-server": { help: "on/off", controls: [check("#macosAllowInternetServer")], inPermissions: true },
    "pictures-folder": { help: "none, read or read-write", controls: [{ kind: "select", sel: "#macosAllowPicturesFolder", values: folderAccess }], inPermissions: true },
    "movies-folder": { help: "none, read or read-write", controls: [{ kind: "select", sel: "#macosAllowMoviesFolder", values: folderAccess }], inPermissions: true },
    "downloads-folder": { help: "none, read or read-write", controls: [{ kind: "select", sel: "#macosAllowDownloadsFolder", values: folderAccess }], inPermissions: true },
  },
  linux: {
    version: { help: "CEF version: latest, or one the dialog lists (v147…)", controls: [{ kind: "select", sel: "#linuxCefVersionSelect" }] },
    arch: { help: "architectures, comma-separated: x64, arm64 (arm32 on r449 only)", controls: [{ kind: "boxes", boxes: {
      x64: { sel: "#linuxCefPlatformx64" }, arm64: { sel: "#linuxCefPlatformArm64" }, arm32: { sel: "#linuxCefPlatformArm32", until: 44999 } } }] },
    fullscreen: { help: "on/off: start up fullscreen", controls: [check("#linuxCefStartUpFullscreen")] },
    compress: { help: "on/off: compress the final zip", controls: [check("#linuxCefCompressFinalZip")] },
    "bundle-assets": { help: "on/off", controls: [check("#linuxCefBundleAssets")] },
    devtools: { help: "on/off", controls: [check("#linuxCefEnableDevTools")] },
    "window-caption": { help: "on/off (r452+)", controls: [check("#linuxCefWindowCaption", { from: 45200 })] },
    resizable: { help: "on/off (r452+)", controls: [check("#linuxCefResizableWindow", { from: 45200 })] },
  },
  nwjs: {
    version: { help: "NW.js version: latest, or one the dialog lists (v0.100.1…)", controls: [{ kind: "select", sel: "#nwjsVersionSelect" }] },
    arch: { help: "platforms, comma-separated: linux32, linux64, mac64, mac-arm64, win32, win64", controls: [{ kind: "boxes", boxes: {
      linux32: { sel: "#nwjsPlatformLinux32" }, linux64: { sel: "#nwjsPlatformLinux64" }, mac64: { sel: "#nwjsPlatformMac64" },
      "mac-arm64": { sel: "#nwjsPlatformMac64ARM" }, win32: { sel: "#nwjsPlatformWin32" }, win64: { sel: "#nwjsPlatformWin64" } } }] },
    "package-assets": { help: "on/off", controls: [check("#nwjsPackageAssets")] },
    compress: { help: "on/off: compress the final zip", controls: [check("#nwjsCompressFinalZip")] },
    "window-frame": { help: "on/off", controls: [check("#nwjsWindowFrame")] },
    resizable: { help: "on/off", controls: [check("#nwjsResizableWindow")] },
    kiosk: { help: "on/off", controls: [check("#nwjsKioskMode")] },
    "ignore-gpu-blacklist": { help: "on/off", controls: [check("#nwjsIgnoreGpuBlacklist")] },
    devtools: { help: "on/off", controls: [check("#nwjsEnableDevTools")] },
    steam: { help: "on/off: export for Steam", controls: [check("#nwjsSteamMode")] },
    "command-line": { help: "extra command line options", controls: [{ kind: "text", sel: "#nwjsCommandLine" }] },
  },
};

// Every option name a platform takes, with its help, for --help and errors.
export function exportSettingsHelp(platform: Platform): string[] {
  return Object.entries({ ...STANDARD, ...PLATFORM_SETTINGS[platform] }).map(([k, d]) => `${k}: ${d.help}`);
}

// A setting checked against the platform and release, ready to apply in the page.
export interface PlannedSetting {
  name: string;
  where: "standard" | "dialog" | "permissions";
  control:
    | { kind: "check"; sel: string; value: boolean }
    | { kind: "select"; sel: string; value: string; any: boolean }
    | { kind: "text"; sel: string; value: string }
    | { kind: "boxes"; checked: string[]; unchecked: string[] }
    | { kind: "usage"; sel: string; value: string | null };
}

const BOOL_ON = ["on", "true", "yes", "1"], BOOL_OFF = ["off", "false", "no", "0"];
const inRange = (c: { from?: number; until?: number }, n: number) => (c.from ?? 0) <= n && n <= (c.until ?? Infinity);

// Check the options for a platform and release before the editor is involved. Throws one
// error naming every problem.
export function planExport(platform: Platform, release: Release, opts: ExportOptions): PlannedSetting[] {
  const problems: string[] = [];
  const p = PLATFORMS[platform];
  if (!p) throw new Error(`unknown platform "${platform}" (one of ${PLATFORM_NAMES.join(", ")})`);
  if ("until" in p && release.num > p.until) problems.push(`${platform} exports only exist up to ${p.untilName} (this is ${release.name})`);
  if (opts.offline !== undefined && platform !== "web") problems.push("offline support is a web export option");
  const table = { ...STANDARD, ...PLATFORM_SETTINGS[platform] };
  const planned: PlannedSetting[] = [];
  for (const [name, raw] of Object.entries(opts.settings ?? {})) {
    const def = table[name];
    if (!def) { problems.push(`${platform} has no option "${name}" (it has: ${Object.keys(table).join(", ")})`); continue; }
    const control = def.controls.find((c) => inRange(c, release.num));
    if (!control) { problems.push(`option "${name}" isn't in ${release.name} (${def.help})`); continue; }
    const where = name in STANDARD ? "standard" : def.inPermissions ? "permissions" : "dialog";
    const value = Array.isArray(raw) ? raw.join(",") : String(raw).trim();
    const bad = (why: string) => problems.push(`${name}=${value}: ${why} (${def.help})`);
    switch (control.kind) {
      case "check": {
        const v = value.toLowerCase();
        if (BOOL_ON.includes(v) || control.on?.includes(v)) planned.push({ name, where, control: { kind: "check", sel: control.sel, value: true } });
        else if (BOOL_OFF.includes(v) || control.off?.includes(v)) planned.push({ name, where, control: { kind: "check", sel: control.sel, value: false } });
        else bad("not a value it takes");
        break;
      }
      case "select": {
        let v: string | undefined = value;
        try {
          if (control.values) v = control.values[value];
          else if (control.map) v = control.map(value);
        } catch (e) { bad((e as Error).message); break; }
        if (v === undefined) { bad("not a value it takes"); break; }
        planned.push({ name, where, control: { kind: "select", sel: control.sel, value: v, any: !control.values } });
        break;
      }
      case "text": planned.push({ name, where, control: { kind: "text", sel: control.sel, value: String(raw) } }); break;
      case "int": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < control.min || n > control.max) { bad(`not a whole number from ${control.min} to ${control.max}`); break; }
        planned.push({ name, where, control: { kind: "text", sel: control.sel, value: String(n) } });
        break;
      }
      case "boxes": {
        const wanted = value.split(/[\s,]+/).filter(Boolean).map((x) => x.toLowerCase());
        const here = Object.entries(control.boxes).filter(([, b]) => inRange(b, release.num));
        const unknown = wanted.filter((w) => !here.some(([k]) => k === w));
        if (!wanted.length) { bad("needs at least one"); break; }
        if (unknown.length) { bad(`${unknown.join(", ")} not available in ${release.name}`); break; }
        planned.push({ name, where, control: { kind: "boxes", checked: here.filter(([k]) => wanted.includes(k)).map(([, b]) => b.sel), unchecked: here.filter(([k]) => !wanted.includes(k)).map(([, b]) => b.sel) } });
        break;
      }
      case "usage": {
        const off = BOOL_OFF.includes(value.toLowerCase());
        if (!off && !value) { bad("give the usage text, or off"); break; }
        planned.push({ name, where, control: { kind: "usage", sel: control.sel, value: off ? null : String(raw) } });
        break;
      }
    }
  }
  if (problems.length) throw new Error(problems.join("; "));
  return planned;
}

// Parse `--set name=value` strings into settings. Exported for tests.
export function parseSettings(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i <= 0) throw new Error(`--set needs name=value: ${p}`);
    out[p.slice(0, i).trim()] = p.slice(i + 1);
  }
  return out;
}

// ---- Reading the output ----------------------------------------------------------------

const CHUNK = 8 * 1024 * 1024;

// Copy a Blob out of the page in base64 chunks: a blob: URL, or one c3cli kept
// (window.__c3cliBlobs, see captureClick).
async function readBlob(page: Page, source: { href: string } | { kept: number }): Promise<Buffer> {
  const size = await page.evaluate(async (s) => {
    const blob: Blob = "href" in s ? await (await fetch(s.href)).blob() : (window as any).__c3cliBlobs[s.kept].blob;
    (window as any).__c3cliBlob = new Uint8Array(await blob.arrayBuffer());
    return (window as any).__c3cliBlob.byteLength as number;
  }, source);
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

// Some report links (Cordova's) have no href: the editor makes the zip when clicked and
// "clicks" a temporary <a download> with a blob URL. Keep the Blobs it creates and take that
// click over (no browser download, which also works over CDP), then return what it offered.
async function captureClick(page: Page, link: import("playwright").Locator, timeoutMs: number): Promise<{ kept: number; name: string } | null> {
  await page.evaluate(() => {
    const w = window as any;
    w.__c3cliBlobs = w.__c3cliBlobs ?? [];
    w.__c3cliOffered = [];
    if (w.__c3cliHooked) return;
    w.__c3cliHooked = true;
    const create = URL.createObjectURL;
    URL.createObjectURL = function (o: Blob | MediaSource) {
      const url = create.call(URL, o);
      if (o instanceof Blob) w.__c3cliBlobs.push({ url, blob: o });
      return url;
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      const kept = w.__c3cliBlobs.findIndex((b: { url: string }) => b.url === this.href);
      if (this.hasAttribute("download") && kept >= 0 && w.__c3cliOffered) { w.__c3cliOffered.push({ kept, name: this.download }); return; }
      return click.call(this);
    };
  });
  await link.click();
  const got = await page.waitForFunction(() => (window as any).__c3cliOffered?.[0] ?? null, null, { timeout: timeoutMs, polling: 100 }).catch(() => null);
  const offered = got ? ((await got.jsonValue()) as { kept: number; name: string }) : null;
  await page.evaluate(() => { (window as any).__c3cliOffered = null; });
  return offered;
}

// ---- The export ------------------------------------------------------------------------

// Wait until a dialog's controls stop changing: options dialogs fill in their defaults (and
// version lists from downloads.scirra.com) a moment after they open.
async function settle(page: Page, dialog: string, timeoutMs: number) {
  const state = () => page.evaluate((id) => {
    const d = document.getElementById(id);
    if (!d) return "";
    const selects = [...d.querySelectorAll("select")].filter((s) => (s as HTMLElement).offsetParent);
    if (selects.some((s) => s.options.length === 0)) return `loading ${Date.now()}`; // a version list still empty
    return [...d.querySelectorAll("input, select")].map((e) => { const x = e as HTMLInputElement; return x.type === "checkbox" ? String(x.checked) : x.value; }).join("|");
  }, dialog);
  const deadline = Date.now() + timeoutMs;
  let last = await state(), since = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(150);
    const now = await state();
    if (now !== last) { last = now; since = Date.now(); }
    else if (Date.now() - since >= 800 && !now.startsWith("loading")) return;
  }
}

async function applySettings(page: Page, dialog: string, settings: PlannedSetting[]) {
  for (const s of settings) {
    const at = (sel: string) => page.locator(`#${dialog} ${sel}`).first();
    const c = s.control;
    if (c.kind === "check") await at(c.sel).setChecked(c.value);
    else if (c.kind === "text") await at(c.sel).fill(c.value);
    else if (c.kind === "boxes") {
      for (const sel of c.checked) await at(sel).setChecked(true);
      for (const sel of c.unchecked) await at(sel).setChecked(false);
    } else if (c.kind === "select") {
      const options = await at(c.sel).evaluate((e) => [...(e as HTMLSelectElement).options].filter((o) => !o.disabled).map((o) => o.value));
      if (!options.includes(c.value)) throw new Error(`${s.name}: "${c.value}" isn't offered (the dialog has: ${options.map((o) => o || "(none)").join(", ")})`);
      await at(c.sel).selectOption(c.value);
    } else if (c.kind === "usage") {
      await at(c.sel).setChecked(c.value !== null);
      // The usage text is the id-less text field in the checkbox's row.
      if (c.value !== null) await page.locator(`#${dialog} tr:has(${c.sel}) input[type=text]`).first().fill(c.value);
    }
  }
}

export async function exportProject(page: Page, release: Release, opts: ExportOptions, outDir: string, timeoutMs: number, text?: EditorText): Promise<ExportResult> {
  const platform = opts.platform ?? "web";
  const r: ExportResult = { outcome: "export-failed", platform, outputs: [], suggestedName: null, reportText: null, dialogs: [], warnings: [] };
  const openDialogs = () => page.evaluate(() =>
    [...document.querySelectorAll("dialog[open]")].map((d) => ({ id: d.id, text: (d as HTMLElement).innerText.trim() })));
  try {
    const planned = planExport(platform, release, opts);
    const def = PLATFORMS[platform];
    const ui = text ?? (await editorText(page));
    await dismissDialogs(page);
    await clickProjectMenuItem(page, ui.t("main-menu.project-menu.export-tooltip"));

    // Then, in an order that depends on the project and the platform: warnings (some come
    // before the platform list, e.g. an unlimited framerate), the platform list, pre-checks
    // (OK dialogs), Export options, the platform's own options, the export, its report.
    const handled = new Set<string>();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() > deadline) {
        const progress = await page.evaluate(() => (document.querySelector("#progressDialog[open]") as HTMLElement | null)?.innerText.replace(/\s+/g, " ").trim() ?? null).catch(() => null);
        throw new Error(`timed out waiting for the export${progress ? ` (the editor shows: ${progress})` : ""}`);
      }
      const open = (await openDialogs()).filter((d) => d.id !== "progressDialog" && !handled.has(d.id));
      const d = open.at(-1);
      if (!d) { await page.waitForTimeout(200); continue; }
      if (d.id === "freeEditionLimitDialog") {
        r.dialogs.push(d);
        await page.click("#freeEditionLimitDialog .cancelButton").catch(() => {});
        return { ...r, outcome: "refused-by-edition" };
      }
      if (d.id === "okDialog") {
        // Before the options: a pre-check the project fails (no app ID, an invalid version…).
        // After them: the export itself failed ("Failed to export project…").
        r.dialogs.push(d);
        await page.click("#okDialog .okButton").catch(() => {});
        return handled.has("exportStandardOptionsDialog") ? { ...r, error: d.text.replace(/\s+/g, " ") } : { ...r, outcome: "refused" };
      }
      if (d.id === "confirmDialog") {
        // A warning ("upper-case characters in an app ID…") with Cancel and Continue. Which
        // class is which varies (here Cancel is the bold .confirmButton), so go by the label.
        r.dialogs.push(d);
        const buttons = page.locator("#confirmDialog ui-dialog-footer button");
        const labels = (await buttons.allInnerTexts()).map((t) => t.trim());
        const cancel = labels.indexOf(ui.t("common.cancel"));
        const go = labels.findIndex((t, i) => i !== cancel && t);
        if (!opts.acceptWarnings || cancel < 0 || go < 0) {
          if (cancel >= 0) await buttons.nth(cancel).click().catch(() => {}); else await page.keyboard.press("Escape");
          return { ...r, outcome: "refused", error: opts.acceptWarnings ? `can't tell which button goes on (${labels.join(", ")})` : "the editor warned before exporting (pass acceptWarnings / --accept-warnings to go on)" };
        }
        r.warnings.push(d.text.replace(/\s+/g, " "));
        await buttons.nth(go).click();
        await page.waitForFunction(() => !document.querySelector("#confirmDialog[open]"), null, { timeout: 5000 });
        continue;
      }
      if (d.id === "exportSelectPlatformDialog") {
        handled.add(d.id);
        // Platform tiles carry no id or data attribute; the label is the only handle.
        const label = ui.t(def.tile);
        const tile = page.locator("#exportSelectPlatformDialog ui-iconviewitem").filter({ hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) });
        // The tiles fill in a moment after the dialog opens.
        await tile.first().waitFor({ timeout: 10_000 }).catch(() => { throw new Error(`the export dialog has no "${label}" in ${release.name}`); });
        await tile.first().click();
        await page.click("#exportSelectPlatformDialog .nextButton");
        continue;
      }
      if (d.id === "exportStandardOptionsDialog") {
        handled.add(d.id);
        const s = "#exportStandardOptionsDialog";
        // r449 LTS has no zip/folder choice: it always exports a zip.
        if (await page.locator(`${s} #exportTo`).isVisible().catch(() => false)) await page.selectOption(`${s} #exportTo`, "zip");
        if (opts.minify) await page.selectOption(`${s} #exportMinifyMode`, opts.minify);
        if (opts.lossless) await page.selectOption(`${s} #exportLosslessImageFormat`, opts.lossless);
        if (opts.lossy) await page.selectOption(`${s} #exportLossyImageFormat`, opts.lossy);
        if (opts.offline !== undefined) await page.setChecked(`${s} #exportOfflineSupport`, opts.offline);
        await applySettings(page, "exportStandardOptionsDialog", planned.filter((p) => p.where === "standard"));
        await page.click(`${s} .nextButton`);
        continue;
      }
      if (def.dialog && d.id === def.dialog) {
        handled.add(d.id);
        await settle(page, d.id, 30_000);
        if (platform === "android") await page.selectOption("#cordovaOptionsDialog .androidTarget select", "cordova");
        if (platform === "ios") await page.selectOption("#cordovaOptionsDialog .iosTarget select", "cordova");
        await applySettings(page, d.id, planned.filter((p) => p.where === "dialog"));
        const perms = planned.filter((p) => p.where === "permissions");
        if (perms.length) {
          await page.click("#macosPermissionsButton");
          await page.waitForSelector("#macosPermissionsDialog[open]");
          await applySettings(page, "macosPermissionsDialog", perms);
          await page.click("#macosPermissionsDialog .okButton");
          await page.waitForFunction(() => !document.querySelector("#macosPermissionsDialog[open]"), null, { timeout: 5000 });
        }
        await page.click(`#${d.id} .nextButton`);
        continue;
      }
      if (/ExportReportDialog$/.test(d.id)) {
        r.reportText = d.text;
        const links = page.locator(`#${d.id} a.downloadExportedProject`);
        const used = new Set<string>();
        for (let i = 0; i < (await links.count()); i++) {
          const link = links.nth(i);
          if (!(await link.isVisible())) continue;
          const [href, attrName] = await Promise.all([link.getAttribute("href"), link.getAttribute("download")]);
          let data: Buffer, name: string;
          if (href) {
            data = await readBlob(page, { href });
            name = attrName ?? `export-${i + 1}.zip`;
          } else {
            const offered = await captureClick(page, link, Math.max(30_000, deadline - Date.now()));
            if (!offered) throw new Error("the export report's download link gave nothing");
            data = await readBlob(page, { kept: offered.kept });
            name = offered.name || `export-${i + 1}.zip`;
          }
          let file = path.join(outDir, name.replace(/[/\\]/g, "_"));
          for (let n = 2; used.has(file); n++) file = path.join(outDir, `${n}-${name}`);
          used.add(file);
          await writeFile(file, data);
          r.outputs.push({ name, file });
        }
        if (!r.outputs.length) return { ...r, error: "the export report has no download link" };
        await page.click(`#${d.id} .okButton`).catch(() => {});
        return { ...r, outcome: "exported", suggestedName: r.outputs[0].name };
      }
      r.dialogs.push(d);
      return { ...r, error: `the export stopped at an unexpected dialog: ${d.id}` };
    }
  } catch (e) {
    r.dialogs.push(...(await openDialogs().catch(() => [])).filter((d) => d.id !== "progressDialog"));
    return { ...r, error: (e as Error).message.split("\n")[0] };
  } finally {
    await page.evaluate(() => { const w = window as any; w.__c3cliBlobs = []; }).catch(() => {});
  }
}
