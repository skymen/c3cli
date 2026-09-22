# c3cli — backlog

Drive the Construct 3 editor from the command line: open a project, watch how it loads,
save, export, preview, log in. Consumers: `~/Documents/c3merge` (lab experiments, fidelity
tests, CI), and anything else that wants "run this in C3 and tell me what happened".
Design notes in [DESIGN.md](DESIGN.md); detail docs in [`tasks/`](tasks/).

Tags: `[host]` which editor build runs and where · `[open]` getting a project into the editor ·
`[observe]` detecting outcomes (dialogs, log, console, repairs) · `[save]` save / save-as /
export · `[preview]` run the project and read the runtime console · `[auth]` login, edition
limits · `[internal]` calling editor internals, demangling · `[cli]` command surface, daemon ·
`[docs]`

## Now

- [host] Decide primary host: hosted `editor.construct.net` (version-following) vs local self-hosted copy in `~/Documents/C3 Versions/C3-r500` in `?mode=dev` (version-locked, but exposes `?project=`) — plan is both, hosted primary ([tasks/editor-hosting.md](tasks/editor-hosting.md))
- [open] Experiment: rank the four open routes — drop event with synthetic `File`, `showOpenFilePicker` interception, `showDirectoryPicker` interception, dev-mode `?project=` — and pick one that works on the hosted editor ([tasks/open-project.md](tasks/open-project.md))
- [observe] Detect "project opened" / "failed" / "repaired" reliably: dialog DOM, `?log-pane`, console, and the editor's own log ([tasks/observe.md](tasks/observe.md))
- [cli] `c3cli open <folder|.c3p> [--report json]` end to end, headless, exits with a verdict ([tasks/cli-surface.md](tasks/cli-surface.md))

## Normal

- [save] Save back: `.c3p` via `showSaveFilePicker` interception, and save-to-folder via `showDirectoryPicker` — needed for c3merge's fidelity test (open → save → diff) ([tasks/save-export.md](tasks/save-export.md))
- [preview] Preview a layout headless, capture runtime console errors, timebox, report ([tasks/preview.md](tasks/preview.md))
- [auth] Persistent browser profile; login flow for skymen's account when free-edition limits bite; document what the free edition refuses to open ([tasks/auth.md](tasks/auth.md))
- [internal] Per-release name map for the few internals we need (open-from-URL, project model, log), built with the demangle tool in `~/Documents/C3 Versions/C3-r500 copy/demangle`; fail loudly when a name is missing on a new release ([tasks/internal-api.md](tasks/internal-api.md))
- [cli] Daemon mode: keep one editor tab alive, `c3cli` commands talk to it — opening the editor cold is slow (~10 s+) and the lab runs dozens of projects ([tasks/cli-surface.md](tasks/cli-surface.md#daemon))
- [observe] Structured report: `{opened, dialogs[], logLines[], consoleErrors[], repaired: bool, durationMs}` — the contract c3merge consumes ([tasks/observe.md](tasks/observe.md#report))

## Later

- [save] Export (HTML5 zip, others) via menu automation + download capture ([tasks/save-export.md](tasks/save-export.md#export))
- [host] Pin a release: `c3cli --release r500` runs the local copy; `--release stable|beta` uses hosted with the release picker ([tasks/editor-hosting.md](tasks/editor-hosting.md))
- [cli] `c3cli eval <js>` against the editor page for ad-hoc experiments; `c3cli screenshot`
- [cli] Scripted edits ("open, rename object type X, save") for generating merge fixtures inside the real editor — only if the internal API turns out stable enough
- [docs] README, and a "how the editor loads a project" write-up from what the lab finds

## Ideas

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
