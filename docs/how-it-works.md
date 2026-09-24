# How c3cli works

For contributors, and for anyone wondering why it can be trusted. Decisions are in
[DESIGN.md](../DESIGN.md), and the findings behind each part are in [`tasks/`](../tasks/).

## The editor

c3cli loads the hosted editor, `https://editor.construct.net/<release>/`, in Playwright's
Chromium. C3 needs Chromium for the File System Access API.
- `--branch stable` loads the root URL and reads the release number from the page.
- `beta` and `lts` follow the site's redirect to their release.
- `--release` builds the URL directly.

Each run gets a fresh temporary browser profile unless `--profile` is given, so no addons,
settings or recovery prompts carry over.

## Getting a project in

The editor only opens projects through its own UI: drag and drop, or the file and folder
pickers. There is no open-from-URL on the hosted editor. c3cli uses the pickers:

1. It copies the project (a folder, or the `.c3p` file) into the page's origin-private file
   system (OPFS), under `c3cli/<run id>/`.
2. An init script replaces `window.showDirectoryPicker` and `showOpenFilePicker` with
   versions that return that copy's real, writable handle.
3. It clicks the editor's own open item, found under Menu → Project by its title ("Choose a
   folder-based project…" or "Choose a file…"). The editor then runs its normal open path.

The editor holds a writable handle to the copy, so Ctrl+S writes back into OPFS, and
`save` reads the result out from there. Playwright's own file chooser can't be used:
Chromium rejects File System Access pickers under Playwright's interception
([tasks/open-project.md](../tasks/open-project.md)).

## Reading the outcome

The outcome is never inferred from timing alone:
- **Opened**: the window title becomes `<project name> - Construct 3`. After that, c3cli
  waits 500 ms for dialogs that appear after opening, such as deprecated features.
- **Blocked**: a dialog that isn't a progress dialog stays open for 750 ms without the
  title changing.
- **Which dialog**: by element id (`missingAddonsDialog`, `okDialog`...) and by matching its
  text against the templates in the release's own language file
  (`<release>/loader/lang/precompiled-en-US.json`). That gives a lang key such as
  `ui.errors.project-saved-in-newer-release`, which doesn't depend on the English wording.
- **Missing addons** are parsed from the dialog lines into `{ type, name, id, author }`.
- The offer to install **bundled addons** is accepted by default, or declined with
  `--no-install-bundled-addons`.
- Errors thrown while the **editor itself** loads are reported separately. If the editor
  never becomes usable, the outcome is `editor-error`.
- Otherwise the timeout decides: `crashed` if there were page errors, `timeout` if not.

See [tasks/observe.md](../tasks/observe.md).

## Save and export

- **save**: Ctrl+S. c3cli waits until the staged files stop changing, copies them to
  `--to`, and diffs them with the input.
- **saveAs** (library): the editor's "Save as project folder", pointed at an empty OPFS
  folder. It writes every file.
- **export**: the editor's export wizard for Web (HTML5), with only the options that were
  passed changed. The zip is read from the export report's download link inside the
  page, 8 MB at a time. Playwright's download event isn't reliable over the daemon's
  connection.

## Previews

Menu → Project → Preview, or F5 on a layout made active in the Project bar, opens a popup
at `preview.construct.net`. To reach the runtime, c3cli wraps `C3.Runtime.prototype.Tick`
once, keeps `this.GetIRuntime()` (the public scripting API), and restores the method. It
looks in the preview page first and then in its workers, since many projects run the
runtime in a worker. `eval` runs code there. Worker errors surface on the popup page's
console, so they're collected with the rest. See [tasks/preview.md](../tasks/preview.md).

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
closing a project, which can prompt about unsaved changes. OPFS is shared by all tabs, so
each run only ever removes its own `c3cli/<run id>` folder. See
[tasks/cli-surface.md](../tasks/cli-surface.md#daemon).

## Accounts

`login` opens Menu → Account → Log in and fills the account site's form inside its iframe.
The password is only ever passed to that form field, and error text is scrubbed of it.
Playwright's call logs repeat `fill()` values, which is why the scrubbing is needed.
"Logged in" is read from the top bar's account name. The edition comes from whether the
"Free edition" label is visible. The label is always in the page, so its text says
nothing. See [tasks/auth.md](../tasks/auth.md).

## Rules

- Never modify the input project, and never overwrite a `--to` target.
- Never save a project with an older release than it was saved with, and never lower
  `savedWithRelease`. Going back a release can silently lose data. That stays a decision
  for people to make by hand.
- Use editor internals only where the UI route is impossible. So far none are needed
  besides the preview's `Tick` hook.
- Menu items are found by their English `title` attribute for now (NOTES.md has the
  follow-up).
