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

- [open] Install unbundled SDK v2 addons from files (drop onto the editor, reload): standalone command, daemon, library, and `--addons <folder|zip>` on every command that opens a project ([tasks/install-addons.md](tasks/install-addons.md))

- [save] Save across formats (folder → `.c3p` and back): only same-format save exists today ([tasks/save-export.md](tasks/save-export.md))
- [internal] Per-release name map for the few internals we need (open-from-URL, project model, log), built with the demangle tool in `~/Documents/C3 Versions/C3-r500 copy/demangle`; fail loudly when a name is missing on a new release ([tasks/internal-api.md](tasks/internal-api.md))
- [observe] Report contract v1 exists (`--report json`); still missing `repaired`. Sort which save diffs are canonicalisation and which are real changes ([tasks/observe.md](tasks/observe.md#report))
- [open] Staging is one `evaluate` per ~8 MB batch of base64; measure on big projects (backupadam has 1918 files) and consider `page.route` streaming
- [cli] Menu items are found by English `title` text; find a language-independent handle (lang keys are available, see observe.md)

## Later

- [cli] Daemon: auto-restart a tab whose editor crashed mid-lease; health check in `daemon status`
- [cli] Integration test suite (opt-in, needs network): turn `scripts/check-*.ts` into `node --test` cases

- [cli] `c3cli eval <js>` against the editor page for ad-hoc experiments; `c3cli screenshot`
- [cli] Scripted edits ("open, rename object type X, save") for generating merge fixtures inside the real editor — only if the internal API turns out stable enough
- [docs] README, and a "how the editor loads a project" write-up from what the lab finds

## Ideas

- Export to other platforms (Cordova, desktop, Arcade…): skymen says ignore for now

- Run as a GitHub Action service: `c3cli open` in CI to gate PRs on "the project opens in C3"
- Diff C3's own save against input to learn C3's canonical formatting per release automatically
- Watch mode: re-open on file change while editing JSON by hand

## Notes

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
