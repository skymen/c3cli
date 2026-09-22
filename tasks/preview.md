# Preview

**Status:** not started (2026-09-21)

- Preview opens a popup/tab (`preview/` in the bundle). Catch with `context.on('page')`.
- Collect `console`/`pageerror` from the preview page for N seconds, then close.
- Runtime errors are the second half of "does this merge break the game" — some
  corruption loads in the editor and dies at runtime (bad action params, missing function).
- The engine source (which skymen has) is readable here: map runtime error messages back
  to the loader code path to know which invariant broke.
- Report: `{ started, seconds, consoleErrors[], pageErrors[], firstLayout }`.
