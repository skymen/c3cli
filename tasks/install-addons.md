# Installing unbundled addons

**Status:** requested by skymen 2026-09-23, not started.

Install SDK v2 addons (`.c3addon` files) that a project uses but didn't bundle, by dropping
them onto the editor the way a user would, then reload the editor so they're active before
opening the project.

Wanted in every surface:
- an isolated command (e.g. `c3cli addons install <folder|zip|.c3addon…> [--profile]`);
- the daemon: install into its profile and reload its tabs;
- the library (`editor.installAddons(paths)`);
- an option on every command that opens a project (`--addons <folder|zip>`): install
  what's there, reload, then open.

Notes so far:
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
