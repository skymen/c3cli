# Commands

Every command that opens a project takes a project **folder** (the folder holding
`project.c3proj`) or a **`.c3p`** file. c3cli drops it on the editor where it is: nothing is
copied. The input is only ever written by `save` without `--to`.

## Options shared by open, save, preview and export

| Option | Default | |
|---|---|---|
| `--branch stable\|beta\|lts` | `stable` | Editor branch |
| `--release <rNNN>` | | An exact release, such as `r497` or `r495-2`. Overrides `--branch`. |
| `--use-project-release` | off | Open with exactly the release the project was saved with, older or newer. Needed for LTS-only projects, for example ones using SDK v1 addons. |
| `--report json` | | Print the [report](report.md) as JSON on stdout instead of the human summary |
| `--timeout <seconds>` | 60 | Give up after this long |
| `--headed` | off | Show the browser window |
| `--keep-open` | off | Leave the editor open until you close the window (implies `--headed`). Ctrl+S there saves the project in place. |
| `--profile <dir>` | temporary | Use and keep this browser profile. Without it, each run gets a fresh profile, deleted afterwards. |
| `--guest` | logged in | Stay logged out: don't use the session saved by [`c3cli login`](#login-logout-and-whoami). Runs in a private browser even if the daemon is running. |
| `--no-install-bundled-addons` | installs | Decline the editor's offer to install addons bundled in the project. The open then fails with `missing-addons`, naming them. |
| `--addons <path>` | | Install these addons first: a `.c3addon`, a folder of them, or a zip. Repeatable. For projects that use addons they don't bundle. They stay in the browser profile: the daemon's when it's used, yours with `--profile`. See [addons install](#addons-install). |
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
c3cli save <project> [--to <path>] [--allow-unbundle] [options]
```

Opens the project and saves it with the editor (Ctrl+S).
- **Without `--to`**, in place: the editor rewrites the project's own files, the ones it
  considers changed, and c3cli lists them. A project saved with an older release gets
  upgraded (`savedWithRelease` goes up, as it would in C3), never downgraded: the editor
  refuses projects from newer releases.
- **With `--to`**, the result goes to a new folder for a folder project (a copy of the
  project without `.git`, with the save on top) or a new `.c3p` for a `.c3p`, and c3cli
  lists which files differ from the input: changed, added and removed. The input isn't
  touched. Use it to see what C3 rewrites when a project passes through a given release.

A project that bundles its addons (`bundleAddons: true`) is only saved by a paid account.
The free edition, which includes being logged out, writes `bundleAddons: false` and no
`addons/` folder, so the project then needs those addons installed wherever it's opened.
c3cli refuses that save (`save.refused` in the report, exit 2) and writes nothing. Log in with a paid account,
or pass `--allow-unbundle` to save anyway, with a warning.

```
$ c3cli save untitled --to saved
opened  New project  (r495-2, 1.0s)
  saved → /Users/me/saved: 4 file(s) differ from input (2 changed, 2 added, 0 removed)
    ~ project.c3proj
    ~ project.uistate.json
    + .gitignore
    + llm-context.md
  savedWithRelease r432-2 → r495-2

$ c3cli save untitled
opened  New project  (r495-2, 1.1s)
  saved in place: the editor wrote 7 file(s)
    ~ .gitignore
    ~ llm-context.md
    …
  savedWithRelease r432-2 → r495-2
```

Ctrl+S on a folder project only rewrites the files C3 considers changed. To get every file
as C3 holds it in memory, use `saveAs` in the [library](library.md).

## new

```sh
c3cli new <new folder | new .c3p> [--name <name>] [--branch <b> | --release <r>] [--report json] [--timeout] [--headed] [--profile <dir>] [--no-daemon]
```

Creates a new project with the editor (Menu → Project → New, with the release's defaults)
and saves it: a folder, or a `.c3p`. The project is named `--name`, or after the target
(`games/pong` → "pong"). The result is exactly what that release writes for an empty
project: a clean starting point for tools, templates and test fixtures. The target is never
overwritten.

```
$ c3cli new pong --branch beta
created  pong → /Users/me/pong  (r503, 23 file(s))
```

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
c3cli export <project> --to <new .zip | new folder> [--platform <name>] [--set name=value]... [--accept-warnings]
             [--minify <mode>] [--lossless <fmt>] [--lossy <fmt>] [--[no-]offline] [options]
```

Exports through the editor's own export wizard, exactly as clicking through it would.
Options that aren't passed keep what the editor shows: its defaults, or with a kept
`--profile` on r488 and later, the last choices made for that project.

| `--platform` | Editor platform | Releases |
|---|---|---|
| `web` (default) | Web (HTML5) | all |
| `android`, `ios` | Android / iOS (Cordova): the **Cordova project**, a local zip (no builds on Scirra's build service) | all |
| `windows` | Windows (WebView2) | all |
| `macos` | macOS (WKWebView) | all |
| `linux` | Linux (CEF) | all |
| `nwjs` | NW.js | r449 LTS only |
| `playable-ad`, `playable-ad-zip` | Playable Ad (single file), Playable Ad (zip) | all |

| Option | Values |
|---|---|
| `--minify` | `none`, `bundle`, `simple`, `advanced`, `debug-advanced` |
| `--lossless` | `png`, `webp` |
| `--lossy` | `jpeg`, `webp`, `avif` |
| `--offline` / `--no-offline` | offline support on or off (web only) |
| `--set deduplicate-images=on`, `--set optimize-images=on` | the two image switches, every platform |

Each platform's own options go through `--set name=value` (repeatable). Switches take
`on`/`off`. Lists are comma-separated, and name exactly what's wanted: `arch=x64` unticks
ARM64. An option a release doesn't have, or a value it doesn't take, stops the command
before anything opens (exit 4). `c3cli export --help` lists them all.

| Platform | `--set` options |
|---|---|
| `android` | `min-version` (7.0 to 15.0), `url-whitelist`, `version-code`, `hide-status-bar`, `vibrate-permission`, `camera-permission`, `microphone-permission` |
| `ios` | `min-version` (16.0 to 18.0), `url-whitelist`, `hide-status-bar`, `vibrate-permission`, `camera-permission`, `microphone-permission` |
| `windows` | `arch` (`x64`, `arm64`; `x86` on r449), `bundle` (`none`, `assets`, `single-file` from r479), `steam` (`none`, `overlay`, `capture` from r503; `none` or `overlay` on r473 to r502), `devtools`, `window-caption` (r451+), `resizable`, `ignore-gpu-blacklist`, `remote-preview`, `command-line` |
| `macos` | `app-sandbox`, `bundle-assets`, `devtools`, `window-caption`, `resizable` (both r451+), `signing-identity`, and the Permissions dialog: `camera` and `microphone` (the usage text, or `off`), `internet-server`, `pictures-folder` / `movies-folder` / `downloads-folder` (`none`, `read`, `read-write`) |
| `linux` | `version` (`latest`, `v147`…), `arch` (`x64`, `arm64`; `arm32` on r449), `fullscreen`, `compress`, `bundle-assets`, `devtools`, `window-caption`, `resizable` (both r452+) |
| `nwjs` | `version` (`latest`, `v0.100.1`…), `arch` (`linux32`, `linux64`, `mac64`, `mac-arm64`, `win32`, `win64`), `package-assets`, `compress`, `window-frame`, `resizable`, `kiosk`, `ignore-gpu-blacklist`, `devtools`, `steam`, `command-line` |

```
$ c3cli export game --platform windows --set arch=x64 --set bundle=single-file --to game-win.zip
opened  Game  (r495-2, 1.2s)
  exported for windows → /Users/me/game-win.zip
```

- **Output.** Every platform gives one zip. `--to x.zip` keeps it; `--to folder` unzips it,
  keeping file modes, so the Linux binary and the macOS app stay executable. Linux, Windows
  and NW.js for several platforms put a folder per platform in it (`x64/`, `arm64/`,
  `win64/`…). Should an export ever offer several zips, `--to` must be a folder, and each is
  unzipped into a subfolder named after it.
- **Downloads.** Linux and NW.js download their runtime from downloads.scirra.com at every
  export (about 126 MB per Linux architecture, about 150 MB per NW.js platform); a fresh
  profile can't reuse the editor's cache. Give them a longer `--timeout`. Twice in about a
  dozen runs, the editor sat at "Adding files..." until the timeout (a download that
  never finished, it seems); running it again worked.
- **Project checks.** Before exporting, the editor checks the project: macOS, Linux, NW.js
  and Cordova need an app ID, Cordova a valid version and a description. A project that
  fails gets `refused` (exit 2) with the editor's message. The editor's warnings also stop
  the export as `refused`, unless `--accept-warnings` (then they're in `warnings`, exit 1):
  - any platform: an image larger than 4096 px (too big for some devices), or a framerate
    mode other than V-synced (meant for testing);
  - Android and iOS: upper-case letters in the app ID, a version that makes a poor Android
    version code (1 or 2 numbers, a number over 99, or a code over 2147483647), a Mobile
    Advert object with missing details.
- **Paid.** Logged out, or with a free account, only `web` exports; everything else is
  `refused-by-edition` (exit 2), and so is web when the project is over the event limit or
  with any minify mode but `none`. Log in once with
  [`c3cli login`](#login-logout-and-whoami): every run uses that session.

## addons install

```sh
c3cli addons install <paths...> [--profile <dir>] [--branch <b> | --release <r>] [--report json] [--timeout] [--headed] [--no-daemon]
```

Installs addons (`.c3addon` files, folders of them, zips) the way a user does: drops them on
the editor, accepts each install prompt (and the update prompt for one already installed),
then reloads. Addons live in the browser profile, so this installs into `--profile`, or into
the running daemon's profile (its idle tabs reload). Without either it refuses: a temporary
profile would lose them.

```
$ c3cli addons install ~/addons --profile ~/.config/c3cli/me
installed skymen_barrelzoom 1.0.1.0  (barrel_zoom-1.0.1.0.c3addon)
refused   skymen_parent_anchor 1.0.0.3  (better-anchor-1.0.0.3-stable.c3addon): The addon skymen_parent_anchor by skymen is a legacy (SDK v1) addon …
```

Each addon is `installed`, `updated`, `refused` (exit 2) or `unknown`, when the editor
never answered about it (exit 3). On r449 LTS, SDK v1 addons get no answer in headless
mode at all (NOTES.md).

## Daemon

```sh
c3cli daemon start [--tabs 3] [--profile <dir>] [--branch <b> | --release <r>] [--guest] [--headed]
c3cli daemon status [--report json]
c3cli daemon stop
c3cli daemon run ...        # the same, in the foreground (what `start` launches)
```

The daemon keeps one Chromium with `--tabs` editor tabs loaded and ready. Project commands
use it automatically when it's running, unless they pass `--no-daemon`, `--profile`,
`--guest`, `--headed` or `--keep-open`, which need a private browser. Its tabs use the
shared login unless it was started with `--guest`; `daemon status` names the account. Each command borrows a tab and
gives it back. The daemon then replaces that tab with a fresh editor in the background,
so nothing carries over from one project to the next. Tabs switch release when a command
asks for another one.

- Socket: `~/.config/c3cli/daemon.sock`. Log: `~/.config/c3cli/daemon.log`.
- An open takes about 2.5 s through the daemon, against 5.5 s on its own. Six projects on
  three tabs take 5–6 s.

## login, logout and whoami

```sh
c3cli login  [--profile <dir>] [--branch|--release] [--timeout] [--headed] [--report json]
c3cli logout [--profile <dir>] [--report json]
c3cli whoami [--profile <dir>] [--report json]
```

`login` logs in with a Construct account's username or email and password. It reads
`C3CLI_USERNAME` and `C3CLI_PASSWORD` from the environment, or asks at the terminal with
the password hidden. There's no `--password` flag, so it doesn't end up in shell history or
process lists. Google and other sign-in providers aren't supported. If the editor is
already logged in as someone else, it logs out first. A login by email can't be compared
with the username the editor shows, so it always logs out and back in.

**Log in once, for every run.** Without `--profile`, `login` keeps the session (a token,
never the password) in the OS credential store: the macOS keychain, the Windows Credential
Manager, or on Linux the Secret Service (GNOME Keyring, KWallet…). A Linux machine without
one (a server, CI) gets `~/.config/c3cli/session.json`, readable by you only. Every later
run, the daemon included, starts logged in with it unless it passes `--guest`. Construct
can give a new token each time the editor logs in with one, so c3cli hands the current
token to each editor as it starts and keeps what comes back, one run at a time. Runs in
parallel are fine.

**A profile's own login wins.** `login --profile <dir>` logs that profile in and keeps the
session there only. A profile logged in that way keeps its own account. Any other profile
gets the shared login.

`logout` ends the shared session, on Construct's server too, and removes it from the
keychain. With `--profile`, it logs out that profile's own login. `whoami` shows the account
and edition a run would use (`shared session` or `this profile's own login`). It exits 0
when logged in, and 2 when not.

If the shared session expires, or Construct refuses it, runs go on logged out and say so
in their report notes. Log in again.

With the credentials in a `.env` file that isn't committed:

```sh
node --env-file=.env "$(which c3cli)" login
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Clean |
| 1 | Opened with warnings: dialogs after opening (such as deprecated features), page errors, runtime errors during preview |
| 2 | Refused: invalid project, newer release, missing addons, expression name collision, free-edition limit, a save that would unbundle addons, login or logout failed |
| 3 | Crashed, timed out, editor error, or the requested preview, save, export or addon install didn't happen |
| 4 | Tool error (bad arguments, `--to` already exists…) |

Console noise the editor always prints doesn't affect the exit code. Examples are failed
resource loads and the missing WebGPU adapter in headless mode. It's still in the report.
