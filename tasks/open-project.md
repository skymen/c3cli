# Getting a project into the editor

**Status:** decided (2026-09-23). Winner: **G, OPFS-backed picker shim**, which works on
the hosted editor (r495-2) for both `.c3p` and folder projects. Spikes:
`scripts/spike-opfs.ts`, `scripts/spike-menu.ts`.

## Findings (2026-09-23)
- **B/C as written are dead.** In Playwright 1.63 the File System Access pickers never
  reach the `filechooser` event: Chromium rejects them with `AbortError: Intercepted by
  Page.setInterceptFileChooserDialog()` (headless and headed). Only `<input type=file>`
  surfaces as a filechooser.
- **G works:** stage the project in the origin-private file system
  (`navigator.storage.getDirectory()/c3cli/<run>/…`) from `page.evaluate`, then override
  `window.showDirectoryPicker` / `showOpenFilePicker` with an init script that returns
  that real, writable handle. Clicking the real menu item then runs the editor's own open
  path (`id:"open-project-folder"` / `"open-project-file"` in the bundle). Opens in <2.5 s.
  The folder route gives a writable directory handle, so save-back lands in OPFS and can
  be read out (save-export.md).
- Init scripts must be **strings**: tsx/esbuild's keepNames injects `__name()`, which is
  undefined in the page.
- Menu: `#mainMenuButton` → first `ui-menuitem[sub-menu]` (Project) → the item picked by
  its `title` attribute ("Choose a folder-based project…" / "Choose a file…"). The items
  have no lang-key attributes, so the English title text is the handle for now. Leave
  ~500 ms after opening the submenu, or the click lands during the animation and does
  nothing.
- Staging is one `evaluate` per file with base64, which is fine for ≤100 files (~2.5 s) and
  will need batching for big projects (backupadam has 1918 files).
- Cold start shows `#welcomeTourDialog`; Escape dismisses it.
- `.c3p` files zipped with backslash separators open fine through the editor. `unzip`
  chokes on them, so c3cli uses `src/unzip.ts`.
- A and E aren't needed; D is deferred with local hosting.

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
