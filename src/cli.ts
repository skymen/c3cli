#!/usr/bin/env node
// c3cli: drive the Construct 3 editor from the command line.
import { Command, Option } from "commander";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diffProjects, type SaveDiff } from "./diff.ts";
import { DEFAULT_PROFILE, clickOpen, exportStaged, launch, loadEditor, runPreview, saveInEditor, stageProject, type PreviewResult } from "./editor.ts";
import { collect, parseMissingAddons, waitForOutcome, type Outcome } from "./observe.ts";
import { readProjectInfo } from "./project.ts";
import { exactRelease, releaseName, resolveBranch, type Branch, type Release } from "./release.ts";

const REPORT_VERSION = 1;

const EXIT = { clean: 0, warnings: 1, refused: 2, crashed: 3, toolError: 4 } as const;

interface OpenOpts {
  branch: Branch;
  release?: string;
  useProjectRelease: boolean;
  report?: "json";
  timeout: number;
  headed: boolean;
  profile: string;
  keepOpen: boolean;
  installBundledAddons: boolean;
}

const program = new Command("c3cli").description("Drive the Construct 3 editor from the command line");

// Options shared by every command that opens a project.
function withOpenOptions(cmd: Command): Command {
  return cmd
  .argument("<project>", "project folder or .c3p file")
  .addOption(new Option("--branch <branch>", "editor branch").choices(["stable", "beta", "lts"]).default("stable"))
  .option("--release <rNNN>", "exact editor release, e.g. r497 or r495-2 (overrides --branch)")
  .option("--use-project-release", "if the project was saved with a newer release, open it with that release", false)
  .addOption(new Option("--report <format>", "machine-readable report on stdout").choices(["json"]))
  .option("--timeout <seconds>", "give up after this long", (v) => Number(v), 60)
  .option("--headed", "show the browser window", false)
  .option("--profile <dir>", "browser profile directory", DEFAULT_PROFILE)
  .option("--no-install-bundled-addons", "decline the editor's prompt to install addons bundled in the project")
  .option("--keep-open", "leave the editor open until the window is closed (implies --headed)", false);
}

async function guarded(opts: OpenOpts, run: () => Promise<number>) {
  try {
    process.exitCode = await run();
  } catch (e) {
    const msg = (e as Error).message;
    if (opts.report === "json") console.log(JSON.stringify({ version: REPORT_VERSION, outcome: "tool-error", error: msg }, null, 2));
    else console.error(`c3cli: ${msg}`);
    process.exitCode = EXIT.toolError;
  }
}

withOpenOptions(program.command("open").description("Open a project (folder or .c3p) in the editor and report what happened"))
  .action((projectPath: string, opts: OpenOpts) => guarded(opts, () => runCommand(projectPath, opts)));

withOpenOptions(program.command("preview").description("Open a project, preview its first layout, and report runtime console errors"))
  .option("--seconds <n>", "how long to let the preview run", (v) => Number(v), 10)
  .action((projectPath: string, opts: OpenOpts & { seconds: number }) => guarded(opts, () => runCommand(projectPath, opts, { kind: "preview", seconds: opts.seconds })));

withOpenOptions(program.command("save").description("Open a project, save it with the editor, write the result to --to and diff it against the input"))
  .requiredOption("--to <path>", "where to write the saved project: a new folder for folder projects, a new .c3p for .c3p projects (never overwritten)")
  .action((projectPath: string, opts: OpenOpts & { to: string }) => guarded(opts, () => runCommand(projectPath, opts, { kind: "save", to: opts.to })));

type Then = { kind: "save"; to: string } | { kind: "preview"; seconds: number };

async function runCommand(projectPath: string, opts: OpenOpts, then?: Then): Promise<number> {
  const saveTo = then?.kind === "save" ? then.to : undefined;
  const project = await readProjectInfo(projectPath);
  if (saveTo) await checkSaveTarget(saveTo, project.kind);
  const notes: string[] = [];
  let release = opts.release ? exactRelease(opts.release) : await resolveBranch(opts.branch);
  release = await maybeUseProjectRelease(release, project.savedWithRelease, opts, notes);

  const headed = opts.headed || opts.keepOpen;
  const session = await launch({ profile: opts.profile, headed });
  const started = Date.now();
  try {
    const { page } = session;
    const collector = collect(page);
    const timeoutMs = opts.timeout * 1000;
    const startupDialogs = await loadEditor(page, release, timeoutMs);
    const staged = await stageProject(page, project, randomUUID());
    // Errors before this point come from the editor starting up, not from the project.
    const startup = { pageErrors: collector.pageErrors.splice(0), consoleErrors: collector.consoleErrors.splice(0) };
    const openedAt = Date.now();
    await clickOpen(page, project.kind);
    const result = await waitForOutcome(page, {
      projectName: project.name,
      assetUrl: release.assetUrl,
      timeoutMs: Math.max(1000, timeoutMs - (openedAt - started)),
      installBundledAddons: opts.installBundledAddons,
    });
    const openMs = Date.now() - openedAt;
    let outcome: Outcome = result.outcome;
    if (outcome === "timeout" && collector.pageErrors.length) outcome = "crashed";
    // Declining a bundled addon makes the editor say only "failed to open"; name the real cause.
    const declined = result.bundledAddons.filter((a) => !a.installed);
    if (outcome === "refused" && declined.length) outcome = "missing-addons";

    let save: { to: string; ok: boolean; written: string[]; diff: SaveDiff | null; error?: string } | undefined;
    if (saveTo && outcome === "opened") {
      try {
        const written = await saveInEditor(page, Math.max(10_000, timeoutMs / 2));
        await writeSaved(page, project.kind, saveTo);
        save = { to: path.resolve(saveTo), ok: true, written, diff: await diffProjects(project.path, saveTo) };
      } catch (e) {
        save = { to: path.resolve(saveTo), ok: false, written: [], diff: null, error: (e as Error).message };
      }
    }

    let preview: PreviewResult | undefined;
    if (then?.kind === "preview") {
      preview = outcome === "opened"
        ? await runPreview(session.context, page, then.seconds)
        : { started: false, url: null, seconds: then.seconds, log: [], consoleErrors: [], pageErrors: [], error: `not previewed: project did not open (${outcome})` };
    }

    const report = {
      version: REPORT_VERSION,
      project: { path: project.path, kind: project.kind, name: project.name, savedWithRelease: project.savedWithRelease && releaseName(project.savedWithRelease) },
      release: release.name,
      host: "hosted",
      outcome,
      durationMs: openMs,
      totalMs: Date.now() - started,
      filesStaged: staged,
      startupDialogs,
      startupPageErrors: startup.pageErrors,
      startupConsoleErrors: startup.consoleErrors,
      dialogs: result.dialogs,
      missingAddons: [
        ...parseMissingAddons(result.dialogs),
        ...declined.map((a) => ({ type: a.type ?? "Addon", name: a.name ?? "?", id: a.name ?? "?", author: a.author, declined: true })),
      ],
      bundledAddons: result.bundledAddons,
      log: collector.log,
      consoleErrors: collector.consoleErrors,
      pageErrors: collector.pageErrors,
      notes,
      ...(preview ? { preview } : {}),
      ...(saveTo ? { save: save ?? { to: path.resolve(saveTo), ok: false, written: [], diff: null, error: `not saved: project did not open (${outcome})` } } : {}),
    };
    if (opts.report === "json") console.log(JSON.stringify(report, null, 2));
    else printHuman(report);

    if (opts.keepOpen) await page.waitForEvent("close", { timeout: 0 });
    if (preview) {
      if (outcome !== "opened") return exitCode(outcome, true);
      if (!preview.started) return EXIT.crashed;
      return preview.pageErrors.length + preview.consoleErrors.length ? EXIT.warnings : EXIT.clean;
    }
    if (report.save && !report.save.ok) return outcome === "opened" ? EXIT.crashed : exitCode(outcome, true);
    return exitCode(outcome, result.dialogs.length + collector.pageErrors.length > 0);
  } finally {
    await session.page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry("c3cli", { recursive: true }).catch(() => {});
    }).catch(() => {});
    await session.close();
  }
}

// Never overwrite: folder targets must not exist (or be empty), file targets must not exist.
async function checkSaveTarget(to: string, kind: "folder" | "file") {
  if (kind === "file" && !to.toLowerCase().endsWith(".c3p")) throw new Error(`--to must be a .c3p path for a .c3p project: ${to}`);
  const exists = await access(to).then(() => true, () => false);
  if (!exists) return;
  if (kind === "folder" && (await readdir(to)).length === 0) return;
  throw new Error(`--to already exists, refusing to overwrite: ${to}`);
}

// Export the staged copy; for a .c3p the staged root holds just the one file.
async function writeSaved(page: import("playwright").Page, kind: "folder" | "file", to: string) {
  if (kind === "folder") { await exportStaged(page, to); return; }
  const tmp = await mkdtemp(path.join(os.tmpdir(), "c3cli-save-"));
  try {
    await exportStaged(page, tmp);
    const [file] = await readdir(tmp);
    await rename(path.join(tmp, file), to);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// A project saved with a newer release than the chosen one will be refused by the editor.
// Switch to the project's release when asked to (flag), or ask when someone is at the terminal.
async function maybeUseProjectRelease(release: Release, saved: number | null, opts: OpenOpts, notes: string[]): Promise<Release> {
  if (!saved || saved <= release.num) return release;
  const projectRelease = releaseName(saved);
  const msg = `project was saved with ${projectRelease}, newer than ${release.name}`;
  if (opts.useProjectRelease) {
    notes.push(`${msg}; using ${projectRelease} (--use-project-release)`);
    return exactRelease(projectRelease);
  }
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question(`${msg}. Open with ${projectRelease} instead? [Y/n] `)).trim().toLowerCase();
    rl.close();
    if (answer === "" || answer.startsWith("y")) {
      notes.push(`${msg}; switched to ${projectRelease} (answered at prompt)`);
      return exactRelease(projectRelease);
    }
  }
  notes.push(`${msg}; kept ${release.name}, expect a refusal (pass --use-project-release to switch)`);
  return release;
}

function exitCode(outcome: Outcome, hadNoise: boolean): number {
  switch (outcome) {
    case "opened": return hadNoise ? EXIT.warnings : EXIT.clean;
    case "crashed": case "timeout": return EXIT.crashed;
    default: return EXIT.refused;
  }
}

function printHuman(r: { startupPageErrors: string[]; preview?: PreviewResult; save?: { to: string; ok: boolean; written: string[]; diff: SaveDiff | null; error?: string }; outcome: string; project: { name: string | null; path: string }; release: string; durationMs: number; dialogs: { id: string; langKey: string | null; title: string; body: string }[]; missingAddons: { type: string; id: string }[]; bundledAddons: { name: string | null; version: string | null; installed: boolean }[]; pageErrors: string[]; consoleErrors: string[]; notes: string[] }) {
  console.log(`${r.outcome}  ${r.project.name ?? r.project.path}  (${r.release}, ${(r.durationMs / 1000).toFixed(1)}s)`);
  for (const n of r.notes) console.log(`  note: ${n}`);
  if (r.startupPageErrors.length) console.log(`  editor startup: ${r.startupPageErrors.length} page error(s) before the open (not counted), first: ${r.startupPageErrors[0].split("\n")[0]}`);
  for (const d of r.dialogs) console.log(`  dialog ${d.id}${d.langKey ? ` [${d.langKey}]` : ""}: ${d.title} — ${d.body.replace(/\s+/g, " ").slice(0, 160)}`);
  for (const a of r.bundledAddons) console.log(`  bundled addon ${a.name ?? "?"} ${a.version ?? ""}: ${a.installed ? "installed" : "declined"}`);
  if (r.missingAddons.length) console.log(`  missing: ${r.missingAddons.map((a) => `${a.type.toLowerCase()} ${a.id}`).join(", ")}`);
  if (r.pageErrors.length) console.log(`  ${r.pageErrors.length} page error(s), first: ${r.pageErrors[0].split("\n")[0]}`);
  if (r.consoleErrors.length) console.log(`  ${r.consoleErrors.length} console error(s)`);
  if (r.preview) {
    const p = r.preview;
    if (!p.started) console.log(`  preview failed: ${p.error}`);
    else console.log(`  preview ran ${p.seconds}s: ${p.pageErrors.length} uncaught error(s), ${p.consoleErrors.length} console error(s)`);
    for (const e of [...p.pageErrors, ...p.consoleErrors].slice(0, 10)) console.log(`    ! ${e.split("\n")[0].slice(0, 200)}`);
  }
  if (r.save?.ok && r.save.diff) {
    const d = r.save.diff;
    console.log(`  saved → ${r.save.to}: ${d.filesChanged} file(s) differ from input (${d.changed.length} changed, ${d.added.length} added, ${d.removed.length} removed)`);
    for (const f of d.changed) console.log(`    ~ ${f}`);
    for (const f of d.added) console.log(`    + ${f}`);
    for (const f of d.removed) console.log(`    - ${f}`);
  } else if (r.save) console.log(`  save failed: ${r.save.error}`);
}

await program.parseAsync();
