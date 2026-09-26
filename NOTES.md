# c3cli — backlog

Drive the Construct 3 editor from the command line and from Node: open a project, watch how
it loads, save, export, preview, log in. **A product in its own right** (skymen, 2026-09-23),
not a helper for c3merge. `~/Documents/c3merge` is one consumer (lab experiments, fidelity
tests) and uses it only as a dev dependency; c3cli never depends on c3merge.
Design notes in [DESIGN.md](DESIGN.md); detail docs in [`tasks/`](tasks/).

Tags: `[host]` which editor build runs and where · `[open]` getting a project into the editor ·
`[observe]` detecting outcomes (dialogs, log, console, repairs) · `[save]` save / save-as /
export · `[preview]` run the project and read the runtime console · `[auth]` login, edition
limits · `[internal]` calling editor internals, demangling · `[cli]` command surface, daemon ·
`[docs]`

## Now

- [open] Open by dropping the real path through CDP (`Input.dispatchDragEvent`) instead of copying the project into OPFS: works on the hosted editor for folders and `.c3p`, nothing copied, so the `.git`/`tools/` crash on a repo root (3.5 GB for Under The Red Sky) goes away. The dropped handle is read-only (no prompt to click in headless), so C3's writes go through a Node bridge that answers its permission checks and writes the real files: in-place Ctrl+S works for folders and `.c3p` (spike 2026-09-26). OPFS stays only for "save as" elsewhere, maybe not even that. The `saveAs` NotFoundError flake below may go with it. Check LTS/beta and the daemon's tabs ([tasks/open-project.md](tasks/open-project.md#drop-through-cdp-2026-09-26-hosted-r495-2-playwright-163-headless), spike 2026-09-26)
- [cli] Editor language: a fresh profile takes the first supported language in `navigator.languages` (Playwright's default locale is the system's), and every text handle is English: menu `title`s, "Account"/"Log in", the "Web (HTML5)" tile, and dialog → lang-key matching (en-US file only). Important (skymen, 2026-09-26). Every string has a lang key (`main-menu.project-menu.open-local-folder-tooltip`, `…save-as-folder-tooltip`, `…export-tooltip`, `main-menu.account-menu`, `user-account.menu.log-in`, `exporters.html5.name`) and the editor sets `<html lang>`: look each text up in `loader/lang/precompiled-<lang>.json`, and launch fresh profiles with `locale: "en-US"`. Check the hosted editor serves the other languages' files at that path. Test: a fresh profile in every language C3 supports (16 in r500: de-DE, en-US, fr-FR, hr-HR, hu-HU, ru-RU, cs-CZ, es-ES, pt-BR, nl-NL, it-IT, sv-SE, tr-TR, uk-UA, zh-CN, zh-TW; read the list from the release, it may grow) runs open, save as, export and login without breaking (skymen, 2026-09-26). Next after the planning pass

## Normal

- [open] Install unbundled SDK v2 addons from files (drop onto the editor, reload): standalone command, daemon, library, and `--addons <folder|zip>` on every command that opens a project ([tasks/install-addons.md](tasks/install-addons.md))

- [save] `c3cli new <folder|file.c3p> [--release rX]`: create a new project in C3 and save it, as a scaffold. The output is exactly what that release writes for an empty project, a clean starting point for tools, templates and test fixtures (skymen, 2026-09-26). Menu → New project, then the existing Save as path
- [save] `saveAs` flakes with several tabs: the menu click times out while a `#progressDialog` still covers the page, or `page.evaluate` fails with "NotFoundError: A requested file or directory could not be found". Wait for the progress dialog to close before clicking; retry once. Seen in c3merge's lab (2 of 126 saves, r495-2, 3 tabs) and uid experiment (4 tabs) (2026-09-25)

## Later


## Ideas

- Export to other platforms (Cordova, desktop, Arcade…): skymen says ignore for now

- Watch mode: re-open on file change while editing JSON by hand, and report whether C3 still accepts it. Maybe a Node API feature only (skymen, 2026-09-26)
- Daemon: auto-restart a tab whose editor crashed mid-lease; health check in `daemon status`. Not before skymen has used daemons more (2026-09-26)
- Integration test suite (opt-in, needs network): turn `scripts/check-*.ts` into `node --test` cases. Too slow for now (skymen, 2026-09-26)

## Notes

- The free edition never refuses to open a project; it only refuses to save or export one over its limits (skymen, 2026-09-26).
- Verified in r500 `main.js`: search params read by the editor — `project`, `layout`,
  `eventsheet` (dev mode only; `project` loads `exampleProjects/debug/<name>.capx` through
  the internal fetch-and-open), `mode=dev`, and flags `safe-mode`, `debug`, `debug-defend`,
  `log-pane`, `perf`, `firstrun`, `oneworker`, `disable-asyncify`, `disable-ui-animations`,
  `slow-animations`, `startTour`, `testanimationmode`, `default-layout`. Hash:
  `open-example-browser`. No public open-from-URL.
- Open entry points present in the bundle: `addEventListener("drop")` reading
  `dataTransfer.items`/`files`, `showOpenFilePicker` ×2, `showDirectoryPicker` ×4,
  `showSaveFilePicker` ×1, PWA `launchQueue.setConsumer` accepting a single `.c3p`.
- The local self-hosted copies (`~/Documents/C3 Versions/C3-r449-5|r496|r497|r500`) are
  full editor builds with a service-worker loader; dev mode needs the right origin/port —
  skymen knows the setup.
- The engine source helps for preview/runtime errors, not for editor loading (the editor is
  the obfuscated bundle; grep it for literal strings like `"savedWithRelease"`).
