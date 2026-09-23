# CLI surface

**Status:** `open` implemented (2026-09-23, `src/cli.ts`). Daemon not started.

Release selection (skymen, 2026-09-23): stable by default; `--branch stable|beta|lts`;
`--release rNNN` exact. If the project was saved with a newer release, ask at a TTY
("Open with rX instead? [Y/n]"). `--use-project-release` always uses the project's exact
release, older or newer (an LTS-only project needs its own release). When not
interactive, keep the release and let the editor refuse (`refused-newer-release`).

Commands and flags as in DESIGN.md. Decisions:
- `--report json` writes the observe.md report to stdout; human output otherwise.
- `--release <rX|stable|beta>`; `--host hosted|local`; `--profile anon|logged-in`.
- `--headed` for debugging; default headless. `--keep-open` leaves the tab alive.
- Exit codes: 0 opened clean, 1 opened with warnings/repairs, 2 refused, 3 crashed/timeout,
  4 tool error.

## Daemon

**Status:** implemented (2026-09-23), in `src/daemon.ts` and `src/pool.ts`.

How it works:
- `c3cli daemon start [--tabs 3] [--profile dir] [--branch|--release] [--headed]` spawns
  `c3cli daemon run` in the background (log: `~/.config/c3cli/daemon.log`). It launches
  one Chromium with a DevTools port and loads N editor tabs (the pool), warmed with the
  release.
- It listens on `~/.config/c3cli/daemon.sock` (newline-delimited JSON) and only hands out
  tabs: `lease` (waits for a free tab, switching its release if needed), `done`, `status`,
  `stop`, plus `attachRuntime` / `evalRuntime` (see below).
- A client (any project command, or `C3Editor.connect()`) leases a tab, connects to the
  same Chromium with `connectOverCDP`, finds its tab by `window.__c3cliTabId`, and drives
  it with exactly the same code as one-shot. `done` gives it back. A client that
  disconnects gives back all its tabs.
- A returned tab is **replaced**: close the page and its preview windows, open a new page,
  reload the editor (in the background). This is simpler and more robust than closing
  the project, which can prompt about unsaved changes. The next lease prefers a tab that
  is already warm.
- Commands use the daemon when it's running unless `--no-daemon`, `--profile`, `--headed`
  or `--keep-open` asks for a private browser. Output shows `daemon tab-N`.

Pitfalls found while building it:
- OPFS is per origin, i.e. shared by all tabs: staging now uses `c3cli/<runId>` and only
  ever removes its own run. It used to wipe the whole `c3cli` folder before staging, which
  would delete other tabs' projects. The pool clears leftovers once, at startup.
- A CDP-connected client doesn't see a preview window's **workers**, so worker-mode
  runtimes are unreachable from the client. The daemon's own connection sees them:
  `attachRuntime` / `evalRuntime` run the capture and evaluations there. Input,
  screenshots and DOM evaluation stay client-side.
- Playwright downloads aren't reliable over CDP, so export now reads the report's `blob:`
  link in the page, in 8 MB chunks, and never uses the download event.
- Preview popups are caught with `page.waitForEvent("popup")` (per tab), not the context's
  `page` event, which would catch other tabs' previews.

Timings (2026-09-23, untitled.c3p, wall clock for the whole `c3cli open` command):
one-shot 5.5–5.8 s; with the daemon 2.5–2.6 s. Also measured: the post-open settle
dropped from 2 s to 500 ms (post-open dialogs appear 25–45 ms after the title changes).
6 projects in parallel on 3 tabs: 10–11 s; 3 parallel previews: 6.4 s.
