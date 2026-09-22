# Auth and edition limits

**Status:** not started (2026-09-21)

- Free edition first. Record which fixture projects it refuses (limits dialog) — the lab's
  tiny projects should all fit.
- Persistent context (`launchPersistentContext`) under `~/.config/c3cli/profile`;
  `c3cli login` opens headed, skymen logs in once, cookies persist. Never store
  credentials in the tool.
- Two profile templates: `anon` and `logged-in`; lab runs copy a template per run for
  isolation.
- Hosted editor may show "signed in elsewhere" / subscription checks; observe and handle.
