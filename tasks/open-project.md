# Getting a project into the editor

**Status:** not started (2026-09-21). Rank the routes by experiment; keep two working.

## Routes

### A. Drop event with a synthetic File (hosted-safe)
`page.evaluate`: fetch the `.c3p` from a local URL Playwright serves (`page.route` on a fake
origin), build `new File([blob], "x.c3p")`, a `DataTransfer` with it, dispatch
`dragenter/dragover/drop` on the editor's drop target (whole window? find the element the
`addEventListener("drop")` is attached to). Risk: the handler reads `dataTransfer.items` and
may call `item.getAsFileSystemHandle()` (2 `items` usages in the bundle) → synthetic items
have none → check the fallback to `.files`. Playwright also has
`page.dispatchEvent(sel, 'drop', { dataTransfer })` with a handle created via
`page.evaluateHandle`. Folder drop: a `DataTransferItem` with `webkitGetAsEntry()` for a
directory can't be synthesized → drop route is `.c3p` only. Fine: c3cli zips folders.

### B. `showOpenFilePicker` interception (hosted-safe)
Playwright's `filechooser` event fires for File System Access pickers in Chromium;
`chooser.setFiles(path)` returns a real handle. Route: click Menu → Project → Open → choose
"Local file" (or whatever the current menu is) → catch chooser → set `.c3p`. Needs menu
automation that survives UI changes (use lang keys / `data-*`, not text).

### C. `showDirectoryPicker` interception (folder projects, no zip)
Same as B via "Open local project folder". Playwright supports directories in
`setFiles` since ~1.45 (verify for directory pickers specifically, not only
`webkitdirectory`). Best route for save-back too (C3 saves in place). If this works, it's
the primary route for both open and save and no zipping is ever needed.

### D. Dev-mode `?project=` (local copy only)
See editor-hosting.md. Zero UI automation. Version-locked.

### E. Internal fetch-and-open (`Vz.Knr` in r500)
`page.evaluate` calling the mapped internal with a URL served by Playwright. Works on hosted
too if the name map is right; breaks each release until remapped. Keep as the lab's
"fast path", never as the only path.

### F. PWA `launchQueue`
Only for installed PWA; not scriptable. Ignore.

## Also handle
- "Recover unsaved project?" / "restore backup" dialogs on start — dismiss deterministically
  (or use a fresh profile per lab run: cheap, skip the service-worker cache? no — copy a
  warmed profile template).
- First-run tour / dialogs: `?firstrun` flag exists; set `c3-done-first-run` in the
  editor's storage in the profile template.
- Free-edition limit dialog on open → report as `refused-by-edition`, distinct from
  `refused`.
