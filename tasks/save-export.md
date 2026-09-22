# Save / export

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
