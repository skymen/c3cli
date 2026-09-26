# Installing unbundled addons

**Status:** implemented (2026-09-26), `src/addons.ts`: `c3cli addons install`, `--addons` on
every project command, `editor.installAddons()` and `open(path, { addons })`, and the
daemon (install into its profile, then its idle tabs reload: socket op `reloadTabs`).
Open gap: on r449 LTS, SDK v1 addons get no reaction at all (NOTES.md).

## How it works (2026-09-26, r495-2)
- The files (a `.c3addon`, folders searched recursively, zips extracted to a temp folder)
  are dropped on the editor in one browser-level drop, like the projects. Their
  `addon.json` gives id, name, version and type for the report.
- The editor handles them in drop order, one dialog each:
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
- r449-5 LTS: SDK v2 addons get the install prompt; SDK v1 ones (two tried) get nothing
  at all in headless, no dialog or console message within 60 s.

Install SDK v2 addons (`.c3addon` files) that a project uses but didn't bundle, by dropping
them onto the editor the way a user would, then reload the editor so they're active before
opening the project.

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
