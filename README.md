# c3cli

Drive the Construct 3 editor (the hosted one at editor.construct.net) from the command
line, headless, and get a verdict back.

```sh
npm install && npm run build      # or run from source: npx tsx src/cli.ts …
c3cli open    <folder|.c3p> [--report json]
c3cli save    <folder|.c3p> --to <new folder|new .c3p>   # open, save with the editor, diff
c3cli preview <folder|.c3p> [--seconds 10]                # open, preview, collect runtime errors
c3cli export  <folder|.c3p> --to <new .zip|new folder>    # Web (HTML5) export [--minify --lossless --lossy --[no-]offline]
```

Daemon: keep warm editor tabs running so commands skip the browser and editor startup
(about 2.5 s per open instead of 5.5 s) and several projects can run at once:

```sh
c3cli daemon start --tabs 3 [--profile dir]   # background; log in ~/.config/c3cli/daemon.log
c3cli open game.c3p                            # uses the daemon automatically (--no-daemon to skip)
c3cli daemon status
c3cli daemon stop
```

Library (`import { C3Editor } from "c3cli"`): open, save, export, and drive live previews
(run code on the runtime, input, waitFor, screenshots). See [tasks/library.md](tasks/library.md).

Accounts (email/username + password only, no OAuth):

```sh
c3cli login  --profile ~/.config/c3cli/me   # reads C3CLI_USERNAME/C3CLI_PASSWORD or asks (hidden)
c3cli whoami --profile ~/.config/c3cli/me
c3cli export game.c3p --to out.zip --profile ~/.config/c3cli/me
```

Shared options: `--branch stable|beta|lts`, `--release r497`, `--use-project-release`,
`--no-install-bundled-addons`, `--timeout <s>`, `--headed`, `--keep-open`,
`--profile <dir>` (default: a fresh temporary profile per run).

Exit codes: 0 clean · 1 opened with warnings (post-open dialogs, page errors, runtime
errors in preview) · 2 refused (invalid, newer release, missing addons, name collision,
free-edition limit, login failed) · 3 crashed / timed out / editor error / preview, save or
export didn't happen · 4 tool error.

How it works: the project is copied into the page's origin-private file system, and the
editor's file/folder pickers are replaced with ones that return that copy. Then the
editor's own "Open local file/folder" menu item runs its normal open path. Outcomes are
read from the editor's dialogs, matched to lang keys from the running release. See
[DESIGN.md](DESIGN.md), [NOTES.md](NOTES.md) and [`tasks/`](tasks/).

Tests: `npm test` (unit tests for pure logic). Fixture sweep: `npx tsx scripts/sweep.ts <label>`
(needs `fixtures/`, which is gitignored; see `scripts/unzip-fixtures.ts`).
