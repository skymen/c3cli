# Save / export

**Status:** `c3cli save` implemented for same-format save-back (2026-09-23): folder → folder,
`.c3p` → `.c3p`; in place without `--to`, and through the write bridge instead of OPFS
(2026-09-26, skymen chose "no `--to` means in place"). `saveAs` takes a folder or a `.c3p`;
`c3cli new` creates a project and saves it (2026-09-26). `c3cli export` implemented for Web
(HTML5) (2026-09-23), and works on r449 LTS, which has no zip/folder choice (always a zip).
Other platforms: implemented 2026-10-06, see [export-platforms.md](export-platforms.md). Format conversion (folder ↔ `.c3p`) is dropped (skymen, 2026-09-26): it's
zipping/unzipping, no editor needed.

## Free edition unbundles addons (2026-10-06)
`save()` / `saveAs()` refuse a project with `bundleAddons: true` when the editor's edition
isn't paid (logged out, a free account, or not known yet): `ok: false`, `refused:
"free-edition-unbundles-addons"`, exit 2, nothing written (no `--to` target created).
`allowUnbundle` / `--allow-unbundle` saves anyway with a warning in `warnings`. Tested on
`3d-lighting` (r449-3, bundles one effect) on r495-2, logged out: refused in place and with
`--to`, input untouched; with the flag, saved with `bundleAddons: false`. Not tested with a
paid account yet (needs a login).

## What else a free-edition save changes (2026-10-06)
Code (an agent read r449-5, r495-2, r500, r505; same logic in all): the free check is one
`self.app` method (`x_` in r500, `vA` r495-2, `WU` r505, `lj` r449-5); 19 calls in
projectResources.js (all the save code), 6 in main.js. Two affect what's written:
- `bundleAddons` and each addon's `bundled` (known), and no `addons/` files.
- **Breakpoints**: events, groups, conditions and actions lose `"breakpoint": true`
  (`Rbt(){return!Wu.x_()&&this.zJs}`), and a free editor refuses them already when it opens
  the project, showing `freeEditionLimitDialog` ("Not available in the Free Edition:
  Breakpoints…"). Checked: `battleship` with 3 breakpoints, Save as on r495-2 → paid 3,
  free 0; the open reports the dialog (exit 1). Ctrl+S only drops them from sheets it rewrites.
Everything else is UI-only or export-only: loader style (forced "splash" at export only),
layers, effects, web fonts, families, timelines, eases, meshes, restricted plugins,
bookmarks, scripting limits; the editor never strips them on save.
Compared on 10 projects (r495-2, Save as, paid twice + free, one after the other): besides
the addon flags, only layout `.uistate.json` view positions (~12 px, the free top bar) and
one event sheet `sid` that differs between two paid saves too.

## Menu clicks without fixed sleeps (2026-10-06)
The menu helpers click each entry as soon as it's shown (`clickMenuEntry` in `src/editor.ts`),
and `dismissDialogs` waits for the dialog to close instead of 300 ms. Timed on r495-2 with
`untitled.c3p`, 3 rounds: Save as 3.0 → 2.0 s, export 1.6 → 1.1 s (warm), New 5.5 → 4.0 s.
`check-languages.ts` passes on stable in en-US, fr-FR, ja-JP, zh-CN, de-DE.

## Since 2026-09-26
The OPFS sections below are history: saves now go through `src/bridge.ts`
(open-project.md). `saveAs` uses a caught drop of the target, not an OPFS folder. The
`saveAs` flake with several tabs (NotFoundError from OPFS, or a menu click under
`#progressDialog`) is gone: no OPFS, menu clicks wait for the progress dialog, and the Save
as click is retried once. `scripts/check-saveas.ts`: 40 open + saveAs on 3 tabs, 0 failures.

## New project (2026-09-26)
Menu → Project → New (`main-menu.project-menu.new-tooltip`) → `#newProjectDialog`: name in
`#npProjectNameInput`, then `.okButton` (Create). The rest keeps C3's defaults (preset
`sd-landscape-16-9`, 854×480, landscape, event sheet). Then Save as. Works on stable, beta
and LTS; the result reopens with `savedWithRelease` = the release.

## Save as project folder (2026-09-23)
`project.saveAs(to)` (library only) uses Menu → Project → Save as → "Save as project
folder..." (`title="Save the project to a folder."`), with the picker shim returning a
fresh, empty OPFS folder `c3cli/<runId>-saveas`. It writes **every** file from memory.
Ctrl+S (`save`) on a *folder* project only rewrites files C3 considers changed, on stable
and beta alike, which c3merge's lab found out the hard way. Saving a *.c3p* rewrites every
file (skymen). A fresh profile first shows a "Set up backups"
`#confirmDialog`; c3cli clicks "Save anyway" (`.cancelConfirmButton`).

## Web export (2026-09-23, r495-2)
- Menu → Project → Export (`title="Export the project for publishing to a platform."`) →
  `#exportSelectPlatformDialog`: platform tiles are `ui-iconviewitem`s with no id or data
  attributes, so "Web (HTML5)" is picked by its English label → `.nextButton`.
- `#exportStandardOptionsDialog`: `#exportTo` (`zip`|`folder`), `#exportMinifyMode`
  (`none`|`bundle`|`simple`|`advanced`|`debug-advanced`), `#exportLosslessImageFormat`
  (`png`|`webp`), `#exportLossyImageFormat` (`jpeg`|`webp`|`avif`), checkboxes
  `#exportDeduplicateImages`, `#exportOptimizeImages`, `#exportOfflineSupport`. c3cli always
  exports a zip and unzips it itself for folder output, and only changes options that were
  passed.
- `#webExportReportDialog` → `a.downloadExportedProject` (a blob URL with `download=`) →
  Playwright `download` event → `saveAs`. untitled exports in <3 s, 24 files, 1.6 MB.
- **Free edition** (`#freeEditionLimitDialog`) appears (a) after choosing the platform when
  the project is over the event cap (sokoban-gen, ~98 events), and (b) after the options
  step when a paid-only option is chosen: every minify mode except `none`. Both →
  `refused-by-edition`, exit 2.
- Checked that the export runs: test-gizmos exported to a folder, served over localhost and
  loaded headless; the runtime starts and the project's scripts log.

## How it works (2026-09-23)
Projects are opened from an OPFS copy through the shimmed pickers (open-project.md), so the
editor holds a **writable** handle to that copy. Ctrl/Cmd+S makes the editor write through
it: into the folder for folder projects, or rewriting the zip in place for `.c3p`.
c3cli waits until the staged files stop changing (1.5 s quiet), copies them out to `--to`
(never overwriting), and diffs them against the input file by file. `.c3p` files are
unzipped first so both kinds diff as project files. No Save As, download capture, or
`showSaveFilePicker` shim is needed.

What an r495-2 save typically changes on older projects (untitled, saved r432.2):
`savedWithRelease`, new default keys (`functionsName`, `models3d` folder, `multitexturing`,
`fixedFramerate`), key reordering, `zAxisScale: normalized → regular` (a migration?),
plus new files `.gitignore`, `llm-context.md`, `models3d.uistate.json`,
`layouts/uistate/*.instancesBar.json`. c3merge's fidelity test will need to know which of
these are canonicalisation and which are semantic.

Answers from skymen (2026-09-23):
- `zAxisScale: normalized → regular` is a known migration. C3 deprecated normalized z when
  it moved towards 3D, so an old project saved in a new release gets it.
- Files the editor adds on save (`.gitignore`, `llm-context.md`, …) are **not** ignored by
  the diff; they're part of what the editor produces.
- The free-edition event cap only matters for **export**, not open/save/preview.

## Original notes

**Status:** not started (2026-09-21)

## Save as `.c3p`
Menu → Save as → "Download a copy" (or "Save as single file") → `showSaveFilePicker`.
Playwright: `filechooser` for save pickers is *not* supported the same way; alternatives:
- override `window.showSaveFilePicker` via `addInitScript` to return a writable handle backed
  by an in-page buffer, then read the buffer out with `page.evaluate` → write to disk.
  A minimal `FileSystemWritableFileStream` shim (`write`, `close`) is ~30 lines.
- or the "download" path if the editor still has a `<a download>` fallback when the API is
  missing: delete `showSaveFilePicker` in `addInitScript` and catch `page.on('download')`.
  Cheapest; try first.

## Save to folder
Requires a real directory handle from `showDirectoryPicker` (open-project.md route C). If
route C works, "save" is just Ctrl+S after opening from the folder, and the on-disk files
are the result. This is the fidelity test c3merge wants: open → save → `git diff`.

## Export
Menu → Export → choose HTML5 (later: others) → wizard dialogs → download. Wizard steps
change between releases; drive by lang keys. Capture with `page.on('download')`.
Later; c3merge doesn't need it.
