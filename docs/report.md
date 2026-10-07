# The JSON report

`--report json` prints one JSON object on stdout and nothing else there. The release
prompt, if any, goes to stderr. The library returns the same object as `project.report`.
The format carries a `version` (currently 2: version 1 had `filesStaged`, from when
projects were copied into the browser, and `save` had no `inPlace` or `savedWithRelease`).

A real one, trimmed:

```json
{
  "version": 2,
  "project": {
    "path": "/Users/me/fixtures/better-shine-addon-bug.c3p",
    "kind": "file",
    "name": "New project",
    "savedWithRelease": "r438"
  },
  "release": "r495-2",
  "host": "hosted",
  "notes": [],
  "tab": "tab-1",
  "outcome": "missing-addons",
  "durationMs": 1518,
  "startupDialogs": ["welcomeTourDialog"],
  "startupPageErrors": [],
  "startupConsoleErrors": ["Failed to load resource: the server responded with a status of 400 ()"],
  "dialogs": [
    {
      "id": "missingAddonsDialog",
      "title": "Missing addons",
      "body": "The project you are opening uses the following addons that are not installed. …",
      "buttons": ["Close"],
      "langKey": "ui.dialogs.missingAddons.header-text"
    }
  ],
  "missingAddons": [{ "type": "Effect", "name": "Better Shine", "id": "better_shine", "author": "skymen" }],
  "bundledAddons": [],
  "log": [],
  "consoleErrors": [],
  "pageErrors": [],
  "via": "local",
  "totalMs": 4022
}
```

## Fields

| Field | |
|---|---|
| `version` | Report format version |
| `project` | `path`, `kind` (`folder` or `file`), `name` from `project.c3proj`, and the release it was `savedWithRelease` |
| `release` | The editor release that was used |
| `notes` | What c3cli decided along the way, such as switching to the project's release, and what happened to the shared login (expired, server unreachable) |
| `tab` | The editor tab used (`tab-1`, or a daemon tab) |
| `via` | `local` (a private browser) or `daemon` (CLI only) |
| `outcome` | See below |
| `error` | The reason, when the outcome is `editor-error` |
| `durationMs` | From dropping the project on the editor to the outcome |
| `totalMs` | The whole command, including browser startup (CLI only) |
| `startupDialogs`, `startupPageErrors`, `startupConsoleErrors` | What happened while the editor itself loaded, before the project. Not counted against the project. |
| `dialogs` | Every dialog shown during and right after the open: `id`, `title`, `body`, `buttons` (in the editor's language), and the `langKey` its text matches in the release's language files |
| `missingAddons` | `{ type, name, id, author }` for each addon the editor says is missing; `declined: true` when it was bundled and `--no-install-bundled-addons` declined it |
| `bundledAddons` | Addons the project bundles and the editor offered to install: `{ name, version, type, author, installed }` |
| `addons` | With `--addons` only: each file given, `{ file, id, name, version, type, outcome, message?, langKey? }`, `outcome` being `installed`, `updated`, `refused` or `unknown` |
| `log` | Console messages, as `[type] text` |
| `consoleErrors`, `pageErrors` | Console errors and uncaught exceptions after the open started |

### Outcomes

| Outcome | Exit | When |
|---|---|---|
| `opened` | 0, or 1 with dialogs or page errors | The window title became the project's name |
| `missing-addons` | 2 | The missing addons dialog, or a bundled addon declined |
| `refused-newer-release` | 2 | The project was saved with a newer release |
| `refused-by-edition` | 2 | The free edition's limits |
| `refused` | 2 | Any other blocking dialog: invalid project, expression name collision… |
| `crashed` | 3 | Page errors and no outcome before the timeout |
| `timeout` | 3 | Nothing happened before `--timeout` |
| `editor-error` | 3 | The editor itself never became usable, so nothing can be said about the project |
| `tool-error` | 4 | c3cli failed. Only `version`, `outcome` and `error` are set. |

The outcome comes from what the editor shows (dialogs and the window title), never from
timing alone. Dialogs are identified by element id and lang key, not by their text, which
is in the editor's language.

## `new`

`c3cli new --report json` prints its own, smaller object: `{ version, outcome: "created",
to, kind, name, release, savedWithRelease, files, via, totalMs }`, `files` being what the
editor wrote. Failures are a `tool-error`.

## Added by save, preview and export

**`save`**: `{ to, inPlace, ok, written, savedWithRelease: { before, after }, diff: { filesChanged, changed[], added[], removed[] }, error?, refused?, warnings? }`.
`written` lists the files the editor wrote (or created or deleted) during the save.
`refused` is `"free-edition-unbundles-addons"` when c3cli didn't save a project that bundles
its addons because the editor runs the free edition (exit 2); `warnings` says it saved one
anyway (`--allow-unbundle`).
`inPlace` is true without `--to`; `diff` is then null. With `--to`, `diff` compares the
result with the input, file by file. `.c3p` files are unzipped for the comparison.

**`preview`**:
- `started`: whether the runtime started;
- `url`: the preview's address;
- `seconds`: how long it ran;
- `requestedLayout`, `startLayout`: the layout asked for, and the one the runtime was on at
  its first tick;
- `runtimeIn`: `page` or `worker`;
- `log`, `consoleErrors`, `pageErrors`: from the preview window and its workers;
- `error`: why it didn't start or stopped.

**`export`**:
- `outcome`: `exported`, `refused-by-edition`, `refused` (the project failed the editor's
  checks, or a warning without `--accept-warnings`) or `export-failed`;
- `platform`: `web`, `android`, `windows`…;
- `to`, `files`: where it went, and the file count for folder output;
- `outputs`: each zip the export made, `{ name, to }` (with several, `to` is a subfolder);
- `suggestedName`: the (first) zip name the editor proposed;
- `reportText`: the export report dialog's text;
- `warnings`: the warnings gone past with `--accept-warnings`;
- `dialogs`, `error`.
