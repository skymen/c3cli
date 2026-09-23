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
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { diffProjects, type SaveDiff } from "./diff.ts";
import { clickOpen, exportStaged, removeStaged, saveInEditor, stageProject } from "./editor.ts";
import { exportWeb, type ExportOptions, type ExportResult } from "./export.ts";
import { collect, parseMissingAddons, waitForOutcome, type BundledAddon, type DialogInfo, type MissingAddon, type Outcome } from "./observe.ts";
import { EditorLoadError, LocalPool, type Lease, type TabSource, type TabStartup } from "./pool.ts";
import { LivePreview, runPreview, type PreviewResult } from "./preview.ts";
import { readProjectInfo, type ProjectInfo } from "./project.ts";
import { exactRelease, releaseName, resolveBranch, type Branch, type Release } from "./release.ts";

export const REPORT_VERSION = 1;

export interface LaunchOptions {
  // Browser profile to use and keep (logins live here). Default: a temporary one.
  profile?: string;
  headed?: boolean;
  // Editor tabs, i.e. how many projects can be open at once.
  tabs?: number;
  // Load the tabs with this release up front.
  warm?: { release?: string; branch?: Branch };
}

export interface OpenOptions {
  release?: string;
  branch?: Branch;
  // If the project was saved with a newer release than the chosen one, use its release.
  useProjectRelease?: boolean;
  installBundledAddons?: boolean;
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
  filesStaged: number;
  startupDialogs: string[];
  startupPageErrors: string[];
  startupConsoleErrors: string[];
  dialogs: DialogInfo[];
  missingAddons: (MissingAddon & { declined?: boolean })[];
  bundledAddons: BundledAddon[];
  log: string[];
  consoleErrors: string[];
  pageErrors: string[];
  notes: string[];
}

export interface SaveReport { to: string; ok: boolean; written: string[]; diff: SaveDiff | null; error?: string }
export type ExportReport = Omit<ExportResult, "zipPath"> & { to: string; files: number | null };

export async function resolveRelease(opts: { release?: string; branch?: Branch }): Promise<Release> {
  return opts.release ? exactRelease(opts.release) : resolveBranch(opts.branch ?? "stable");
}

export class C3Editor {
  private constructor(private source: TabSource) {}

  // A private browser with its own pool of editor tabs.
  static async launch(opts: LaunchOptions = {}): Promise<C3Editor> {
    const warm = opts.warm ? await resolveRelease(opts.warm) : undefined;
    const pool = await LocalPool.launch({ profile: opts.profile, headed: opts.headed ?? false, tabs: opts.tabs ?? 1, warm });
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
    if (opts.useProjectRelease && info.savedWithRelease && info.savedWithRelease > release.num) {
      const projectRelease = releaseName(info.savedWithRelease);
      notes.push(`project was saved with ${projectRelease}, newer than ${release.name}; using ${projectRelease}`);
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

    let lease: Lease;
    try {
      lease = await this.source.lease(release, timeoutMs);
    } catch (e) {
      if (!(e instanceof EditorLoadError)) throw e;
      // The editor never became usable: nothing about the project can be said.
      return new OpenedProject(null, info, release, "", {
        ...base, tab: "", outcome: "editor-error", error: e.message, durationMs: 0, filesStaged: 0,
        startupDialogs: e.startup.dialogs, startupPageErrors: e.startup.pageErrors, startupConsoleErrors: e.startup.consoleErrors,
        dialogs: [], missingAddons: [], bundledAddons: [], log: [], consoleErrors: [], pageErrors: [],
      });
    }

    const { page } = lease;
    const runId = randomUUID();
    const collector = collect(page);
    try {
      const staged = await stageProject(page, info, runId);
      const openedAt = Date.now();
      await clickOpen(page, info.kind);
      const result = await waitForOutcome(page, {
        projectName: info.name, assetUrl: release.assetUrl, timeoutMs, installBundledAddons: opts.installBundledAddons ?? true,
      });
      let outcome: Outcome = result.outcome;
      if (outcome === "timeout" && collector.pageErrors.length) outcome = "crashed";
      // Declining a bundled addon makes the editor say only "failed to open"; name the real cause.
      const declined = result.bundledAddons.filter((a) => !a.installed);
      if (outcome === "refused" && declined.length) outcome = "missing-addons";
      const report: OpenReport = {
        ...base, tab: lease.tabId, outcome, durationMs: Date.now() - openedAt, filesStaged: staged,
        startupDialogs: lease.startup.dialogs, startupPageErrors: lease.startup.pageErrors, startupConsoleErrors: lease.startup.consoleErrors,
        dialogs: result.dialogs,
        missingAddons: [
          ...parseMissingAddons(result.dialogs),
          ...declined.map((a) => ({ type: a.type ?? "Addon", name: a.name ?? "?", id: a.name ?? "?", author: a.author, declined: true })),
        ],
        bundledAddons: result.bundledAddons,
        log: collector.log, consoleErrors: collector.consoleErrors, pageErrors: collector.pageErrors,
      };
      return new OpenedProject(lease, info, release, runId, report);
    } catch (e) {
      await removeStaged(page, runId);
      await lease.done();
      throw e;
    }
  }

  async close() { await this.source.close(); }
}

export class OpenedProject {
  private closed = false;
  private previews: LivePreview[] = [];

  constructor(
    private lease: Lease | null,
    readonly info: ProjectInfo,
    readonly release: Release,
    private runId: string,
    readonly report: OpenReport,
  ) {}

  // The editor page, for anything the API doesn't cover.
  get page(): Page {
    if (!this.lease) throw new Error(`no editor page: ${this.report.outcome}`);
    return this.lease.page;
  }

  private requireOpened(what: string) {
    if (this.closed) throw new Error(`cannot ${what}: the project was closed`);
    if (this.report.outcome !== "opened") throw new Error(`cannot ${what}: project did not open (${this.report.outcome})`);
  }

  // Save with the editor (Ctrl/Cmd+S), write the result to `to` (a new folder for folder
  // projects, a new .c3p for .c3p projects; never overwritten) and diff it with the input.
  async save(to: string, opts: { timeoutMs?: number } = {}): Promise<SaveReport> {
    this.requireOpened("save");
    await checkTarget(to, this.info.kind);
    try {
      const written = await saveInEditor(this.page, opts.timeoutMs ?? 30_000);
      await writeSaved(this.page, this.info.kind, to);
      return { to: path.resolve(to), ok: true, written, diff: await diffProjects(this.info.path, to) };
    } catch (e) {
      return { to: path.resolve(to), ok: false, written: [], diff: null, error: (e as Error).message };
    }
  }

  // Web (HTML5) export to a new .zip, or unzipped into a new/empty folder.
  async export(to: string, options: ExportOptions = {}, opts: { timeoutMs?: number } = {}): Promise<ExportReport> {
    this.requireOpened("export");
    const toPath = path.resolve(to);
    await checkTarget(toPath, toPath.toLowerCase().endsWith(".zip") ? "zip" : "folder");
    const tmp = await mkdtemp(path.join(os.tmpdir(), "c3cli-export-"));
    try {
      const { zipPath, ...res } = await exportWeb(this.page, options, path.join(tmp, "export.zip"), opts.timeoutMs ?? 120_000);
      let files: number | null = null;
      if (zipPath) {
        if (toPath.toLowerCase().endsWith(".zip")) await moveFile(zipPath, toPath);
        else {
          const { unzipProject } = await import("./unzip.ts");
          files = await unzipProject(zipPath, toPath);
        }
      }
      return { ...res, to: toPath, files };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  // Start a live preview: the whole project, or `layout` directly. Close it when done.
  async preview(opts: { layout?: string } = {}): Promise<LivePreview> {
    this.requireOpened("preview");
    const p = await LivePreview.start(this.page, { ...opts, remote: this.lease!.remoteRuntime });
    this.previews.push(p);
    await p.attach();
    return p;
  }

  // One-shot preview: run for `seconds`, report errors and the layout it started on.
  async runPreview(opts: { seconds: number; layout?: string }): Promise<PreviewResult> {
    this.requireOpened("preview");
    return runPreview(this.page, { ...opts, remote: this.lease!.remoteRuntime });
  }

  // Give the tab back. The pool replaces it with a fresh editor for the next project.
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.previews) await p.close();
    if (this.lease) {
      await removeStaged(this.lease.page, this.runId);
      await this.lease.done();
    }
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

// Export the staged copy; for a .c3p the staged root holds just the one file.
async function writeSaved(page: Page, kind: ProjectInfo["kind"], to: string) {
  if (kind === "folder") { await exportStaged(page, to); return; }
  const tmp = await mkdtemp(path.join(os.tmpdir(), "c3cli-save-"));
  try {
    await exportStaged(page, tmp);
    const [file] = await readdir(tmp);
    await moveFile(path.join(tmp, file), to);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export type { ExportOptions, LivePreview, PreviewResult, TabStartup };
