# Getting a project into the editor

**Status:** implemented (2026-09-26): open by **dropping the real path** through CDP, no
copy, and write **through a Node bridge** (`src/bridge.ts`): in place, into a copy for
`save --to`, or into a caught drop for "save as". No OPFS left anywhere. Checked on stable
r495-2, beta r503 and LTS r449-5 (`scripts/check-open-save.ts`), through the daemon, and on
the UTRS repo root (3.8 GB with `.git`/`tools/`): opens, twice on one editor, nothing written.
Previously (2026-09-23): G, OPFS-backed picker shim, for both `.c3p` and folder projects.
Spikes: `scripts/spike-opfs.ts`, `scripts/spike-menu.ts`, `scripts/spike-real-folder.ts`,
`scripts/spike-drop-folder.ts`, `scripts/spike-write-perm.ts`, `scripts/spike-drop-write.ts`,
`scripts/spike-capture.ts`, `scripts/spike-cdp-binding.ts`.

## Drop through CDP (2026-09-26, hosted r495-2, Playwright 1.63, headless)
- `Input.dispatchDragEvent` (`dragEnter`, `dragOver`, `drop`) with
  `data: { items: [], files: [<absolute path>], dragOperationsMask: 1 }` is a browser-level
  drag of the real file or folder. `dataTransfer.items[0].getAsFileSystemHandle()` returns a
  real `FileSystemDirectoryHandle` for a folder: entries list, files read.
  Route A below failed only because it was an in-page synthetic drop.
- The editor opens what's dropped: `fixtures/lab-base` opened in 1.4 s (layouts, types, all
  there); a `.c3p` and UTRS without `.git`/`tools/` (282 MB) reached their missing-addons
  dialog in ~1 s. Nothing is copied, and C3 reads only what the project uses, so a repo
  root's `.git` or `tools/` cost nothing.
- **Read-only.** `queryPermission`/`requestPermission({ mode: "readwrite" })` → `denied` in
  headless, no prompt; CDP `Browser.setPermission` has no file-system permission name.
  Headed not tried (only the headless shell is installed; a prompt couldn't be clicked
  anyway). Why: the File System Access rule is that a drop or a picker grants read, and
  write needs the user to click a "let this site edit files?" prompt. Headless has no prompt
  to click, so the answer is always `denied`. Worked around below.
- The picker route (B/C) is still dead on 1.63: `AbortError: Intercepted by
  Page.setInterceptFileChooserDialog()`. With interception on, Chromium can't hand a folder
  handle back through DevTools, so it rejects the picker instead of opening a dialog.

## Writing through Node (2026-09-26, same setup)
An init script patches the File System Access prototypes, only for handles that come from a
drop (tracked in a `WeakMap` from the dropped root down through `getDirectoryHandle`,
`getFileHandle`, `entries`, `values`): `queryPermission`/`requestPermission` answer
`granted`; `createWritable` returns a `WritableStream` that buffers `write`/`seek`/`truncate`
and on `close` sends the bytes to Node (`context.exposeBinding`), which writes the real file;
`getFileHandle`/`getDirectoryHandle` with `create` and `removeEntry` go to Node too, then
the real (read-only) handle is fetched again. Handles stay real, so `instanceof`, cloning
into IndexedDB and reads are untouched. Node refuses paths outside the dropped root.
- Folder (lab-base, r449 format): select all, nudge 1 px, Ctrl+S (`ControlOrMeta`). C3
  wrote only what changed, straight into the folder on disk: `Layout 1.json` (x 95.43 →
  96.43), the c3proj (`savedWithRelease` 44905 → 49502, format upgrade), uistate files,
  and a new `llm-context.md` (r495-2 writes one on save). No dialog, no error.
- `.c3p` (battleship): the same Ctrl+S rewrote the dropped file in place (valid zip).
- Open reads nothing through the bridge; only writes do.
- What C3 calls (r500 `main.js`): `createWritable` ×1, `removeEntry` ×4, `getFileHandle` ×3,
  `getDirectoryHandle` ×2, `queryPermission` ×3, `requestPermission` ×5, `isSameEntry` ×2;
  never `move`, `seek`, `truncate`, `keepExistingData` or sync access handles. The bridge
  covers all of them; `removeEntry` (deleting a layout, say) isn't exercised yet.
- Chrome's own writer writes a temp file and swaps it in on close, so a crash never leaves a
  half-written file. The bridge should do the same (write `<name>.c3cli-tmp`, then rename).
- So OPFS isn't needed for open or save. "Save as" to another place still asks for a picker:
  either give it a real handle to the destination the same way (a drop the editor doesn't
  see, caught by a capture-phase listener) or keep OPFS just for that.
- The bridge binding is per browser context: with several tabs, map each page to its root
  (the binding's `source.page`).

## Implementation (2026-09-26)
- **Roots.** Each dropped path is a root (an id in the page's `WeakMap` of handles). Node
  decides per root where writes go: refused (default: C3 shows "Unable to save project",
  nothing on disk changes), in place (`save` without `--to`, `--keep-open`), or a mirror.
- **Mirror** (`save --to` on a folder): Node copies the project to the target (no `.git`,
  `COPYFILE_FICLONE`), a caught drop of the copy gives the page a real handle to it, and
  lookups (`getDirectoryHandle`, `getFileHandle`, `entries`…) resolve in the copy while it's
  set. Needed because C3 creates new files and folders on save (`llm-context.md`,
  `models3d`), which the original's read-only handles can't return. The input stays
  byte-for-byte untouched. The diff then only compares the files C3 wrote.
- **Caught drops** ("save as", `new`): a window capture-phase listener takes the drop
  (`preventDefault` + `stopImmediatePropagation`) when c3cli arms it, so the editor never
  sees it; the handle answers the next `showDirectoryPicker` / `showSaveFilePicker`. A
  `.c3p` target is created empty first so it can be dropped. The editor's title and dialogs
  don't change on a caught drop.
- **Did the editor take the drop?** The patched `getAsFileSystemHandle` records the root it
  tagged; c3cli fails after 5 s if the editor never asked for it.
- **Writes** go to Node in 8 MB base64 chunks, into `<name>.c3cli-tmp`, renamed on the last.
  `removeEntry` and `remove()` work (spike-capture).
- **Daemon.** The daemon's context installs the init script at launch; the client adds the
  `__c3cliFs` binding to its leased page over its own CDP connection, on an already loaded
  page (spike-cdp-binding), so the client's process writes the files. No protocol change.
- The drop point is the viewport's centre; it works with the start page showing, on all
  three branches, and with 3 tabs at once.
- Timings (r495-2): lab-base/untitled open in ~1 s; a folder with an extra 1 GB `tools/`
  and a `.git` in 1 s; the daemon's 6 parallel opens on 3 tabs in 5.3 s (10–11 s with OPFS).
  UTRS (LTS, with its bundled addons) takes 165 s, which is C3 loading it.
- "A second `open()` on the same `C3Editor` fails" (c3merge's `replay-merge.ts`, UTRS
  worktrees on LTS) doesn't reproduce: three opens on fixtures across releases, with the
  OPFS code too, and two opens of the UTRS repo root with the drop, all fine. Probably the
  OPFS copy of a big project.

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
- (Wrong, skymen 2026-09-26: the free edition never refuses to open a project, only to save
  or export one over its limits.) Free-edition limit dialog on open → report as `refused-by-edition`, distinct from
  `refused`.
