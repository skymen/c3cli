# Preview

**Status:** `c3cli preview <project> [--seconds N]` implemented (2026-09-23). `--layout` is
not done: F5 previews the active layout, which after an open is the first one.

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
