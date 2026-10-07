// The c3cli library: open projects in the real Construct 3 editor and work with them.
//
//   const editor = await C3Editor.launch();            // or C3Editor.connect() to use the daemon
//   const project = await editor.open("game.c3p");
//   if (project.report.outcome === "opened") {
//     const preview = await project.preview({ layout: "Level 1" });
//     await preview.eval((runtime) => runtime.layout.name);
//     await preview.close();
//   }
//   await project.close();
//   await editor.close();
import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { diffProjects, type SaveDiff } from "./diff.ts";
import { collectAddons, installAddons, type AddonResult } from "./addons.ts";
import { Bridge, type Root } from "./bridge.ts";
import { dismissDialogs, loadEditor, newProjectInEditor, saveAsInEditor, saveInEditor } from "./editor.ts";
import { bundledAddonHashes, rememberAddons } from "./remember.ts";
import { exportProject, planExport, type ExportOptions, type ExportResult } from "./export.ts";
import { collect, waitForOutcome, type BundledAddon, type DialogInfo, type MissingAddon, type Outcome } from "./observe.ts";
import { EditorLoadError, LocalPool, type Lease, type TabSource, type TabStartup } from "./pool.ts";
import { LivePreview, runPreview, type PreviewResult } from "./preview.ts";
import { editorText, productNames, type EditorText } from "./lang.ts";
import { waitForAccount } from "./login.ts";
import { readProjectInfo, type ProjectInfo } from "./project.ts";
import { exactRelease, releaseName, releaseNum, resolveBranch, type Branch, type Release } from "./release.ts";

export const REPORT_VERSION = 2;

export interface LaunchOptions {
  // Browser profile to use and keep (logins live here). Default: a temporary one.
  profile?: string;
  headed?: boolean;
  // Editor tabs, i.e. how many projects can be open at once.
  tabs?: number;
  // Load the tabs with this release up front.
  warm?: { release?: string; branch?: Branch };
  // The browser's language, which a fresh profile's editor takes as its own if C3 has it.
  // Default "en-US". c3cli works in any of the editor's languages.
  locale?: string;
  // Log in with the session `c3cli login` saved (default true), unless `profile` has a login
  // of its own. False: the editor stays logged out (free edition).
  sharedSession?: boolean;
}

export interface OpenOptions {
  release?: string;
  branch?: Branch;
  // If the project was saved with a newer release than the chosen one, use its release.
  useProjectRelease?: boolean;
  installBundledAddons?: boolean;
  // Addons to install first (.c3addon files, folders of them, zips): for projects that use
  // addons they don't bundle. They go into the browser profile (the daemon's, with the daemon).
  addons?: string[];
  timeoutMs?: number;
}

export interface CreateOptions {
  release?: string;
  branch?: Branch;
  // The project's name. Default: the target's name ("games/pong" or "pong.c3p" → "pong").
  name?: string;
  timeoutMs?: number;
}

export type OpenOutcome = Outcome | "editor-error";

export interface OpenReport {
  version: number;
  project: { path: string; kind: ProjectInfo["kind"]; name: string | null; savedWithRelease: string | null };
  release: string;
  host: "hosted";
  tab: string;
  outcome: OpenOutcome;
  error?: string;
  durationMs: number;
  startupDialogs: string[];
  startupPageErrors: string[];
  startupConsoleErrors: string[];
  dialogs: DialogInfo[];
  missingAddons: (MissingAddon & { declined?: boolean })[];
  bundledAddons: BundledAddon[];
  // What happened to OpenOptions.addons, when given.
  addons?: AddonResult[];
  log: string[];
  consoleErrors: string[];
  pageErrors: string[];
  notes: string[];
}

export interface SaveReport {
  to: string;
  // Saved over the project itself (save() without a target).
  inPlace: boolean;
  ok: boolean;
  // Files the editor wrote (or created or deleted), relative to the project.
  written: string[];
  // The project's savedWithRelease before and after (a save with a newer release upgrades it).
  savedWithRelease: { before: string | null; after: string | null } | null;
  // What differs from the opened project; null for an in-place save.
  diff: SaveDiff | null;
  error?: string;
  // Not saved on purpose: the free edition would have unbundled the project's addons.
  refused?: "free-edition-unbundles-addons";
  warnings?: string[];
}

export interface SaveOptions {
  timeoutMs?: number;
  // Save a project that bundles its addons even in the free edition, which unbundles them
  // (bundleAddons off, no addons/ folder). Refused by default.
  allowUnbundle?: boolean;
}
export type ExportReport = Omit<ExportResult, "outputs"> & {
  to: string;
  // Files unzipped into a folder `to`; null for a zip.
  files: number | null;
  // Each zip the export made (by the editor's name) and where it went: the .zip `to`, the
  // folder `to`, or with several zips a subfolder of `to` per zip.
  outputs: { name: string; to: string }[];
};

export async function resolveRelease(opts: { release?: string; branch?: Branch }): Promise<Release> {
  return opts.release ? exactRelease(opts.release) : resolveBranch(opts.branch ?? "stable");
}

export class C3Editor {
  private constructor(private source: TabSource) {}

  // A private browser with its own pool of editor tabs.
  static async launch(opts: LaunchOptions = {}): Promise<C3Editor> {
    const warm = opts.warm ? await resolveRelease(opts.warm) : undefined;
    const pool = await LocalPool.launch({ profile: opts.profile, headed: opts.headed ?? false, tabs: opts.tabs ?? 1, warm, locale: opts.locale, sharedSession: opts.sharedSession });
    return new C3Editor(pool);
  }

  // Use tabs from a running daemon (`c3cli daemon start`). Throws if it isn't running.
  static async connect(opts: { socket?: string } = {}): Promise<C3Editor> {
    const { DaemonSource } = await import("./daemon.ts");
    const source = await DaemonSource.connect(opts.socket);
    if (!source) throw new Error("the c3cli daemon is not running (start it with `c3cli daemon start`)");
    return new C3Editor(source);
  }

  static fromSource(source: TabSource) { return new C3Editor(source); }

  // Open a project (folder or .c3p) in a free tab. Always returns a project: check
  // `report.outcome` before using it, and close it to give the tab back.
  async open(projectPath: string, opts: OpenOptions = {}): Promise<OpenedProject> {
    const info = await readProjectInfo(projectPath);
    const notes: string[] = [];
    let release = await resolveRelease(opts);
    // useProjectRelease: exactly the release the project was saved with, older or newer
    // (an LTS-only project with SDK v1 addons only opens on its own release).
    if (opts.useProjectRelease && info.savedWithRelease && info.savedWithRelease !== release.num) {
      const projectRelease = releaseName(info.savedWithRelease);
      notes.push(`project was saved with ${projectRelease}; using ${projectRelease} instead of ${release.name}`);
      release = exactRelease(projectRelease);
    } else if (info.savedWithRelease && info.savedWithRelease > release.num) {
      notes.push(`project was saved with ${releaseName(info.savedWithRelease)}, newer than ${release.name}; expect a refusal`);
    }
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const base = {
      version: REPORT_VERSION,
      project: { path: info.path, kind: info.kind, name: info.name, savedWithRelease: info.savedWithRelease ? releaseName(info.savedWithRelease) : null },
      release: release.name, host: "hosted" as const, notes,
    };

    const extra = opts.addons?.length ? await collectAddons(opts.addons) : null;
    let lease: Lease;
    try {
      lease = await this.source.lease(release, timeoutMs);
    } catch (e) {
      await extra?.cleanup();
      if (!(e instanceof EditorLoadError)) throw e;
      // The editor never became usable: nothing about the project can be said.
      return new OpenedProject(null, null, null, null, info, release, {
        ...base, tab: "", outcome: "editor-error", error: e.message, durationMs: 0,
        startupDialogs: e.startup.dialogs, startupPageErrors: e.startup.pageErrors, startupConsoleErrors: e.startup.consoleErrors,
        dialogs: [], missingAddons: [], bundledAddons: [], log: [], consoleErrors: [], pageErrors: [],
      });
    }

    const { page } = lease;
    notes.push(...(lease.startup.notes ?? []));
    try {
      let addons: AddonResult[] | undefined;
      if (extra) {
        addons = await installAddons(page, await editorText(page, release.assetUrl), extra.addons, timeoutMs);
        await loadEditor(page, release, timeoutMs);
        await this.source.reloadIdle();
      }
      // After the reload, if any: what the editor logs while starting isn't the project's.
      const collector = collect(page);
      const bridge = await Bridge.attach(page);
      // Accepting bundled addons: trust them before the drop, so the editor doesn't ask.
      // The prompt handling below stays for whatever this misses.
      if (opts.installBundledAddons ?? true) {
        const hashes = await bundledAddonHashes(info.path, info.kind);
        if (hashes.length && await rememberAddons(page, hashes)) notes.push(`${hashes.length} bundled addon(s) trusted before opening (no install prompts)`);
      }
      // A dialog that came up after the editor loaded (a late notice, or "Account logged out"
      // when the shared session was refused) would swallow the drop.
      const late = await dismissDialogs(page);
      const openedAt = Date.now();
      const root = await bridge.open(info.path, info.kind);
      if (bridge.dropAttempts > 1) notes.push(`the editor took the project on drop ${bridge.dropAttempts} (it ignored the first)`);
      const result = await waitForOutcome(page, {
        projectName: info.name, assetUrl: release.assetUrl, timeoutMs, installBundledAddons: opts.installBundledAddons ?? true,
      });
      let outcome: Outcome = result.outcome;
      if (outcome === "timeout" && collector.pageErrors.length) outcome = "crashed";
      // Declining a bundled addon makes the editor say only "failed to open"; name the real cause.
      const declined = result.bundledAddons.filter((a) => !a.installed);
      if (outcome === "refused" && declined.length) outcome = "missing-addons";
      const report: OpenReport = {
        ...base, tab: lease.tabId, outcome, durationMs: Date.now() - openedAt,
        startupDialogs: [...lease.startup.dialogs, ...late], startupPageErrors: lease.startup.pageErrors, startupConsoleErrors: lease.startup.consoleErrors,
        dialogs: result.dialogs,
        missingAddons: [
          // The project knows each addon's type; the dialog can't always tell (Chinese uses
          // one word for plugin and effect).
          ...result.missingAddons.map((a) => ({ ...a, type: info.addonTypes[a.id] ?? a.type })),
          ...declined.map((a) => ({ type: a.type ?? "Addon", name: a.name ?? "?", id: a.name ?? "?", author: a.author, declined: true })),
        ],
        bundledAddons: result.bundledAddons,
        ...(addons ? { addons } : {}),
        log: collector.log, consoleErrors: collector.consoleErrors, pageErrors: collector.pageErrors,
      };
      return new OpenedProject(lease, bridge, root, result.text, info, release, report);
    } catch (e) {
      await lease.done();
      throw e;
    } finally {
      await extra?.cleanup();
    }
  }

  // Install addons (.c3addon files, folders of them, zips) into this editor's browser
  // profile, then reload its tabs so they're active. They last as long as the profile: for
  // good with a --profile, until the end with a temporary one.
  async installAddons(paths: string[], opts: { release?: string; branch?: Branch; timeoutMs?: number } = {}): Promise<AddonResult[]> {
    const { addons, cleanup } = await collectAddons(paths);
    try {
      const release = await resolveRelease(opts);
      const timeoutMs = opts.timeoutMs ?? 60_000;
      const lease = await this.source.lease(release, timeoutMs);
      try {
        return await installAddons(lease.page, await editorText(lease.page, release.assetUrl), addons, timeoutMs);
      } finally {
        // Other tabs reload; this one comes back as a fresh page, i.e. reloaded too.
        await this.source.reloadIdle();
        await lease.done();
      }
    } finally {
      await cleanup();
    }
  }

  // Create a new project with the editor (Project → New, C3's defaults) and save it to
  // `to`: a new or empty folder, or a new .c3p. What you get is exactly what that release
  // writes for an empty project. Returns it open, located at `to` (`saved` says what was
  // written). Throws if it couldn't be created or saved.
  async create(to: string, opts: CreateOptions = {}): Promise<OpenedProject> {
    const dest = path.resolve(to);
    const kind = targetKind(dest);
    await checkTarget(dest, kind);
    const name = opts.name ?? path.basename(dest).replace(/\.c3p$/i, "");
    const release = await resolveRelease(opts);
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const lease = await this.source.lease(release, timeoutMs);
    const { page } = lease;
    const collector = collect(page);
    try {
      const bridge = await Bridge.attach(page);
      const text = await editorText(page, release.assetUrl);
      const started = Date.now();
      await newProjectInEditor(page, text.t("main-menu.project-menu.new-tooltip"), name, productNames(text).map((p) => `${name} - ${p}`), timeoutMs);
      const { target, written } = await saveAsTo(page, bridge, text, dest, timeoutMs);
      const savedWithRelease = await savedWith(dest);
      const info: ProjectInfo = { path: dest, kind, name, savedWithRelease: savedWithRelease ? releaseNum(savedWithRelease) : null, addonTypes: {}, bundleAddons: false };
      const report: OpenReport = {
        version: REPORT_VERSION, project: { path: dest, kind, name, savedWithRelease }, release: release.name, host: "hosted",
        tab: lease.tabId, outcome: "opened", durationMs: Date.now() - started,
        startupDialogs: lease.startup.dialogs, startupPageErrors: lease.startup.pageErrors, startupConsoleErrors: lease.startup.consoleErrors,
        dialogs: [], missingAddons: [], bundledAddons: [],
        log: collector.log, consoleErrors: collector.consoleErrors, pageErrors: collector.pageErrors, notes: [],
      };
      const saved: SaveReport = { to: dest, inPlace: false, ok: true, written, savedWithRelease: { before: null, after: savedWithRelease }, diff: null };
      return new OpenedProject(lease, bridge, target, text, info, release, report, saved);
    } catch (e) {
      await lease.done();
      throw e;
    }
  }

  async close() { await this.source.close(); }
}

export class OpenedProject {
  private closed = false;
  private previews: LivePreview[] = [];
  private editorSaves = false;

  constructor(
    private lease: Lease | null,
    private bridge: Bridge | null,
    // Where the editor's project lives on disk: the opened path, or the last saveAs target.
    private location: Root | null,
    // The editor's UI text, in its language.
    private text: EditorText | null,
    readonly info: ProjectInfo,
    readonly release: Release,
    readonly report: OpenReport,
    // For a project made by create(): how it was saved.
    readonly saved: SaveReport | null = null,
  ) {}

  // The editor page, for anything the API doesn't cover.
  get page(): Page {
    if (!this.lease) throw new Error(`no editor page: ${this.report.outcome}`);
    return this.lease.page;
  }

  // Where the project lives now: the path it was opened from, or where saveAs() put it.
  get path(): string { return this.location?.path ?? this.info.path; }

  private requireOpened(what: string) {
    if (this.closed) throw new Error(`cannot ${what}: the project was closed`);
    if (this.report.outcome !== "opened") throw new Error(`cannot ${what}: project did not open (${this.report.outcome})`);
  }

  // The free edition saves bundleAddons as false and drops the addons/ folder: bundling is
  // a paid feature. Refuse such a save unless allowed; null = go on.
  private async unbundleCheck(dest: string, inPlace: boolean, opts: SaveOptions): Promise<{ refusal: SaveReport | null; warnings: string[] }> {
    if (!this.info.bundleAddons) return { refusal: null, warnings: [] };
    const account = await waitForAccount(this.page, 15_000, this.text!);
    if (account.settled && account.edition === "paid") return { refusal: null, warnings: [] };
    const who = account.loggedIn ? `the account ${account.name} has the free edition` : account.settled ? "the editor is logged out (free edition)" : "the editor's edition is unknown (account not checked yet)";
    const what = "the free edition unbundles the project's addons on save (bundleAddons off, no addons/ folder)";
    if (opts.allowUnbundle) return { refusal: null, warnings: [`saved anyway (allowUnbundle): ${what}, and ${who}`] };
    return {
      refusal: { to: dest, inPlace, ok: false, written: [], savedWithRelease: null, diff: null, refused: "free-edition-unbundles-addons",
        error: `not saved: the project bundles its addons and ${who}; ${what}. Log in with a paid account, or allow it (--allow-unbundle)` },
      warnings: [],
    };
  }

  // Save with the editor (Ctrl/Cmd+S), which only rewrites the files C3 considers changed.
  // Without `to`: in place, over the project's own files. With `to`: into a new folder (a
  // copy of the project, without .git, with the save on top) or a new .c3p, never
  // overwritten, and diffed with the project.
  async save(to?: string, opts: SaveOptions = {}): Promise<SaveReport> {
    this.requireOpened("save");
    const root = this.location!, bridge = this.bridge!;
    const inPlace = to === undefined;
    const dest = inPlace ? root.path : path.resolve(to);
    if (!inPlace) await checkTarget(dest, root.kind);
    const { refusal, warnings } = await this.unbundleCheck(dest, inPlace, opts);
    if (refusal) return refusal;
    const before = await savedWith(root.path);
    const mirrored = !inPlace && root.kind === "folder";
    const existed = inPlace || (await exists(dest));
    try {
      if (mirrored) {
        await copyProject(root.path, dest);
        await bridge.mirror(root, dest);
      } else root.writeTo = dest;
      let written: string[];
      try {
        written = await saveInEditor(this.page, bridge, opts.timeoutMs ?? 30_000);
      } finally {
        if (mirrored) await bridge.unmirror(root);
        root.writeTo = this.editorSaves ? root.path : null;
      }
      return {
        to: dest, inPlace, ok: true, written, savedWithRelease: { before, after: await savedWith(dest) },
        diff: inPlace ? null : await diffProjects(root.path, dest, mirrored ? written : undefined),
        ...(warnings.length ? { warnings } : {}),
      };
    } catch (e) {
      if (!existed) await rm(dest, { recursive: true, force: true }).catch(() => {});
      return { to: dest, inPlace, ok: false, written: [], savedWithRelease: null, diff: null, error: (e as Error).message };
    }
  }

  // "Save as" to `to`: a new or empty folder (Save as project folder) or a new .c3p (Save as
  // single file), diffed with the opened project. Unlike save(), this writes every file
  // from the editor's memory: use it to see what C3 actually holds for the project.
  // Afterwards the editor's project is `to`, and save() writes there.
  async saveAs(to: string, opts: SaveOptions = {}): Promise<SaveReport> {
    this.requireOpened("save as");
    const dest = path.resolve(to);
    await checkTarget(dest, targetKind(dest));
    const { refusal, warnings } = await this.unbundleCheck(dest, false, opts);
    if (refusal) return refusal;
    const before = await savedWith(this.info.path);
    try {
      const { target, written } = await saveAsTo(this.page, this.bridge!, this.text!, dest, opts.timeoutMs ?? 30_000);
      this.location = target;
      target.writeTo = this.editorSaves ? target.path : null;
      return {
        to: dest, inPlace: false, ok: true, written, savedWithRelease: { before, after: await savedWith(dest) },
        diff: await diffProjects(this.info.path, dest),
        ...(warnings.length ? { warnings } : {}),
      };
    } catch (e) {
      return { to: dest, inPlace: false, ok: false, written: [], savedWithRelease: null, diff: null, error: (e as Error).message };
    }
  }

  // Let saves made in the editor window itself (someone pressing Ctrl+S, e.g. with
  // --keep-open) write the project in place. Off by default: until then the editor's own
  // writes are refused outside save() and saveAs().
  allowEditorSaves() {
    this.editorSaves = true;
    if (this.location) this.location.writeTo = this.location.path;
  }

  // Export for a platform (default web) to a new .zip, or unzipped into a new/empty folder.
  // Unzipping keeps file modes, so executables stay executable. Every platform seen so far
  // gives one zip (several architectures are folders inside it); should one offer several,
  // `to` must be a folder and each zip goes into its own subfolder.
  async export(to: string, options: ExportOptions = {}, opts: { timeoutMs?: number } = {}): Promise<ExportReport> {
    this.requireOpened("export");
    const toPath = path.resolve(to);
    const asZip = toPath.toLowerCase().endsWith(".zip");
    await checkTarget(toPath, asZip ? "zip" : "folder");
    planExport(options.platform ?? "web", this.release, options); // bad options: throw before anything runs
    const tmp = await mkdtemp(path.join(os.tmpdir(), "c3cli-export-"));
    try {
      const { outputs, ...res } = await exportProject(this.page, this.release, options, tmp, opts.timeoutMs ?? 120_000, this.text!);
      const report: ExportReport = { ...res, to: toPath, files: null, outputs: [] };
      if (res.outcome !== "exported") return report;
      if (asZip) {
        if (outputs.length > 1) return { ...report, outcome: "export-failed", error: `the export made ${outputs.length} zips (${outputs.map((o) => o.name).join(", ")}): give a folder to export into` };
        await moveFile(outputs[0].file, toPath);
        return { ...report, outputs: [{ name: outputs[0].name, to: toPath }] };
      }
      const { unzipProject } = await import("./unzip.ts");
      await mkdir(toPath, { recursive: true });
      let files = 0;
      for (const o of outputs) {
        const dest = outputs.length > 1 ? path.join(toPath, o.name.replace(/\.zip$/i, "")) : toPath;
        files += await unzipProject(o.file, dest);
        report.outputs.push({ name: o.name, to: dest });
      }
      return { ...report, files };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  // Start a live preview: the whole project, or `layout` directly. Close it when done.
  async preview(opts: { layout?: string } = {}): Promise<LivePreview> {
    this.requireOpened("preview");
    const p = await LivePreview.start(this.page, { ...opts, remote: this.lease!.remoteRuntime, text: this.text! });
    this.previews.push(p);
    await p.attach();
    return p;
  }

  // One-shot preview: run for `seconds`, report errors and the layout it started on.
  async runPreview(opts: { seconds: number; layout?: string }): Promise<PreviewResult> {
    this.requireOpened("preview");
    return runPreview(this.page, { ...opts, remote: this.lease!.remoteRuntime, text: this.text! });
  }

  // Give the tab back. The pool replaces it with a fresh editor for the next project.
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.previews) await p.close();
    if (this.location) this.location.writeTo = null;
    await this.lease?.done();
  }
}

// Rename into place, creating parent folders; copy when the temp dir is on another volume.
async function moveFile(from: string, to: string) {
  await mkdir(path.dirname(path.resolve(to)), { recursive: true });
  try {
    await rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

// Never overwrite: folder targets must not exist (or be empty), file targets must not exist.
export async function checkTarget(to: string, kind: "folder" | "file" | "zip") {
  if (kind === "file" && !to.toLowerCase().endsWith(".c3p")) throw new Error(`target must be a .c3p path for a .c3p project: ${to}`);
  const exists = await access(to).then(() => true, () => false);
  if (!exists) return;
  if (kind === "folder" && (await readdir(to)).length === 0) return;
  throw new Error(`target already exists, refusing to overwrite: ${to}`);
}

const exists = (p: string) => access(p).then(() => true, () => false);

const targetKind = (p: string): "file" | "folder" => (p.toLowerCase().endsWith(".c3p") ? "file" : "folder");

// Save as to `dest` (checked beforehand): a folder, created if needed, or a .c3p, created
// empty so the bridge can hand the editor a handle to it. Removed again if the save fails
// and c3cli created it. Returns the new root with writes refused again.
async function saveAsTo(page: Page, bridge: Bridge, ui: EditorText, dest: string, timeoutMs: number): Promise<{ target: Root; written: string[] }> {
  const kind = targetKind(dest);
  const existed = await exists(dest);
  let target: Root | null = null;
  try {
    if (kind === "folder") await mkdir(dest, { recursive: true });
    else {
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, "");
    }
    target = await bridge.pick(dest, kind);
    const menu = {
      submenu: ui.t("main-menu.project-menu.save-as"),
      title: ui.t(kind === "folder" ? "main-menu.project-menu.save-as-folder-tooltip" : "main-menu.project-menu.save-as-single-file-tooltip"),
    };
    return { target, written: await saveAsInEditor(page, bridge, target, menu, timeoutMs) };
  } catch (e) {
    if (!existed) await rm(dest, { recursive: true, force: true }).catch(() => {});
    throw e;
  } finally {
    if (target) target.writeTo = null;
  }
}

async function savedWith(project: string): Promise<string | null> {
  const n = (await readProjectInfo(project).catch(() => null))?.savedWithRelease;
  return n ? releaseName(n) : null;
}

// The starting point of save(to) for a folder: everything but .git, cloned where the disk
// can (APFS), so a project at a repo root costs little.
async function copyProject(from: string, to: string) {
  await cp(from, to, { recursive: true, filter: (src) => path.basename(src) !== ".git", mode: constants.COPYFILE_FICLONE });
}

export type { AddonResult, ExportOptions, LivePreview, PreviewResult, TabStartup };
