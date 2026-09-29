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


## Normal

- [save] With the editor loaded with `?disable-ui-animations` (2026-09-27), the fixed 300/500 ms sleeps in `clickMainMenuItem`, `clickProjectMenuItem`, `clickProjectSubmenuItem` and the Save as / New helpers are probably unneeded: wait for the entry like `clickMainSubmenuItem` does, and measure. About 0.8 s per save as, export or new
- [save] Saving in the free edition (a profile that isn't logged in, i.e. every temporary one) unbundles the project's addons: the editor writes `bundleAddons` as `!free && setting` and each addon's `bundled` the same way, so the save has `bundleAddons: false`, every addon `bundled: false` and no `addons/` folder, and then fails with "Missing addons" wherever they aren't installed. Bundling is a paid feature (checked in the editor code, r495-2; seen on r445, r449-4, r449-5 and r495-2 with Flechita, Vicky, Stardiver and con-sule). Not a c3cli bug: log in (`c3cli login --profile`) to save such a project. But say so: when the input has `bundleAddons: true` and the editor runs the free edition, warn in the `save` report, or refuse without `--allow-unbundle` (2026-09-27)

## Later


## Ideas

- Export to other platforms (Cordova, desktop, Arcade…): skymen says ignore for now

- Watch mode: re-open on file change while editing JSON by hand, and report whether C3 still accepts it. Maybe a Node API feature only (skymen, 2026-09-26)
- Daemon: auto-restart a tab whose editor crashed mid-lease; health check in `daemon status`. Not before skymen has used daemons more (2026-09-26)
- Integration test suite (opt-in, needs network): turn `scripts/check-*.ts` into `node --test` cases. Too slow for now (skymen, 2026-09-26)

## Notes

- The free edition never refuses to open a project; it only refuses to save or export one over its limits (skymen, 2026-09-26).
- Saving a project that bundles its addons needs a logged-in profile: the free edition unbundles it, and c3cli won't work around that (no patching the editor, no restoring the bundle after the save) (skymen, 2026-09-27).
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
