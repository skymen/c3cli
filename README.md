# c3cli

Drive the Construct 3 editor from the command line and from Node, and get a verdict back.
It uses the real hosted editor (editor.construct.net) in a headless Chromium.

- **open**: does this project open in C3, on this release? If not, why: missing addons, a
  newer release, invalid files, the free edition's limits.
- **save**: open and save with the editor, in place or into a copy, and see which files C3
  rewrote.
- **new**: create a new project with the editor, as a scaffold.
- **preview**: run the project (or one layout) and collect runtime errors.
- **export**: export to a zip or a folder, for the web, Android and iOS (Cordova project),
  Windows, macOS, Linux, NW.js (LTS) or Playable Ads, with each platform's options.
- **addons install** / `--addons`: install addons a project uses but doesn't bundle.
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

You need Node 22+.

```sh
npm install -g @skymen75/c3cli
npx playwright install chromium   # the browser c3cli drives, once
```

Or without a global install: `npx @skymen75/c3cli open game.c3p` (Chromium is still needed). For the
Node library, run `npm install @skymen75/c3cli` in your project.

## Use

```sh
c3cli open    <folder|.c3p> [--report json]
c3cli save    <folder|.c3p>                                # open, save with the editor, in place
c3cli save    <folder|.c3p> --to <new folder|new .c3p>   # open, save into a copy, diff with the input
c3cli preview <folder|.c3p> [--seconds 10] [--layout "Level 1"]
c3cli export  <folder|.c3p> --to <new .zip|new folder> [--platform windows|macos|linux|android|…] [--set arch=x64]…
c3cli new     <new folder|new .c3p> [--name "Pong"]
c3cli addons install <.c3addon|folder|zip>... --profile <dir>   # or into the running daemon
```

c3cli drops the project on the editor where it is, as you would from Finder: nothing is
copied, so a project at the root of a big repo opens as fast as any other. Only `save`
without `--to` writes to the project; `--to` never overwrites anything.

The editor always runs with its UI animations off (its `disable-ui-animations` flag), in
`--headed` and `--keep-open` too: menus and dialogs open at once, so c3cli doesn't wait for
them.

Common options:

| Option | |
|---|---|
| `--branch stable\|beta\|lts` | Which editor release (default: stable) |
| `--release r495-2` | An exact release |
| `--use-project-release` | Exactly the release the project was saved with |
| `--report json` | A machine-readable report on stdout |
| `--timeout <s>` | Give up after this long (default 60) |
| `--headed` | Show the browser window; `--keep-open` leaves it open |
| `--profile <dir>` | Use and keep this browser profile; default: a fresh one per run |
| `--guest` | Stay logged out (by default runs use the login saved by `c3cli login`) |
| `--no-install-bundled-addons` | Don't install the addons bundled in the project. By default c3cli trusts them before opening, so the editor installs them without asking |
| `--addons <path>` | Install these addons first (`.c3addon`, a folder of them, a zip) |

A project saved with a newer release than the one chosen is refused by the editor. At a
terminal, c3cli asks whether to switch to the project's release. c3cli never saves a
project with an older release than it was saved with.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Clean |
| 1 | Opened, with warnings (dialogs after opening, page errors, runtime errors in preview) |
| 2 | Refused (invalid project, newer release, missing addons, name collision, free-edition limit, a save that would unbundle addons, login failed) |
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

Guests and free accounts are limited (25 and 50 events), which mostly matters for export,
and saving a project that bundles its addons needs a paid account. Log in once; every run
after that is logged in, the daemon included:

```sh
c3cli login                       # reads C3CLI_USERNAME / C3CLI_PASSWORD, or asks (hidden)
c3cli whoami
c3cli export game.c3p --to out.zip
c3cli logout                      # ends the session, on Construct's server too
```

c3cli keeps the session, never the password, in the OS credential store: the macOS
keychain, the Windows Credential Manager, or the Linux Secret Service (without one, as on a
server, `~/.config/c3cli/session.json`, readable by you only). That keeps it off disk in plain text
and out of backups, but any program running as you can still read it. `--guest` runs one
command logged out. `login --profile <dir>` logs one profile in on its own instead, and
that profile keeps its own account.

Only email or username with a password is supported, no Google or other sign-ins. There is
no `--password` flag, so the password never ends up in shell history. Use a dedicated
account for automation: anything that runs c3cli can read the password while it runs.

## Library

```ts
import { C3Editor } from "@skymen75/c3cli";

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
- [DESIGN.md](DESIGN.md) for decisions, [NOTES.md](NOTES.md) for the backlog, [`tasks/`](tasks/) for the notes behind open backlog items

## Development

```sh
git clone <this repository> && cd c3cli
npm install
npx playwright install chromium
npm test                           # unit tests (pure logic, no browser)
npm run build
npx tsx src/cli.ts open game.c3p   # run from source without building
npx tsx scripts/sweep.ts <label>   # open every fixture, write a table to reports/
```

`fixtures/` is gitignored. `scripts/unzip-fixtures.ts` makes the folder copies of the
`.c3p` fixtures. `scripts/check-*.ts` exercise the library, the daemon and previews against
the real editor, which needs a network connection: `check-open-save.ts` (every way of
saving, on stable, beta and LTS), `check-languages.ts` (every language the editor has),
`check-saveas.ts` (many saves on several tabs), `check-parallel.ts` (the daemon).

Tested on macOS only so far.
