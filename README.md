# c3cli

Drive the Construct 3 editor from the command line and from Node, and get a verdict back.
It uses the real hosted editor (editor.construct.net) in a headless Chromium.

- **open**: does this project open in C3, on this release? If not, why: missing addons, a
  newer release, invalid files, the free edition's limits.
- **save**: open, save with the editor, and see which files C3 rewrote.
- **preview**: run the project (or one layout) and collect runtime errors.
- **export**: Web (HTML5) export to a zip or a folder.
- A **daemon** that keeps warm editor tabs, and a **Node library** to script previews
  (run code on the runtime, send input, take screenshots).

```
$ c3cli open battleship.c3p
opened  New project  (r495-2, 1.9s)

$ c3cli open better-shine-addon-bug.c3p --no-install-bundled-addons
missing-addons  New project  (r495-2, 1.7s)
  dialog missingAddonsDialog [ui.dialogs.missingAddons.header-text]: Missing addons — The project you are opening uses the following addons that are not installed. …
  missing: effect better_shine
```

## Install

You need Node 22+. c3cli isn't on npm yet, so install it from a checkout:

```sh
git clone <c3cli repository> c3cli
cd c3cli
npm install
npx playwright install chromium   # the browser c3cli drives
npm run build
npm link                          # puts `c3cli` on your PATH
```

Or run it from source without building: `npx tsx src/cli.ts open game.c3p`.

## Use

```sh
c3cli open    <folder|.c3p> [--report json]
c3cli save    <folder|.c3p> --to <new folder|new .c3p>   # open, save with the editor, diff with the input
c3cli preview <folder|.c3p> [--seconds 10] [--layout "Level 1"]
c3cli export  <folder|.c3p> --to <new .zip|new folder> [--minify none|bundle|simple|advanced] [--offline]
```

The input project is never modified, and `--to` never overwrites anything. Every command
copies the project into the browser first.

Common options:

| Option | |
|---|---|
| `--branch stable\|beta\|lts` | Which editor release (default: stable) |
| `--release r495-2` | An exact release |
| `--use-project-release` | Exactly the release the project was saved with |
| `--report json` | A machine-readable report on stdout |
| `--timeout <s>` | Give up after this long (default 60) |
| `--headed` | Show the browser window; `--keep-open` leaves it open |
| `--profile <dir>` | Use and keep this browser profile (logins live there); default: a fresh one per run |
| `--no-install-bundled-addons` | Decline the editor's offer to install addons bundled in the project |

A project saved with a newer release than the one chosen is refused by the editor. At a
terminal, c3cli asks whether to switch to the project's release. c3cli never saves a
project with an older release than it was saved with.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Clean |
| 1 | Opened, with warnings (dialogs after opening, page errors, runtime errors in preview) |
| 2 | Refused (invalid project, newer release, missing addons, name collision, free-edition limit, login failed) |
| 3 | Crashed, timed out, editor error, or the preview, save or export didn't happen |
| 4 | Tool error |

The full reference is [docs/commands.md](docs/commands.md), and the JSON report is described
in [docs/report.md](docs/report.md).

## Daemon

Keep warm editor tabs in the background. Commands then skip the browser and editor
startup (about 2.5 s per open instead of 5.5 s), and several projects can run at once:

```sh
c3cli daemon start --tabs 3       # log in ~/.config/c3cli/daemon.log
c3cli open game.c3p               # uses the daemon automatically (--no-daemon to skip it)
c3cli daemon status
c3cli daemon stop
```

## Accounts

Guests and free accounts are limited (25 and 50 events), which mostly matters for export.
Log in once into a profile, then pass that profile to other commands:

```sh
c3cli login  --profile ~/.config/c3cli/me    # reads C3CLI_USERNAME / C3CLI_PASSWORD, or asks (hidden)
c3cli whoami --profile ~/.config/c3cli/me
c3cli export game.c3p --to out.zip --profile ~/.config/c3cli/me
```

Only email or username with a password is supported, no Google or other sign-ins. There is
no `--password` flag, so the password never ends up in shell history. Use a dedicated
account for automation: anything that runs c3cli can read the password while it runs.

## Library

```ts
import { C3Editor } from "c3cli";

const editor = await C3Editor.launch();              // or C3Editor.connect() to use the daemon
const project = await editor.open("game.c3p");
if (project.report.outcome === "opened") {
  const preview = await project.preview({ layout: "Level 1" });
  await preview.eval((runtime) => runtime.layout.name);
  await preview.keyboard.press("Space");
  await preview.screenshot({ path: "shot.png" });
  await preview.close();
}
await project.close();
await editor.close();
```

See [docs/library.md](docs/library.md).

## Docs

- [docs/commands.md](docs/commands.md): every command and option
- [docs/report.md](docs/report.md): the `--report json` format
- [docs/library.md](docs/library.md): the Node API
- [docs/how-it-works.md](docs/how-it-works.md): how a project gets into the editor and how outcomes are read
- [DESIGN.md](DESIGN.md) for decisions, [NOTES.md](NOTES.md) for the backlog, [`tasks/`](tasks/) for the detailed notes

## Development

```sh
npm test                           # unit tests (pure logic, no browser)
npx tsx scripts/sweep.ts <label>   # open every fixture, write a table to reports/
```

`fixtures/` is gitignored. `scripts/unzip-fixtures.ts` makes the folder copies of the
`.c3p` fixtures. `scripts/check-*.ts` exercise the library, the daemon and previews against
the real editor, which needs a network connection.

Tested on macOS only so far.
