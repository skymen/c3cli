# Observing what the editor did

**Status:** implemented for `open` (2026-09-23), in `src/observe.ts` + `src/lang.ts`.

## Findings (2026-09-23, hosted r495-2 and r497)
- Every open outcome so far shows up as a `dialog[open]` with a stable, unmangled id:
  `missingAddonsDialog`, `okDialog` (generic message box: invalid file, newer release,
  expression-name collision), `addonConfirmInstallDialog` (project bundles an addon),
  `welcomeTourDialog` (cold start). `progressDialog` ("Opening (N%)…") is transient and is
  ignored.
- **Opened** = `document.title === "<project name> - Construct 3"`, where the name comes from
  `project.c3proj` (it is "New project" for most fixtures, so it can't tell projects apart).
  After it matches, wait 2 s for post-open dialogs.
- **Blocked** = a non-transient dialog stays open for 750 ms without the title changing.
- **Lang keys**: each release serves `<rel>/loader/lang/precompiled-en-US.json`; dialog text
  is matched against its templates (`{n}` → wildcard, `[b]` markup stripped). A template's
  literal text must cover at least 50% of the text, or catch-all templates like `{0}: {1}`
  win. Lines are tried one by one when the whole text doesn't match (dialogs that append
  data). Keys seen: `ui.errors.failed-to-open-c3-project`,
  `ui.errors.project-saved-in-newer-release`, `ui.errors.expression-name-collision.message`,
  `ui.dialogs.missingAddons.header-text`, `ui.dialogs.addonConfirmInstall.header-text`.
- Bundled addons (`addonConfirmInstallDialog`, buttons `.okButton` / `.cancelButton`):
  installed by default, `--no-install-bundled-addons` declines (skymen, 2026-09-23). The
  prompt repeats on every run even after an install in the same profile. Declining makes
  the editor show only "failed to open"; c3cli reports that as `missing-addons` and names
  the declined addon.
- `deprecatedFeaturesDialog` shows up *after* a successful open on some older projects;
  that's reported as opened with warnings (exit 1).
- Editor-startup page errors: if the editor still becomes usable (LTS r449-5's
  flowchartView error), report them separately and don't fail the run. If the editor never
  becomes usable, the run fails as `editor-error` (skymen, 2026-09-23).
- Missing addons are parsed into `{type, name, id, author}` from lines like
  `Effect Foil Effect (dumivid_HolographicFoil) by dumivid`.
- Console noise on every load: `Failed to load resource: 400`, `No available adapters`
  (WebGPU in headless). They're kept in the report but don't affect the exit code.

## Signals
- **Console**: `page.on('console')`, keep everything; C3 prefixes its own lines with
  `[Construct]`. Uncaught errors via `page.on('pageerror')`.
- **`?log-pane`** flag: the editor has a log pane component; read its DOM instead of
  scraping console if it carries more (repairs, warnings during load).
- **Dialogs**: find the dialog component (`components/` in the bundle; the class/ID names
  are unobfuscated CSS). Capture title + body text + which buttons. Map known dialogs by
  their lang key (`lang/*.json` in the bundle has the strings → key lookup works across
  languages).
- **Opened**: project bar shows the project name; window title; or the "Project" tab
  in the properties bar. Pick the most stable, confirm on 2 releases.
- **Repaired**: heuristic = open then `save` and compare bytes to input (save-export.md),
  *plus* any log line mentioning repair/regenerate. Both are recorded separately.
- **Preview outcome**: preview.md.

## Report
```json
{
  "release": "r500", "host": "hosted|local",
  "outcome": "opened|refused|refused-by-edition|crashed|timeout",
  "durationMs": 8400,
  "dialogs": [{ "langKey": "...", "title": "...", "body": "...", "chosen": "OK" }],
  "log": ["[Construct] ..."],
  "consoleErrors": ["..."],
  "pageErrors": ["..."],
  "repaired": true,
  "saveDiff": { "filesChanged": 3, "paths": ["layouts/L1.json", "..."] }
}
```
Stable contract for c3merge's lab and CI. Version it.
