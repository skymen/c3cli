#!/usr/bin/env node
// c3cli: drive the Construct 3 editor from the command line.
import { Command, Option } from "commander";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diffProjects, type SaveDiff } from "./diff.ts";
import { LOSSLESS_FORMATS, LOSSY_FORMATS, MINIFY_MODES, exportWeb, type ExportOptions, type ExportResult } from "./export.ts";
import { unzipProject } from "./unzip.ts";
import { ReleaseNotFound, clickOpen, exportStaged, launch, loadEditor, saveInEditor, stageProject } from "./editor.ts";
import { runPreview, type PreviewResult } from "./preview.ts";
import { collect, parseMissingAddons, waitForOutcome, type Outcome } from "./observe.ts";
import { isLoggedIn, logIn, waitForAccount } from "./login.ts";
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
  profile?: string;
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
  .option("--profile <dir>", "use (and keep) this browser profile; default: a fresh temporary profile per run")
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

withOpenOptions(program.command("preview").description("Open a project, preview it (the whole project, or one layout), and report runtime errors"))
  .option("--seconds <n>", "how long to let the preview run", (v) => Number(v), 10)
  .option("--layout <name>", "preview this layout directly (like \"Preview layout\" in the editor) instead of the whole project")
  .action((projectPath: string, opts: OpenOpts & { seconds: number; layout?: string }) => guarded(opts, () => runCommand(projectPath, opts, { kind: "preview", seconds: opts.seconds, layout: opts.layout })));

withOpenOptions(program.command("export").description("Open a project and export it for the web (HTML5), as a zip or unzipped into a folder"))
  .requiredOption("--to <path>", "a new .zip file, or a new/empty folder to unzip the export into (never overwritten)")
  .addOption(new Option("--minify <mode>", "script minify mode").choices(MINIFY_MODES))
  .addOption(new Option("--lossless <format>", "lossless image format").choices(LOSSLESS_FORMATS))
  .addOption(new Option("--lossy <format>", "lossy image format").choices(LOSSY_FORMATS))
  .option("--offline", "turn offline support on")
  .option("--no-offline", "turn offline support off")
  .action((projectPath: string, opts: OpenOpts & ExportOptions & { to: string }) => guarded(opts, () => runCommand(projectPath, opts, {
    kind: "export", to: opts.to, options: { minify: opts.minify, lossless: opts.lossless, lossy: opts.lossy, offline: opts.offline },
  })));

withOpenOptions(program.command("save").description("Open a project, save it with the editor, write the result to --to and diff it against the input"))
  .requiredOption("--to <path>", "where to write the saved project: a new folder for folder projects, a new .c3p for .c3p projects (never overwritten)")
  .action((projectPath: string, opts: OpenOpts & { to: string }) => guarded(opts, () => runCommand(projectPath, opts, { kind: "save", to: opts.to })));

type Then = { kind: "save"; to: string } | { kind: "preview"; seconds: number; layout?: string } | { kind: "export"; to: string; options: ExportOptions };

interface AccountOpts { profile: string; branch: Branch; release?: string; timeout: number; headed: boolean; report?: "json" }

function withAccountOptions(cmd: Command): Command {
  return cmd
    .requiredOption("--profile <dir>", "browser profile that keeps the session")
    .addOption(new Option("--branch <branch>", "editor branch").choices(["stable", "beta", "lts"]).default("stable"))
    .option("--release <rNNN>", "exact editor release (overrides --branch)")
    .addOption(new Option("--report <format>", "machine-readable report on stdout").choices(["json"]))
    .option("--timeout <seconds>", "give up after this long", (v) => Number(v), 60)
    .option("--headed", "show the browser window", false);
}

withAccountOptions(program.command("login").description("Log in with username/email + password (no OAuth) and keep the session in --profile. Reads C3CLI_USERNAME / C3CLI_PASSWORD, or asks (password hidden)"))
  .action((opts: AccountOpts) => guarded(opts as OpenOpts, () => loginCommand(opts)));

withAccountOptions(program.command("whoami").description("Show which account the editor is logged in to with --profile"))
  .action((opts: AccountOpts) => guarded(opts as OpenOpts, () => whoamiCommand(opts)));

async function loginCommand(opts: AccountOpts): Promise<number> {
  const username = process.env.C3CLI_USERNAME || (await ask("Construct account username or email: ", false));
  const password = process.env.C3CLI_PASSWORD || (await ask("Password (hidden): ", true));
  if (!username || !password) throw new Error("no credentials: set C3CLI_USERNAME and C3CLI_PASSWORD, or run at a terminal to be asked");
  const release = opts.release ? exactRelease(opts.release) : await resolveBranch(opts.branch);
  const session = await launch({ profile: opts.profile, headed: opts.headed });
  try {
    await loadEditor(session.page, release, opts.timeout * 1000);
    const r = await logIn(session.page, username, password, opts.timeout * 1000);
    const report = { version: REPORT_VERSION, release: release.name, profile: path.resolve(opts.profile), ...r };
    if (opts.report === "json") console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`${r.outcome}  ${r.account.name || "?"} (${r.account.edition} edition)`);
      if (r.dialog) console.log(`  dialog ${r.dialog.id}: ${r.dialog.text}`);
      if (r.error) console.log(`  error: ${r.error}`);
    }
    return r.outcome === "login-failed" ? EXIT.refused : EXIT.clean;
  } finally {
    await session.close();
  }
}

async function whoamiCommand(opts: AccountOpts): Promise<number> {
  const release = opts.release ? exactRelease(opts.release) : await resolveBranch(opts.branch);
  const session = await launch({ profile: opts.profile, headed: opts.headed });
  try {
    await loadEditor(session.page, release, opts.timeout * 1000);
    const account = await waitForAccount(session.page, 15_000);
    if (opts.report === "json") console.log(JSON.stringify({ version: REPORT_VERSION, loggedIn: isLoggedIn(account), ...account }, null, 2));
    else console.log(isLoggedIn(account) ? `${account.name} (${account.edition} edition)` : "not logged in (guest, free edition)");
    return isLoggedIn(account) ? EXIT.clean : EXIT.refused;
  } finally {
    await session.close();
  }
}

// Ask on stderr so stdout stays clean for --report json.
async function ask(question: string, hidden: boolean): Promise<string> {
  if (!process.stdin.isTTY) return "";
  if (hidden) return askHidden(question);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

// Raw-mode read with no echo at all. (readline redraws the prompt together with the typed
// line, so filtering its output still leaks the text.)
function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let buf = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") { finish(); return resolve(buf); }
        if (ch === "\u0003") { finish(); return reject(new Error("cancelled")); }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function runCommand(projectPath: string, opts: OpenOpts, then?: Then): Promise<number> {
  const saveTo = then?.kind === "save" ? then.to : undefined;
  const project = await readProjectInfo(projectPath);
  if (saveTo) await checkSaveTarget(saveTo, project.kind);
  if (then?.kind === "export") await checkSaveTarget(then.to, then.to.toLowerCase().endsWith(".zip") ? "zip" : "folder");
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
    let startupDialogs: string[];
    try {
      startupDialogs = await loadEditor(page, release, timeoutMs);
    } catch (e) {
      if (e instanceof ReleaseNotFound) throw e;
      // The editor never became usable: nothing about the project can be said.
      const report = {
        version: REPORT_VERSION, release: release.name, host: "hosted", outcome: "editor-error",
        error: (e as Error).message.split("\n")[0],
        startupPageErrors: collector.pageErrors, startupConsoleErrors: collector.consoleErrors, notes,
      };
      if (opts.report === "json") console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`editor-error  ${release.name}: ${report.error}`);
        for (const err of collector.pageErrors.slice(0, 5)) console.log(`  ! ${err.split("\n")[0]}`);
      }
      return EXIT.crashed;
    }
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
        ? await runPreview(session.context, page, { seconds: then.seconds, layout: then.layout })
        : { started: false, url: null, seconds: then.seconds, requestedLayout: then.layout ?? null, startLayout: null, runtimeIn: null, log: [], consoleErrors: [], pageErrors: [], error: `not previewed: project did not open (${outcome})` };
    }

    let exported: (Omit<ExportResult, "zipPath"> & { to: string; files: number | null }) | undefined;
    if (then?.kind === "export") {
      const toPath = path.resolve(then.to);
      if (outcome !== "opened") {
        exported = { outcome: "export-failed", to: toPath, files: null, suggestedName: null, reportText: null, dialogs: [], error: `not exported: project did not open (${outcome})` };
      } else {
        const tmp = await mkdtemp(path.join(os.tmpdir(), "c3cli-export-"));
        try {
          const { zipPath, ...res } = await exportWeb(page, then.options, path.join(tmp, "export.zip"), timeoutMs);
          let files: number | null = null;
          if (zipPath) {
            if (toPath.toLowerCase().endsWith(".zip")) await moveFile(zipPath, toPath);
            else files = await unzipProject(zipPath, toPath);
          }
          exported = { ...res, to: toPath, files };
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      }
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
      ...(exported ? { export: exported } : {}),
      ...(saveTo ? { save: save ?? { to: path.resolve(saveTo), ok: false, written: [], diff: null, error: `not saved: project did not open (${outcome})` } } : {}),
    };
    if (opts.report === "json") console.log(JSON.stringify(report, null, 2));
    else printHuman(report);

    if (opts.keepOpen) await page.waitForEvent("close", { timeout: 0 });
    if (exported) {
      if (outcome !== "opened") return exitCode(outcome, true);
      if (exported.outcome === "refused-by-edition") return EXIT.refused;
      if (exported.outcome !== "exported") return EXIT.crashed;
      return exitCode(outcome, result.dialogs.length + collector.pageErrors.length > 0);
    }
    if (preview) {
      if (outcome !== "opened") return exitCode(outcome, true);
      if (!preview.started || preview.error) return EXIT.crashed;
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
async function checkSaveTarget(to: string, kind: "folder" | "file" | "zip") {
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
    await moveFile(path.join(tmp, file), to);
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

function printHuman(r: { export?: { outcome: string; to: string; files: number | null; reportText: string | null; dialogs: { id: string; text: string }[]; error?: string }; startupPageErrors: string[]; preview?: PreviewResult; save?: { to: string; ok: boolean; written: string[]; diff: SaveDiff | null; error?: string }; outcome: string; project: { name: string | null; path: string }; release: string; durationMs: number; dialogs: { id: string; langKey: string | null; title: string; body: string }[]; missingAddons: { type: string; id: string }[]; bundledAddons: { name: string | null; version: string | null; installed: boolean }[]; pageErrors: string[]; consoleErrors: string[]; notes: string[] }) {
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
    else console.log(`  preview ran ${p.seconds}s from "${p.startLayout}" (runtime in ${p.runtimeIn}): ${p.pageErrors.length} uncaught error(s), ${p.consoleErrors.length} console error(s)${p.error ? ` — ${p.error}` : ""}`);
    for (const e of [...p.pageErrors, ...p.consoleErrors].slice(0, 10)) console.log(`    ! ${e.split("\n")[0].slice(0, 200)}`);
  }
  if (r.export) {
    const x = r.export;
    if (x.outcome === "exported") console.log(`  exported → ${x.to}${x.files !== null ? ` (${x.files} files)` : ""}`);
    else console.log(`  export ${x.outcome}${x.error ? `: ${x.error}` : ""}`);
    for (const d of x.dialogs) console.log(`    dialog ${d.id}: ${d.text.replace(/\s+/g, " ").slice(0, 200)}`);
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
