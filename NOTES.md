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

- [auth] skymen tests with the real account: switching accounts, login by email, `logout` (the shared session itself, the daemon and paid features passed on 2026-10-06). See [tasks/auth.md](tasks/auth.md)

## Normal

- [save] Linux exports sometimes sit at "Adding files..." until the timeout (2 of ~12 runs, 2026-10-06); retrying worked. Watch the runtime download (requests to downloads.scirra.com) and retry or report it when it stalls. See [tasks/export-platforms.md](tasks/export-platforms.md)
- [open] Now and then the editor ignores the project drop with nothing in the way (3 of 12 CLI runs in one batch, 0 of 36 after). `open` now drops up to 3 times and says so in the report notes ("took the project on drop 2"): watch for those notes to find the cause (2026-10-06)
- [host] `loadEditor` still sleeps a fixed 1.5 s once the menu button shows, on every tab load (so after every project in the pool). Wait for what it's for instead, and measure (2026-10-06)
- [auth] The keyring store for Windows and Linux has only run on macOS: try it on a Windows machine and a Linux desktop, and the 0600-file fallback on a Linux without a Secret Service (2026-10-06)

## Later

- [save] Linux and NW.js exports download their runtime (126 MB+) at every run: a Playwright-route disk cache crashed the page, so seed the editor's own runtime cache (localforage in the profile) instead. "Maybe later" (skymen, 2026-10-07). See [tasks/export-platforms.md](tasks/export-platforms.md)


## Ideas

- Watch mode: re-open on file change while editing JSON by hand, and report whether C3 still accepts it. Maybe a Node API feature only (skymen, 2026-09-26)
- Daemon: auto-restart a tab whose editor crashed mid-lease; health check in `daemon status`. Not before skymen has used daemons more (2026-09-26)
- Integration test suite (opt-in, needs network): turn `scripts/check-*.ts` into `node --test` cases. Too slow for now (skymen, 2026-09-26)

## Notes

- The free edition never refuses to open a project; it only refuses to save or export one over its limits (skymen, 2026-09-26).
- Saving a project that bundles its addons needs a logged-in profile: the free edition unbundles it, and c3cli won't work around that (no patching the editor, no restoring the bundle after the save) (skymen, 2026-09-27).
- A free-edition save changes only two things in the files: addon bundling, and breakpoints (dropped). Everything else the free edition limits is blocked in the UI or at export, never stripped on save (code of r449-5 to r505, and 10 projects compared, 2026-10-06).
- Export options that aren't given keep what the editor shows (its defaults, or a kept profile's last choices on r488+); no reset to C3's defaults. Warnings stop exports unless `--accept-warnings` (skymen, 2026-10-07).
- No guard for breakpoints: they matter less than bundled addons, and skymen is fine with a free save dropping them as long as nothing else changes (2026-10-06).
- `scripts/spike-{save,export,layout,multitab,preview}.ts` use the OPFS helpers removed on 2026-09-26 (projects are dropped now). They record past findings and no longer run.
- The Settings dialog's "Show in-progress languages" adds more languages than the 17 `check-languages.ts` tests (the ones `main.html` ships). Not tested.
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
