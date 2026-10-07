# c3cli — design

Status: pre-code, 2026-09-21.

## Shape
Node + TypeScript + Playwright (Chromium; C3 needs Chromium for the File System Access
API). One long-lived browser context with a persistent profile under
`~/.config/c3cli/profile` (keeps login, editor settings, "don't show again" dialogs).

```
c3cli open   <project> [--release ...] [--report json] [--timeout 60]
c3cli save   <project> [--to <folder|.c3p>]        # open + Ctrl+S (in place, or into a copy) + close
c3cli preview <project> [--layout X] [--seconds 10] # open + preview + collect console
c3cli export <project> --format html5 --to out.zip
c3cli daemon start|stop|status                       # keep an editor tab warm
c3cli eval   <js>                                    # page.evaluate in the editor
c3cli login                                          # headed, one-time
```
Every command exits 0/1 with a JSON report on `--report`.

## Two hosts, one driver interface
- **hosted** (`https://editor.construct.net/[r500/]`): follows releases, supports the
  release picker URL prefix. Opening a project has to go through the UI's own entry points
  (drop / pickers). Primary.
- **local dev** (`http://localhost:<port>/?mode=dev&project=<name>`): served from a
  `C3 Versions/<rel>` folder; `project=` fetches `exampleProjects/debug/<name>.capx` relative
  to the editor root → c3cli writes/symlinks the `.c3p` there. Simplest possible open, no UI
  automation, but locked to that release and dependent on the local copy being complete.
  Secondary / fallback / "pin a release" mode.

Both implement `openProject(path) → Report`.

## Observing outcomes
Never rely on timing alone. Layered signals, first one wins:
1. Editor's own log (`?log-pane` flag exposes a pane; also `console` messages prefixed
   `[Construct]`).
2. Dialog DOM: the error/notice dialog components have stable-ish CSS classes/ids in
   `components/`; text is in `lang` JSON, so match by lang key when possible, not English.
3. Project-open signal: project bar populated / window title changes / an internal
   "project opened" event.
4. Timeout → `crashed|hung`.

## Internals policy
Use internals only where the UI route is impossible or 10× slower, and always behind the
per-release name map with a self-test (`c3cli doctor --release`) that fails when a mapped
name no longer exists. The demangle tool already in `C3 Versions/C3-r500 copy/demangle`
gives scope-aware bindings; the map is `{ release: { openFromUrl: "Vz.Knr", ... } }`.

## Never downgrade

**(decided 2026-09-23)** c3cli never saves a project with an older release than it was
saved with, and never lowers `savedWithRelease` to get past the editor's "saved in a newer
version" refusal. Going back a release can silently lose data; it stays a manual decision.
`--use-project-release` opens with exactly the release the project was saved with (skymen,
2026-09-23): older or newer than the default, never older than the project.

## Open by drop, write through Node

**(decided 2026-09-26)** Projects get into the editor by a browser-level drop of their real
path (DevTools `Input.dispatchDragEvent`), not by copying them into the browser (OPFS). The
editor's writes go to disk through a Node bridge that patches the File System Access API
for dropped handles only; it refuses them outside c3cli's saves. `save` without `--to`
saves in place; with `--to`, into a copy (skymen, 2026-09-26).

## Any editor language

**(decided 2026-09-26)** Every text c3cli clicks or reads is looked up by lang key in the
release's lang file for the editor's current language, never hard-coded English. Fresh
profiles run with the browser in en-US. Checked in every language the release offers
(`scripts/check-languages.ts`) (skymen, 2026-09-26).

## Non-goals
- Reimplementing the editor's project loader. That's what running the real editor is for.
- Windows/Linux support first; macOS first, Linux (CI) second, Windows if the Action needs it.
