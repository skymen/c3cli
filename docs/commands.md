# Commands

Every command that opens a project takes a project **folder** (the folder holding
`project.c3proj`) or a **`.c3p`** file. The input is never modified. c3cli copies the
project into the browser, and the editor works on that copy.

## Options shared by open, save, preview and export

| Option | Default | |
|---|---|---|
| `--branch stable\|beta\|lts` | `stable` | Editor branch |
| `--release <rNNN>` | | An exact release, such as `r497` or `r495-2`. Overrides `--branch`. |
| `--use-project-release` | off | Open with exactly the release the project was saved with, older or newer. Needed for LTS-only projects, for example ones using SDK v1 addons. |
| `--report json` | | Print the [report](report.md) as JSON on stdout instead of the human summary |
| `--timeout <seconds>` | 60 | Give up after this long |
| `--headed` | off | Show the browser window |
| `--keep-open` | off | Leave the editor open until you close the window (implies `--headed`) |
| `--profile <dir>` | temporary | Use and keep this browser profile. Without it, each run gets a fresh profile, deleted afterwards. |
| `--no-install-bundled-addons` | installs | Decline the editor's offer to install addons bundled in the project. The open then fails with `missing-addons`, naming them. |
| `--no-daemon` | uses it | Don't use the [daemon](#daemon) even if it's running |

**Release choice.** When the project was saved with a newer release than the one chosen,
the editor refuses it. At a terminal, c3cli asks `Open with rX instead? [Y/n]`. Otherwise
it keeps the chosen release, lets the editor refuse, and notes it in the report. c3cli
never saves a project with an older release than the one it was saved with, and never
changes `savedWithRelease`.

## open

```sh
c3cli open <project> [options]
```

Opens the project and reports what the editor did:
- the outcome;
- every dialog, with its lang key;
- missing addons and bundled addons;
- console and page errors;
- how long it took.

```
opened  New project  (r495-2, 1.9s)
missing-addons  New project  (r495-2, 1.7s)
  dialog missingAddonsDialog [ui.dialogs.missingAddons.header-text]: Missing addons — …
  missing: effect better_shine
```

Outcomes: `opened`, `missing-addons`, `refused-newer-release`, `refused-by-edition`,
`refused`, `crashed`, `timeout`, and `editor-error` (the editor itself never became usable).

## save

```sh
c3cli save <project> --to <path> [options]
```

Opens the project, saves it with the editor (Ctrl+S), and writes the result to `--to`: a
new folder for a folder project, a new `.c3p` for a `.c3p`. It then lists which files differ
from the input: changed, added and removed. Use it to see what C3 rewrites when a project
passes through a given release.

```
$ c3cli save untitled --to saved
opened  New project  (r495-2, 1.5s)
  saved → /Users/me/saved: 5 file(s) differ from input (2 changed, 3 added, 0 removed)
    ~ project.c3proj
    ~ project.uistate.json
    + .gitignore
    + llm-context.md
    + models3d.uistate.json
```

Ctrl+S on a folder project only rewrites the files C3 considers changed. To get every file
as C3 holds it in memory, use `saveAs` in the [library](library.md).

## preview

```sh
c3cli preview <project> [--seconds 10] [--layout <name>] [options]
```

Runs a preview for `--seconds` and reports:
- uncaught errors and console errors from the runtime;
- which layout it started on;
- whether the runtime ran in the page or in a worker.

Without `--layout` it previews the whole project from its first layout, like Menu →
Project → Preview. With `--layout` it previews that layout directly, like "Preview layout".

```
$ c3cli preview untitled.c3p --seconds 3
opened  New project  (r495-2, 1.8s)
  preview ran 3s from "Layout 1" (runtime in worker): 0 uncaught error(s), 0 console error(s)
```

The exit code is 1 when the runtime logged errors, and 3 when the preview didn't start. For
example, the editor refuses to preview projects with broken tilemap data.

## export

```sh
c3cli export <project> --to <new .zip | new folder> [--minify <mode>] [--lossless <fmt>] [--lossy <fmt>] [--[no-]offline] [options]
```

Web (HTML5) export through the editor's export wizard. Options that aren't passed keep the
project's own settings.

| Option | Values |
|---|---|
| `--minify` | `none`, `bundle`, `simple`, `advanced`, `debug-advanced` |
| `--lossless` | `png`, `webp` |
| `--lossy` | `jpeg`, `webp`, `avif` |
| `--offline` / `--no-offline` | offline support on or off |

On a guest or free account, export is refused (`refused-by-edition`, exit 2) when:
- the project is over the event limit;
- a paid-only option is chosen, which is every minify mode except `none`.

Log in with [`c3cli login`](#login-and-whoami) and pass `--profile`.

## Daemon

```sh
c3cli daemon start [--tabs 3] [--profile <dir>] [--branch <b> | --release <r>] [--headed]
c3cli daemon status [--report json]
c3cli daemon stop
c3cli daemon run ...        # the same, in the foreground (what `start` launches)
```

The daemon keeps one Chromium with `--tabs` editor tabs loaded and ready. Project commands
use it automatically when it's running, unless they pass `--no-daemon`, `--profile`,
`--headed` or `--keep-open`, which need a private browser. Each command borrows a tab and
gives it back. The daemon then replaces that tab with a fresh editor in the background,
so nothing carries over from one project to the next. Tabs switch release when a command
asks for another one.

- Socket: `~/.config/c3cli/daemon.sock`. Log: `~/.config/c3cli/daemon.log`.
- An open takes about 2.5 s through the daemon, against 5.5 s on its own. Six projects on
  three tabs take 10–11 s.

## login and whoami

```sh
c3cli login  --profile <dir> [--branch|--release] [--timeout] [--headed] [--report json]
c3cli whoami --profile <dir> [--report json]
```

`login` logs in with a Construct account's username or email and password, and keeps the
session in `--profile`. It reads `C3CLI_USERNAME` and `C3CLI_PASSWORD` from the environment,
or asks at the terminal with the password hidden. There's no `--password` flag, so it
doesn't end up in shell history or process lists. Google and other sign-in providers
aren't supported.

`whoami` shows the account and edition a profile is logged in with. It exits 0 when logged
in, and 2 for a guest.

With a `.env` file that isn't committed:

```sh
node --env-file=.env bin/c3cli.js login --profile ~/.config/c3cli/me
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Clean |
| 1 | Opened with warnings: dialogs after opening (such as deprecated features), page errors, runtime errors during preview |
| 2 | Refused: invalid project, newer release, missing addons, expression name collision, free-edition limit, login failed |
| 3 | Crashed, timed out, editor error, or the requested preview, save or export didn't happen |
| 4 | Tool error (bad arguments, `--to` already exists…) |

Console noise the editor always prints doesn't affect the exit code. Examples are failed
resource loads and the missing WebGPU adapter in headless mode. It's still in the report.
