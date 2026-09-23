# Save / export

**Status:** `c3cli save` implemented for same-format save-back (2026-09-23): folder → folder,
`.c3p` → `.c3p`. Converting between formats and Export are not started.

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
