# Editor hosting: hosted vs local dev copy

**Status:** hosted is implemented (2026-09-23, `src/release.ts`). Local dev copy **deferred**:
skymen chose hosted only for now.

## URL forms (verified 2026-09-23)
- `/` serves stable directly (no redirect) and names its release in asset paths
  (`r495-2/…`). c3cli takes the most frequent `rNNN(-N)/` in the index HTML.
- `/beta/` → 307 to `/r502`; `/lts/` → 307 to `/r449-5`; `/stable/` → 301 to `/`.
- `/rNNN/` and `/rNNN-N/` work for exact releases; unknown releases 404.
- `savedWithRelease` in project.c3proj maps as `major*100 + patch`: 49502 = r495-2,
  49700 = r497.

## Hosted `editor.construct.net`
- URL prefix picks a release (`/r500/`), `stable`/`beta` are the default and the beta
  toggle in settings. Confirm the exact URL forms.
- Loaded through a service worker; first load is slow, later loads cached in the profile.
- Free edition works without login. Limits (event count, layers, effects…) may block
  opening larger projects → see auth.md.
- Only route into a project: UI entry points (open-project.md). Fine — once it works it
  works on every release.

## Local dev copy
- `~/Documents/C3 Versions/C3-r500/{index.html,kvStorage.js,localForageAdaptor.js,
  register-root-sw.js,r500/}` is a self-hosted mirror. Serving it needs the right origin/
  port (service worker scope + whatever `supportCheck.js` and the loader assert). skymen has
  done this before — ask for the exact command and record it here.
- `?mode=dev` turns off the `final` mode; then `?project=<name>` calls the internal
  fetch-and-open on `exampleProjects/debug/<name>.capx` (path relative to the editor root,
  `.capx` extension hard-coded but the loader almost certainly sniffs the zip — test with a
  `.c3p` renamed/symlinked). `?layout=`/`?eventsheet=` open a specific view after load.
- Locked to that release; useful for pinning and for CI determinism (no network).
- Also check: does dev mode change loading behaviour (extra asserts, repairs surfaced as
  dialogs)? If yes it's *better* for the lab matrix, not worse.

## Experiments
1. Serve r500 locally, open with `?mode=dev`, confirm dev flag active (any dev-only UI).
2. Symlink a `.c3p` into `r500/exampleProjects/debug/x.capx`, open `?mode=dev&project=x`.
3. Same on hosted editor: confirm `?project=` is ignored (expected, `zz.vD` false).
