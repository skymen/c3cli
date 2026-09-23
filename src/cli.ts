#!/usr/bin/env node
// c3cli: drive the Construct 3 editor from the command line.
import { Command, Option } from "commander";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { C3Editor, REPORT_VERSION, checkTarget, resolveRelease, type ExportReport, type SaveReport } from "./api.ts";
import { DEFAULT_SOCKET, DaemonSource, daemonStatus, runDaemon, startDaemon, stopDaemon } from "./daemon.ts";
import type { SaveDiff } from "./diff.ts";
import { launch, loadEditor } from "./editor.ts";
import { LOSSLESS_FORMATS, LOSSY_FORMATS, MINIFY_MODES, type ExportOptions } from "./export.ts";
import { isLoggedIn, logIn, waitForAccount } from "./login.ts";
import type { Outcome } from "./observe.ts";
import type { PreviewResult } from "./preview.ts";
import { readProjectInfo } from "./project.ts";
import { exactRelease, releaseName, resolveBranch, type Branch, type Release } from "./release.ts";

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
  daemon: boolean;
}

const program = new Command("c3cli").description("Drive the Construct 3 editor from the command line");

// Options shared by every command that opens a project.
function withOpenOptions(cmd: Command): Command {
  return cmd
  .argument("<project>", "project folder or .c3p file")
  .addOption(new Option("--branch <branch>", "editor branch").choices(["stable", "beta", "lts"]).default("stable"))
  .option("--release <rNNN>", "exact editor release, e.g. r497 or r495-2 (overrides --branch)")
  .option("--use-project-release", "open the project with exactly the release it was saved with", false)
  .addOption(new Option("--report <format>", "machine-readable report on stdout").choices(["json"]))
  .option("--timeout <seconds>", "give up after this long", (v) => Number(v), 60)
  .option("--headed", "show the browser window", false)
  .option("--profile <dir>", "use (and keep) this browser profile; default: a fresh temporary profile per run")
  .option("--no-install-bundled-addons", "decline the editor's prompt to install addons bundled in the project")
  .option("--keep-open", "leave the editor open until the window is closed (implies --headed)", false)
  .option("--no-daemon", "use a private browser even if the daemon is running");
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

const daemon = program.command("daemon").description("Keep a warm editor running in the background, shared by every c3cli command");

interface DaemonOpts { tabs: number; profile?: string; branch: Branch; release?: string; headed: boolean; report?: "json" }

function withDaemonOptions(cmd: Command): Command {
  return cmd
    .option("--tabs <n>", "editor tabs, i.e. projects open at once", (v) => Number(v), 3)
    .option("--profile <dir>", "browser profile for all tabs (logins live here); default: a temporary one")
    .addOption(new Option("--branch <branch>", "release to warm the tabs with").choices(["stable", "beta", "lts"]).default("stable"))
    .option("--release <rNNN>", "exact release to warm the tabs with (overrides --branch)")
    .option("--headed", "show the browser window", false);
}

withDaemonOptions(daemon.command("start").description("Start the daemon in the background"))
  .action((opts: DaemonOpts) => guarded(opts as unknown as OpenOpts, async () => {
    const running = await daemonStatus().catch(() => null);
    if (running) { printStatus(running, "already running"); return EXIT.clean; }
    const args = [`--tabs`, String(opts.tabs), `--branch`, opts.branch];
    if (opts.release) args.push("--release", opts.release);
    if (opts.profile) args.push("--profile", path.resolve(opts.profile));
    if (opts.headed) args.push("--headed");
    printStatus(await startDaemon(args, DEFAULT_SOCKET), "started");
    return EXIT.clean;
  }));

withDaemonOptions(daemon.command("run").description("Run the daemon in the foreground (what `start` launches)"))
  .action((opts: DaemonOpts) => guarded(opts as unknown as OpenOpts, async () => {
    const warm = await resolveRelease(opts);
    await runDaemon({ socket: DEFAULT_SOCKET, tabs: opts.tabs, profile: opts.profile, headed: opts.headed, warm });
    await new Promise(() => {}); // runs until stopped
    return EXIT.clean;
  }));

daemon.command("status").description("Show whether the daemon is running and what its tabs are doing")
  .addOption(new Option("--report <format>", "machine-readable report on stdout").choices(["json"]))
  .action((opts: { report?: "json" }) => guarded(opts as OpenOpts, async () => {
    const status = await daemonStatus().catch(() => null);
    if (opts.report === "json") console.log(JSON.stringify({ running: !!status, ...status }, null, 2));
    else if (status) printStatus(status, "running");
    else console.log("not running");
    return status ? EXIT.clean : EXIT.refused;
  }));

daemon.command("stop").description("Stop the daemon")
  .action(() => guarded({} as OpenOpts, async () => {
    console.log((await stopDaemon()) ? "stopped" : "not running");
    return EXIT.clean;
  }));

function printStatus(s: { pid: number; startedAt: string; profile: string; tabs: { id: string; busy: boolean; release: string | null }[] }, state: string) {
  console.log(`daemon ${state} (pid ${s.pid}, since ${s.startedAt}), profile ${s.profile}`);
  for (const t of s.tabs) console.log(`  ${t.id}: ${t.busy ? "busy" : "free"}${t.release ? `, ${t.release}` : ""}`);
}

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
  const info = await readProjectInfo(projectPath);
  if (then?.kind === "save") await checkTarget(then.to, info.kind);
  if (then?.kind === "export") await checkTarget(then.to, then.to.toLowerCase().endsWith(".zip") ? "zip" : "folder");
  const notes: string[] = [];
  let release = await resolveRelease(opts);
  release = await maybeUseProjectRelease(release, info.savedWithRelease, opts, notes);

  const started = Date.now();
  const { editor, via } = await getEditor(opts);
  const timeoutMs = opts.timeout * 1000;
  try {
    const project = await editor.open(projectPath, {
      release: release.name, installBundledAddons: opts.installBundledAddons, timeoutMs,
    });
    try {
      const outcome = project.report.outcome;
      const opened = outcome === "opened";
      const notOpened = `project did not open (${outcome})`;

      let save: SaveReport | undefined;
      if (then?.kind === "save") {
        save = opened ? await project.save(then.to, { timeoutMs: Math.max(10_000, timeoutMs / 2) })
          : { to: path.resolve(then.to), ok: false, written: [], diff: null, error: `not saved: ${notOpened}` };
      }
      let preview: PreviewResult | undefined;
      if (then?.kind === "preview") {
        preview = opened ? await project.runPreview({ seconds: then.seconds, layout: then.layout })
          : { started: false, url: null, seconds: then.seconds, requestedLayout: then.layout ?? null, startLayout: null, runtimeIn: null, log: [], consoleErrors: [], pageErrors: [], error: `not previewed: ${notOpened}` };
      }
      let exported: ExportReport | undefined;
      if (then?.kind === "export") {
        exported = opened ? await project.export(then.to, then.options, { timeoutMs })
          : { outcome: "export-failed", to: path.resolve(then.to), files: null, suggestedName: null, reportText: null, dialogs: [], error: `not exported: ${notOpened}` };
      }

      const report = {
        ...project.report,
        notes: [...notes, ...project.report.notes.filter((n) => !notes.some((m) => m.startsWith(n.split(";")[0])))],
        via,
        totalMs: Date.now() - started,
        ...(preview ? { preview } : {}),
        ...(exported ? { export: exported } : {}),
        ...(save ? { save } : {}),
      };
      if (opts.report === "json") console.log(JSON.stringify(report, null, 2));
      else printHuman(report);

      if (opts.keepOpen && opened) await project.page.waitForEvent("close", { timeout: 0 });
      if (outcome === "editor-error") return EXIT.crashed;
      const noisy = report.dialogs.length + report.pageErrors.length > 0;
      if (exported) {
        if (!opened) return exitCode(outcome, true);
        if (exported.outcome === "refused-by-edition") return EXIT.refused;
        if (exported.outcome !== "exported") return EXIT.crashed;
        return exitCode(outcome, noisy);
      }
      if (preview) {
        if (!opened) return exitCode(outcome, true);
        if (!preview.started || preview.error) return EXIT.crashed;
        return preview.pageErrors.length + preview.consoleErrors.length ? EXIT.warnings : EXIT.clean;
      }
      if (save && !save.ok) return opened ? EXIT.crashed : exitCode(outcome, true);
      return exitCode(outcome as Outcome, noisy);
    } finally {
      await project.close();
    }
  } finally {
    await editor.close();
  }
}

// The daemon's warm editor when it's running, unless this run needs its own browser
// (a specific profile, a visible window, or --no-daemon).
async function getEditor(opts: OpenOpts): Promise<{ editor: C3Editor; via: "daemon" | "local" }> {
  const ownBrowser = !opts.daemon || opts.profile || opts.headed || opts.keepOpen;
  if (!ownBrowser) {
    const source = await DaemonSource.connect().catch(() => null);
    if (source) return { editor: C3Editor.fromSource(source), via: "daemon" };
  }
  return { editor: await C3Editor.launch({ profile: opts.profile, headed: opts.headed || opts.keepOpen }), via: "local" };
}

// --use-project-release: exactly the release the project was saved with, older or newer.
// Otherwise a project saved with a newer release will be refused by the editor: ask when
// someone is at the terminal.
async function maybeUseProjectRelease(release: Release, saved: number | null, opts: OpenOpts, notes: string[]): Promise<Release> {
  if (!saved || saved === release.num) return release;
  const projectRelease = releaseName(saved);
  if (opts.useProjectRelease) {
    notes.push(`project was saved with ${projectRelease}; using ${projectRelease} instead of ${release.name} (--use-project-release)`);
    return exactRelease(projectRelease);
  }
  if (saved < release.num) return release;
  const msg = `project was saved with ${projectRelease}, newer than ${release.name}`;
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

function printHuman(r: { via?: string; tab?: string; error?: string; export?: { outcome: string; to: string; files: number | null; reportText: string | null; dialogs: { id: string; text: string }[]; error?: string }; startupPageErrors: string[]; preview?: PreviewResult; save?: { to: string; ok: boolean; written: string[]; diff: SaveDiff | null; error?: string }; outcome: string; project: { name: string | null; path: string }; release: string; durationMs: number; dialogs: { id: string; langKey: string | null; title: string; body: string }[]; missingAddons: { type: string; id: string }[]; bundledAddons: { name: string | null; version: string | null; installed: boolean }[]; pageErrors: string[]; consoleErrors: string[]; notes: string[] }) {
  console.log(`${r.outcome}  ${r.project.name ?? r.project.path}  (${r.release}, ${(r.durationMs / 1000).toFixed(1)}s${r.via === "daemon" ? `, daemon ${r.tab}` : ""})`);
  if (r.error) console.log(`  error: ${r.error}`);
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
