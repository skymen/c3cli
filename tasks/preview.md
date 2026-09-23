# Preview

**Status:** `c3cli preview <project> [--seconds N] [--layout <name>]` implemented (2026-09-23),
code in `src/preview.ts`.

## Modes (skymen, 2026-09-23)
- Default: **whole-project preview** (Menu → Project → Preview,
  `title="Run a preview of the current project."`), which starts on the project's first
  layout.
- `--layout <name>`: make that layout the active view (double-click its
  `ui-treeitem.layout .tree-item-name` in the Project bar; the handler is on the name
  label, not the item; then wait for `ui-tab[active]` with that name) and press F5
  ("Preview layout"). The runtime's *first tick* is already on that layout: it starts
  there, it doesn't start the project and switch.

## When the editor refuses to preview
Some projects load but can't be previewed: the editor shows `#okDialog` "Failed to start
preview" (c3merge lab row 29, truncated tile data). `LivePreview.start` races the popup
against an editor dialog and fails at once with the dialog text, instead of waiting out
the 20 s popup timeout.

## Reaching the live runtime
The runtime instance is private, but `C3.Runtime.prototype.Tick` runs every frame.
c3cli wraps it once to catch `this`, keeps `this.GetIRuntime()` (the public scripting
API) in `globalThis.__c3cliRuntime`, and restores the method. It checks the preview page
first (DOM mode, e.g. 3d-lighting) and then each worker (worker mode, e.g. untitled).
`Preview.evalRuntime("return runtime.layout.name")` runs code against it. This is the
hook the Node library will build on. The report now has `startLayout` and
`runtimeIn: page|worker`. A preview whose runtime loads but never ticks
(`_runtime-error` throws in `beforeprojectstart`) is "crashed during startup", exit 3.

## Findings (2026-09-23)
- F5 opens a popup at `https://preview.construct.net/local.html`; `context.waitForEvent("page")`
  catches it. It works headless: the runtime logs `[C3 runtime] Hosted in worker, rendering
  with WebGL 2 [… SwiftShader …]`, which c3cli uses as the "started" signal.
- The runtime runs in `previewworker.js`. A worker's `console.error` and uncaught worker
  exceptions both surface on the popup page's `console` / `pageerror` events (checked by
  injecting errors), so nothing worker-specific is needed.
- Verified end to end (2026-09-23) on `fixtures/folder/_runtime-error`, a copy of anim-previewe
  whose `scripts/main.js` has a `runOnStartup` that calls `console.error` and throws in
  `beforeprojectstart`: 1 uncaught error and 1 console error reported, exit 1. The 15 real
  fixtures that open all preview with 0 errors.
- Modal dialogs left open after the open (`deprecatedFeaturesDialog`) swallow F5, so c3cli
  dismisses them first (they're already in the report).
- Exit codes: 0 clean, 1 runtime errors, 3 preview didn't start; open failures keep the
  open exit codes.

- Preview opens a popup/tab (`preview/` in the bundle). Catch with `context.on('page')`.
- Collect `console`/`pageerror` from the preview page for N seconds, then close.
- Runtime errors are the second half of "does this merge break the game" — some
  corruption loads in the editor and dies at runtime (bad action params, missing function).
- The engine source (which skymen has) is readable here: map runtime error messages back
  to the loader code path to know which invariant broke.
- Report: `{ started, seconds, consoleErrors[], pageErrors[], firstLayout }`.
