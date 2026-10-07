# How c3cli works

For contributors, and for anyone wondering why it can be trusted. Decisions are in
[DESIGN.md](../DESIGN.md).

## The editor

c3cli loads the hosted editor, `https://editor.construct.net/<release>/`, in Playwright's
Chromium. C3 needs Chromium for the File System Access API.
- `--branch stable` loads the root URL and reads the release number from the page.
- `beta` and `lts` follow the site's redirect to their release.
- `--release` builds the URL directly.

Each run gets a fresh temporary browser profile unless `--profile` is given, so no addons,
settings or recovery prompts carry over. The browser's language is en-US, which a fresh
profile's editor takes as its own. A profile where someone picked another language in C3's
settings keeps it: c3cli works in every language the editor has (see "Language" below).

## Getting a project in

The editor only opens projects through its own UI: drag and drop, or the file and folder
pickers. There is no open-from-URL on the hosted editor. c3cli drops the project on it:

1. A browser-level drag and drop of the project's real path (DevTools'
   `Input.dispatchDragEvent`), the same as dragging it from Finder. The editor gets a real
   handle to the folder or `.c3p` and runs its normal open path. Nothing is copied, and the
   editor only reads the files the project uses, so a project at the root of a big repo
   (`.git`, tools) opens as fast as any other.
2. c3cli checks that the editor took the drop; if not (a dialog in the way), it says so.

Playwright's own file chooser can't be used: Chromium rejects File System Access pickers
under Playwright's interception.

## Writing back

A dropped handle is read-only: writing needs the user to accept a browser prompt, which a
headless browser can't show. So an init script (`src/bridge.ts`) patches the File System
Access API, only for handles that came from c3cli's drops:
- permission checks answer "granted";
- writes, new files and folders, and deletions go to Node, which does them on disk. A file
  is written to `<name>.c3cli-tmp` and renamed over the old one, as Chrome does, so a crash
  never leaves half a file;
- reads stay native.

Node decides where each dropped path's writes go:
- **nowhere**, the default: the editor's own saves fail ("Unable to save project"), so
  opening, previewing or exporting never touches the project;
- **in place**, during `save` without `--to` (or with `--keep-open`, where whoever is at
  the window presses Ctrl+S);
- **into a copy**, during `save --to` on a folder: c3cli copies the project there first
  (without `.git`, cloning files where the disk can), and the editor's lookups and writes
  go to the copy.

"Save as" targets are dropped too, but caught before the editor sees the drop, and handed
to the editor's next file picker.

## Reading the outcome

The outcome is never inferred from timing alone:
- **Opened**: the window title becomes `<project name> - Construct 3`, with the branch
  around the name on beta and LTS in the editor's language (`Construct 3 beta`; in
  Italian `beta Construct 3`). After that, c3cli
  waits 500 ms for dialogs that appear after opening, such as deprecated features.
- **Blocked**: a dialog that isn't a progress dialog stays open for 750 ms without the
  title changing.
- **Which dialog**: by element id (`missingAddonsDialog`, `okDialog`...) and by matching its
  text against the templates in the release's own language files (see "Language"). That
  gives a lang key such as `ui.errors.project-saved-in-newer-release`, which doesn't depend
  on the wording or the language.
- **Missing addons** are parsed from the dialog lines into `{ type, name, id, author }`,
  with the lines' own templates. The type comes from the project file when it lists the
  addon (the Chinese translations use one word for plugin and effect).
- The offer to install **bundled addons** is accepted by default, or declined with
  `--no-install-bundled-addons`.
- Errors thrown while the **editor itself** loads are reported separately. If the editor
  never becomes usable, the outcome is `editor-error`.
- Otherwise the timeout decides: `crashed` if there were page errors, `timeout` if not.

## Save and export

- **save**: Ctrl+S, in place or into a copy (see "Writing back"). c3cli knows exactly
  which files the editor wrote, and waits until it has written nothing for 1.5 s. With
  `--to`, it diffs those files with the input.
- **saveAs** (library): the editor's "Save as project folder" or "Save as single file",
  answered with the target. It writes every file.
- **new**: Menu → Project → New, C3's defaults and the name, Create, then Save as.
- **export**: the editor's export wizard for Web (HTML5), with only the options that were
  passed changed. The zip is read from the export report's download link inside the
  page, 8 MB at a time. Playwright's download event isn't reliable over the daemon's
  connection.

## Addons

`--addons` and `addons install` drop the `.c3addon` files on the editor, like a user
would, and answer its dialogs in order: an install prompt per addon (accepted), an update
prompt if it's already installed (accepted), or a refusal (an SDK v1 addon after r449, one
that needs a newer release). Then the editor reloads, since new addons only load at
startup. They live in the browser profile: for good with `--profile`, until it stops with
the daemon, and for one run with a temporary profile.

## Language

The editor picks its language from the browser's languages (or its settings) and sets
`<html lang>`. Every text c3cli clicks or reads (menu item titles, the Account and Log in
items, the Web (HTML5) tile, "Guest", addon dialog labels, the beta/LTS window title) is
looked up by lang key in the
release's own `loader/lang/precompiled-<language>.json`, with en-US for keys a language
doesn't translate, as the editor does. `scripts/check-languages.ts` runs the commands in
every language the release offers.

## Previews

Menu → Project → Preview, or F5 on a layout made active in the Project bar, opens a popup
at `preview.construct.net`. To reach the runtime, c3cli wraps `C3.Runtime.prototype.Tick`
once, keeps `this.GetIRuntime()` (the public scripting API), and restores the method. It
looks in the preview page first and then in its workers, since many projects run the
runtime in a worker. `eval` runs code there. Worker errors surface on the popup page's
console, so they're collected with the rest.

## The daemon

`c3cli daemon run` launches one Chromium with a DevTools port and loads N editor tabs. It
listens on a Unix socket (`~/.config/c3cli/daemon.sock`, newline-delimited JSON). It only
hands out tabs:
- `lease` waits for a free tab and switches its release if needed;
- `done` gives it back;
- `status` and `stop`;
- `attachRuntime` and `evalRuntime`, for runtimes in preview workers, which a client
  connected over DevTools can't see.

A client connects to the same Chromium, finds its tab, and drives it with exactly the same
code as a one-shot run. A tab that is given back is **replaced**: its page and previews
are closed and a fresh editor loads in the background. That's simpler and safer than
closing a project, which can prompt about unsaved changes. A client adds the write bridge
to its tab over its own DevTools connection, so the files are written by the client. After
an addon install, idle tabs reload (`reloadTabs`).

## Accounts

`login` opens Menu → Account → Log in and fills the account site's form inside its iframe.
The password is only ever passed to that form field, and error text is scrubbed of it.
Playwright's call logs repeat `fill()` values, which is why the scrubbing is needed.
"Logged in" is read from the top bar's account name. The edition comes from whether the
"Free edition" label is visible. The label is always in the page, so its text says
nothing.

Construct keeps a login as `{userID, token}` in the account site's IndexedDB
(`login-data`; account.construct.net, or accountbeta.construct.net on beta releases), and
the editor's hidden login frame posts it to `token.json` at startup. `c3cli login` saves
that session, never the password, in the OS keychain. Every browser c3cli starts gets it
planted, and c3cli rewrites the frame's `token.json` post to carry the keychain's current
token and saves the one that comes back, under a lock, so parallel runs never spend the
same token twice. A profile with a login of its own (`login --profile`) is left alone.

## Rules

- Never write to a project unless asked to save it in place (`save` without `--to`), and
  never overwrite a `--to` target.
- Never save a project with an older release than it was saved with, and never lower
  `savedWithRelease`. Going back a release can silently lose data. That stays a decision
  for people to make by hand.
- Use editor internals only where the UI route is impossible. So far none are needed
  besides the preview's `Tick` hook.
- Find UI by id or class where the editor has one, and by the text it shows, looked up by
  lang key, where it doesn't. Never by English text.
