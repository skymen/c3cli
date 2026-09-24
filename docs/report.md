# The JSON report

`--report json` prints one JSON object on stdout and nothing else there. The release
prompt, if any, goes to stderr. The library returns the same object as `project.report`.
The format carries a `version` (currently 1).

A real one, trimmed:

```json
{
  "version": 1,
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
  "filesStaged": 1,
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
| `notes` | What c3cli decided along the way, such as switching to the project's release |
| `tab` | The editor tab used (`tab-1`, or a daemon tab) |
| `via` | `local` (a private browser) or `daemon` (CLI only) |
| `outcome` | See below |
| `error` | The reason, when the outcome is `editor-error` |
| `durationMs` | From clicking Open to the outcome |
| `totalMs` | The whole command, including browser startup (CLI only) |
| `filesStaged` | Files copied into the browser |
| `startupDialogs`, `startupPageErrors`, `startupConsoleErrors` | What happened while the editor itself loaded, before the project. Not counted against the project. |
| `dialogs` | Every dialog shown during and right after the open: `id`, `title`, `body`, `buttons`, and the `langKey` its text matches in the release's language file |
| `missingAddons` | `{ type, name, id, author }` for each addon the editor says is missing; `declined: true` when it was bundled and `--no-install-bundled-addons` declined it |
| `bundledAddons` | Addons the project bundles and the editor offered to install: `{ name, version, type, author, installed }` |
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
timing alone. Dialogs are identified by element id and lang key, not by English text.

## Added by save, preview and export

**`save`**: `{ to, ok, written, diff: { filesChanged, changed[], added[], removed[] }, error? }`.
`written` lists the files the editor wrote during the save. `diff` compares the result with
the input, file by file. `.c3p` files are unzipped for the comparison.

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
- `outcome`: `exported`, `refused-by-edition` or `export-failed`;
- `to`, `files`: where it went, and the file count for folder output;
- `suggestedName`: the zip name the editor proposed;
- `reportText`: the export report dialog's text;
- `dialogs`, `error`.
