# c3cli

Drive the Construct 3 editor (the hosted one at editor.construct.net) from the command
line, headless, and get a verdict back.

```sh
npm install && npm run build      # or run from source: npx tsx src/cli.ts …
c3cli open    <folder|.c3p> [--report json]
c3cli save    <folder|.c3p> --to <new folder|new .c3p>   # open, save with the editor, diff
c3cli preview <folder|.c3p> [--seconds 10]                # open, preview, collect runtime errors
```

Shared options: `--branch stable|beta|lts`, `--release r497`, `--use-project-release`,
`--no-install-bundled-addons`, `--timeout <s>`, `--headed`, `--keep-open`,
`--profile <dir>` (default `~/.config/c3cli/profile`).

Exit codes: 0 clean · 1 opened with warnings (post-open dialogs, page errors, runtime
errors in preview) · 2 refused (invalid, newer release, missing addons, name collision) ·
3 crashed / timed out / preview or save didn't happen · 4 tool error.

How it works: the project is copied into the page's origin-private file system, and the
editor's file/folder pickers are replaced with ones that return that copy. Then the
editor's own "Open local file/folder" menu item runs its normal open path. Outcomes are
read from the editor's dialogs, matched to lang keys from the running release. See
[DESIGN.md](DESIGN.md), [NOTES.md](NOTES.md) and [`tasks/`](tasks/).

Tests: `npm test` (unit tests for pure logic). Fixture sweep: `npx tsx scripts/sweep.ts <label>`
(needs `fixtures/`, which is gitignored; see `scripts/unzip-fixtures.ts`).
