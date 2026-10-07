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

## Switching accounts, logging out

**Status:** implemented (2026-10-06), `logIn()` / `logOut()` in `src/login.ts`, `c3cli logout`.
Tested logged out only (logout with nothing to end); the switch and a real logout need the
real account.

- `logIn()` returns `already-logged-in` as soon as the profile is logged in, whatever the
  account, so logging a profile into another account silently keeps the old one (exit 0).
- Wanted: when the profile is logged in as someone else, log out, then log in. The top bar
  shows the username, so a login by email can't be compared to it: log out and in again
  then (one session swapped for another, no quota left behind).
- `c3cli logout [--profile]`: Menu → Account → Log out (text key probably
  `user-account.menu.log-out`, not checked). The login frame's `LogOut()` tells the server
  to drop the token (`logout.json`) and deletes `login-data`.

## Shared session (log in once for every run)

**Status:** implemented (2026-10-06), `src/session.ts`; wired into the tab pool (so the daemon
too), `login` / `logout` / `whoami` without `--profile`, and `--guest`. Checked offline, with
the server's answer given locally (scratch script, not in the repo): the post carries the
store's current token even after another run changed it; a refusal removes it and the open
report says so; a network error keeps it; `--guest` posts nothing; a profile's own login
is never touched, a profile with only a copy gets a marker and a fresh copy each run. Unit
tests: form fields, the file store (0600), the lock. **Not tested with a real login yet:**
the success path (new token saved), parallel tabs, the daemon, logout, switching.

Real account, 2026-10-06 (skymen ran `c3cli login`; skymen_auto, paid): `whoami` twice →
logged in both times, the keychain entry re-saved each time; 6 opens on a 3-tab daemon, all
logged in, no notes; export with `--minify simple` (paid only) through the daemon; saving
`3d-lighting` keeps `bundleAddons: true`; two logged-in editors at once (the free-vs-paid
comparison) were fine. **Construct sent back the same token every time**: `newToken` equals
the token posted, so it doesn't rotate today, and the handover only re-saves it. Still to
test (skymen): switching accounts, login by email, `logout`.

Beta releases (2026-10-06): their login frame is **accountbeta.construct.net**, so the shared
session wasn't seen there (r505 ran logged out). accountbeta accepts the same token (checked
with a direct token.json post: same user, same token back), so c3cli now plants it and
routes token.json on both sites, and `login`/`logout` find the frame on either. Checked:
r505 and r495-2 both open logged in as skymen_auto. Also: a dialog that comes up after the
editor loaded (e.g. "Account logged out" when the session is refused) is now dismissed
before the drop, which it used to swallow.

Windows and Linux (2026-10-06, skymen): `@napi-rs/keyring`, Credential Manager and the
Secret Service. On Linux the Secret Service is required (`linux: { store: "secret-service" }`):
the package's own fallback, the kernel keyring, forgets everything on reboot, so without a
Secret Service c3cli keeps the 0600 file. Tested on macOS through the same module (set,
overwrite, delete, under a test item); not run on Windows or Linux.

How it ended up (differs from the plan below):
- No lock around the whole editor load. c3cli routes `token.json` in each context: a post
  carrying a token c3cli handed out is rewritten with the store's current token and sent
  from Node (`route.fetch`); the `newToken` in the answer goes into the store. The lock only
  covers that request. Tokens c3cli doesn't know (a login typed in the form) pass.
- The editor only uses the token after login for Scirra Store purchases (asset browser) and
  sharing a project, not for open/save/export/preview, so a token rotated by another run
  doesn't hurt an editor that's already logged in.
- macOS: `/usr/bin/security`, not `@napi-rs/keyring`: the item then trusts that tool, which
  never changes, while an item made by Node prompts again after a Node update, which would
  hang a headless run. The secret goes in through `security -i` on stdin. Elsewhere, and
  with `C3CLI_SESSION_FILE`, a 0600 JSON file.
- The refused-session confirm ("Account logged out") the editor shows wasn't seen in the
  offline test's startup dialogs; watch for it with the real server.

Findings (account.construct.net `js/1004/editor/index.js`, editor r500):
- The session is `{userID, token}` in account.construct.net's IndexedDB `localforage` /
  `keyvaluepairs`, key `login-data`, written when "Keep me logged in" is ticked. No auth
  cookie (only analytics cookies on `.construct.net`).
- The editor's hidden login frame auto-logs in at startup: POST `token.json` with the token;
  the reply carries a `newToken`, saved over the old one. A token the server refuses is
  deleted; a network error keeps it.
- Saved tokens count against a per-account quota (comment in `LogOut()`), so logging in with
  the password on every run would pile up server-side sessions.
- Checked 2026-10-06: a fake `login-data` written on a routed account.construct.net page in a
  fresh profile is read by the editor's login frame (posted to `token.json`, which was answered
  locally, so nothing fake reached Scirra) and deleted on rejection. Planting a session into a
  fresh profile works.

Design (skymen, 2026-10-06):
- `c3cli login` without `--profile` stores the session (never the password) in the OS
  keychain; it is the only live copy, since the token rotates on every use.
- Each run without a login of its own: plant the token before the editor loads, wait for the
  account to settle, write the rotated token back at once. A lock file around those seconds
  for parallel runs. `--guest` to skip.
- **A profile's own login wins**: a profile logged in with `c3cli login --profile` keeps its
  own session. c3cli has to tell those apart from profiles that only got the shared session
  planted (which hold a copy that goes stale): a marker written by `login --profile`, or
  clear the planted copy at close.
- Daemon: re-plant from the keychain before reloading tabs (`addons install`), or a reload
  logs in with a stale token.
- Keychain: open choice between macOS `security` (no dependency; token on stdin, not argv) and
  `@napi-rs/keyring` (cross-platform, native dependency, 0600-file fallback).
- To check with the real account: whether an old token still works for a while after
  rotation; whether two editors logged in at once trip a "signed in elsewhere" check.

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
