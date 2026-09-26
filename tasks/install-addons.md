# Installing unbundled addons

**Status:** implemented (2026-09-26), `src/addons.ts`: `c3cli addons install`, `--addons` on
every project command, `editor.installAddons()` and `open(path, { addons })`, and the
daemon (install into its profile, then its idle tabs reload: socket op `reloadTabs`).
Installed through the Addon manager since 2026-09-27 (was a drop): the editor's drop
handler asks the installer to skip SDK v1 plugins and behaviors, so on r449 LTS a dropped SDK
v1 addon got no reaction at all. The Addon manager's "Install new addon…" doesn't: on r449-5
three unmodified SDK v1 addons (Under The Red Sky's `skymen_GlobalRuntime`,
`skymen_set_fov`, and `skymen_Shell`) install in 2.3 s, and a project using `skymen_Shell`
unbundled opens and previews with no errors. After r449 the editor refuses SDK v1 plugins and
behaviors whichever way they come (`install-sdkv1-error-message`, r495-2): outcome `refused`.
(A copy relabelled `"sdk-version": 2` installed by drop but broke preview: C3 packages an
addon's runtime code by its `sdk-version`. Dropped.)
Cost (r495-2, three SDK v2 addons, install step only, fresh profile, 3 runs each): drop
1.2 s, Addon manager 1.43 s, i.e. about 0.4 s per addon plus 0.25 s once per batch to open
the manager (r449-5: 1.36–1.59 s for three). Two fixes on 2026-09-27 got it there:
- the editor reuses `#addonConfirmInstallDialog` for the next addon, and c3cli waited for it
  to close: 5 s lost per addon. It now waits until it closes or shows something else;
- the editor loads with `?disable-ui-animations` (its own flag; the setting's default also
  follows `prefers-reduced-motion`, but a kept profile keeps its choice), and the menu
  helper waits for each entry instead of sleeping 300 + 500 ms: Menu → View → Addon manager
  → file chooser in 0.15 s instead of 1.2 s, 20/20 on r495-2 and r449-5. Always off, no
  option to turn them back on (skymen, 2026-09-27). With animations
  on, forcing the menu clicks fails every time (the menu drops clicks while it animates).
Open, preview, save (folder and `.c3p`), export and new all still work with the flag.

## How it works (2026-09-26, r495-2; Addon manager 2026-09-27)
- The files (a `.c3addon`, folders searched recursively, zips extracted to a temp folder)
  are picked all at once in Menu → View → Addon manager → "Install new addon…" (a hidden
  `<input type=file multiple>`, filled through Playwright's file chooser); menu items found
  by `main-menu.view-menu.menu-name` and `main-menu.view-menu.addon-manager`. Their
  `addon.json` gives id, name, version and type for the report. The dialogs below open over
  `#addonManagerDialog`, closed (Done) at the end.
- The editor handles them in the order given, one dialog each:
  - `#addonConfirmInstallDialog` (same as bundled addons) → `.okButton` (Install);
  - already installed, any version → `#confirmDialog` `ui.update-addon-prompt.message`
    → `.confirmButton` (Update): outcome `updated`;
  - refused → `#okDialog` with `ui.dialogs.addonManager.install-sdkv1-error-message`
    (SDK v1 after r449) or `install-min-version-error-message` (e.g. Mikal's 3D Object
    4.2.3.0 needs r496) or `install-error-message`: outcome `refused`, with the message;
  - last, `ui.dialogs.addonManager.install-confirmation.message` ("Addon install finished.
    Restart Construct…").
- Then the editor reloads (new addons only load at startup). Addons are in the profile's
  IndexedDB (`c3-addon-files`), shared by every tab and every release on the origin.
- `addons install` refuses without `--profile` or a running daemon: a temporary profile
  would lose them. With the daemon, `--addons` installs into the daemon's profile (skymen,
  2026-09-26).
- Checked: `barrel-zoom-test` + `barrel_zoom-1.0.1.0` opens; a folder with an SDK v1 addon
  reports it refused and the project still `missing-addons` for it; a zip of two; install
  into a `--profile` then `open --profile`; install into the daemon then open from other
  clients on both tabs; reinstall → `updated`.
- r449-5 LTS, by drop (before 2026-09-27): SDK v2 addons got the install prompt; SDK v1
  ones got nothing at all (the drop handler skips them). Through the Addon manager both
  install.
- Addon manager (2026-09-27): three SDK v2 addons on stable into a `--profile`, installed
  in 16.7 s, the same again → `updated` in 7.5 s; `preview --addons` of the `skymen_Shell`
  project on r449-5 (opens, previews, no errors) and on r495-2 (`skymen_Shell` refused,
  project `missing-addons`).

The request (2026-09-23): install addons (`.c3addon` files) that a project uses but didn't
bundle, the way a user would, then reload the editor so they're active before opening the
project.

Wanted in every surface:
- an isolated command (e.g. `c3cli addons install <folder|zip|.c3addon…> [--profile]`);
- the daemon: install into its profile and reload its tabs;
- the library (`editor.installAddons(paths)`);
- an option on every command that opens a project (`--addons <folder|zip>`): install
  what's there, reload, then open.

Notes from before (2026-09-23):
- Installed addons live in the browser profile, so this needs a persistent `--profile`
  (or the daemon's profile) to last beyond one run. With a temporary profile it's
  per-run, which is fine for "install, reload, open".
- The editor already has an install flow for bundled addons (`addonConfirmInstallDialog`,
  handled in observe.ts). A dropped `.c3addon` probably goes through the same dialog.
- Dropping files: a synthetic drop event with real `File` objects (route A in
  open-project.md, never needed for projects) is the likely way in; `.c3addon` is a
  single file, so the directory-entry limitation doesn't matter.
- The missing-addons dialog lists addon ids, so `open` can say which provided `.c3addon`
  covers which missing id.
