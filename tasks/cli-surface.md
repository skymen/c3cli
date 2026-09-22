# CLI surface

**Status:** not started (2026-09-21)

Commands and flags as in DESIGN.md. Decisions:
- `--report json` writes the observe.md report to stdout; human output otherwise.
- `--release <rX|stable|beta>`; `--host hosted|local`; `--profile anon|logged-in`.
- `--headed` for debugging; default headless. `--keep-open` leaves the tab alive.
- Exit codes: 0 opened clean, 1 opened with warnings/repairs, 2 refused, 3 crashed/timeout,
  4 tool error.

## Daemon
`c3cli daemon start` launches the persistent context and a tiny local socket
(`~/.config/c3cli/daemon.sock`). Commands connect if the daemon is up, else run one-shot.
Opening the editor cold costs ~10 s; the lab matrix is 30+ opens × 2 releases.
Between projects: close project (menu) rather than reload the tab, unless a crash was
detected — then reload.
