# Auth and edition limits

**Status:** done (2026-09-23). Failure path tested with two fake logins; success path tested
from a fresh profile with the skymen_auto test account via `.env` (gitignored). Password
found 0 times in the output and 0 times anywhere in the profile, and Chromium created no
saved-password database. skymen rotates the password after testing.

## Login flow (r495-2)
- Menu → Account → "Log in" → `#loginDialog`, which holds an iframe
  `https://account.construct.net/login?...` with `#loginForm`, `#username`, `#password`,
  `#remember`, `#login`. The OAuth buttons in the same frame are ignored on purpose.
- Logged in = top bar `#userAccountName` is neither "Guest" nor the placeholder "..."
  (shown until the editor has checked the account).
- Edition: `#userLicenseType` always *contains* "Free edition" but is hidden
  (`display: none`) for licensed accounts (`components/misc/userAccount/userAccount.js`).
  Read its visibility, never its text. (The first version read the text and called
  skymen_auto's paid account "Free edition", 2026-09-23.) The plan name ("Startup Business")
  is only in Account → View details (`#accountInfoDialog`).
- Verified with the paid test account skymen_auto (session from skymen's own login, no
  credentials handled by Claude): sokoban-gen (~98 events) exports with `--minify simple`,
  which both fail on the free edition.
- Wrong credentials → `#confirmDialog` "Login failed … Check the username and password are
  correct." (Try again / Cancel).

## Handling credentials
- Read from `C3CLI_USERNAME` / `C3CLI_PASSWORD`, or asked at a terminal (password read in
  raw mode with no echo). There is no `--password` flag (shell history, `ps`).
- The password is only passed to `frame.fill()`. Error text is scrubbed of it, because
  Playwright call logs echo `fill()` values. Tested: 0 occurrences of a fake password in
  the output of a failed login, and none echoed at the prompt.
- `--profile` is required: the session lives in that profile and is used by other commands
  through their own `--profile`.
- Limits: anything that can run c3cli can read the password while it runs. These rules
  keep it out of logs and transcripts; they don't make it unreadable. A dedicated
  test account is the real safety net.

## Original notes

**Status:** not started (2026-09-21). Guests are limited to **25 events**, free accounts to 50
(seen on the start page, 2026-09-23). skymen: the cap only bites on **export**.

Login: **credentials only** (email + password form), no OAuth providers (skymen, 2026-09-23).
Profiles: default to a fresh temporary profile per run; `--profile <dir>` uses a specific
persistent one (skymen: "whatever works").

- Free edition first. Record which fixture projects it refuses (limits dialog) — the lab's
  tiny projects should all fit.
- Persistent context (`launchPersistentContext`) under `~/.config/c3cli/profile`;
  `c3cli login` opens headed, skymen logs in once, cookies persist. Never store
  credentials in the tool.
- Two profile templates: `anon` and `logged-in`; lab runs copy a template per run for
  isolation.
- Hosted editor may show "signed in elsewhere" / subscription checks; observe and handle.
