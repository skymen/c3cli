# Observing what the editor did

**Status:** not started (2026-09-21)

## Signals
- **Console**: `page.on('console')`, keep everything; C3 prefixes its own lines with
  `[Construct]`. Uncaught errors via `page.on('pageerror')`.
- **`?log-pane`** flag: the editor has a log pane component; read its DOM instead of
  scraping console if it carries more (repairs, warnings during load).
- **Dialogs**: find the dialog component (`components/` in the bundle; the class/ID names
  are unobfuscated CSS). Capture title + body text + which buttons. Map known dialogs by
  their lang key (`lang/*.json` in the bundle has the strings → key lookup works across
  languages).
- **Opened**: project bar shows the project name; window title; or the "Project" tab
  in the properties bar. Pick the most stable, confirm on 2 releases.
- **Repaired**: heuristic = open then `save` and compare bytes to input (save-export.md),
  *plus* any log line mentioning repair/regenerate. Both are recorded separately.
- **Preview outcome**: preview.md.

## Report
```json
{
  "release": "r500", "host": "hosted|local",
  "outcome": "opened|refused|refused-by-edition|crashed|timeout",
  "durationMs": 8400,
  "dialogs": [{ "langKey": "...", "title": "...", "body": "...", "chosen": "OK" }],
  "log": ["[Construct] ..."],
  "consoleErrors": ["..."],
  "pageErrors": ["..."],
  "repaired": true,
  "saveDiff": { "filesChanged": 3, "paths": ["layouts/L1.json", "..."] }
}
```
Stable contract for c3merge's lab and CI. Version it.
