# Save / export

**Status:** `c3cli save` implemented for same-format save-back (2026-09-23): folder → folder,
`.c3p` → `.c3p`. `c3cli export` implemented for Web (HTML5) (2026-09-23). Other platforms
and format conversion are not started.

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
