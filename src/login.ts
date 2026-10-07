// Log in with email/username + password through the editor's own login dialog
// (an account.construct.net iframe, accountbeta.construct.net on beta releases). OAuth
// providers are deliberately not supported.
//
// The password is only ever passed to frame.fill(). It is never logged or returned, and
// every error message is scrubbed of it (Playwright call logs echo fill() values).
import type { Page } from "playwright";
import { clickMainSubmenuItem } from "./editor.ts";
import type { EditorText } from "./lang.ts";

// The login frame's site: account.construct.net, or accountbeta.construct.net on beta releases.
const ACCOUNT_SITE = /^https:\/\/account(beta)?\.construct\.net\//;

export interface Account {
  name: string;
  edition: "free" | "paid";
  // False until the editor has checked the account (the name reads "..." meanwhile).
  settled: boolean;
  loggedIn: boolean;
}

// The editor always puts "Free edition" in #userLicenseType but hides it (display: none)
// for licensed accounts, so the label's visibility is the signal, not its text.
// Until the editor has checked the account, the name reads "..." (user-account.waiting) and
// the edition label is hidden (which would look like "paid"): nothing is known yet. When
// logged out, the name is "Guest" (user-account.guest), in the editor's language.
export async function readAccount(page: Page, text: EditorText): Promise<Account> {
  const a = await page.evaluate(() => {
    const label = document.querySelector("#userLicenseType") as HTMLElement | null;
    const shown = !!label && getComputedStyle(label).display !== "none";
    return {
      name: document.querySelector("#userAccountName")?.textContent?.trim() ?? "",
      edition: shown ? "free" as const : "paid" as const,
    };
  });
  const settled = a.name !== "" && a.name !== text.t("user-account.waiting");
  return { ...a, settled, loggedIn: settled && a.name !== text.t("user-account.guest") };
}

export const isSettled = (a: Account) => a.settled;
export const isLoggedIn = (a: Account) => a.loggedIn;

export async function waitForAccount(page: Page, timeoutMs: number, text: EditorText): Promise<Account> {
  const deadline = Date.now() + timeoutMs;
  let a = await readAccount(page, text);
  while (!isSettled(a) && Date.now() < deadline) { await page.waitForTimeout(250); a = await readAccount(page, text); }
  return a;
}

export type LoginOutcome = "logged-in" | "already-logged-in" | "login-failed";

export interface LoginResult {
  outcome: LoginOutcome;
  account: Account;
  // The account logged out of first: the profile was logged in as someone else, or maybe
  // not (a login by email can't be compared). Its saved session is gone, even if the login
  // then failed.
  loggedOut?: string;
  dialog?: { id: string; text: string };
  error?: string;
}

// The top bar shows the username: a login by email can't be compared with it.
const sameAccount = (shown: string, login: string) => !login.includes("@") && shown.toLowerCase() === login.trim().toLowerCase();

export async function logIn(page: Page, username: string, password: string, timeoutMs: number, text: EditorText): Promise<LoginResult> {
  const scrub = (s: string) => (password ? s.split(password).join("•••") : s);
  const before = await waitForAccount(page, 15_000, text);
  let loggedOut: string | undefined;
  if (isLoggedIn(before)) {
    if (sameAccount(before.name, username)) return { outcome: "already-logged-in", account: before };
    // Someone else, or maybe not (an email): log out, then in, rather than keep the wrong one.
    const out = await logOut(page, timeoutMs, text);
    if (out.outcome !== "logged-out") return { outcome: "login-failed", account: out.account, error: `could not log out of ${before.name} first${out.error ? `: ${out.error}` : ""}` };
    loggedOut = before.name;
  }
  try {
    await clickMainSubmenuItem(page, text.t("main-menu.account-menu"), text.t("user-account.menu.log-in"));

    const deadline = Date.now() + timeoutMs;
    let frame = null;
    while (!frame && Date.now() < deadline) {
      frame = page.frames().find((f) => ACCOUNT_SITE.test(f.url()) && new URL(f.url()).pathname === "/login") ?? null;
      if (!frame) await page.waitForTimeout(250);
    }
    if (!frame) throw new Error("the login form never appeared");
    await frame.waitForSelector("#loginForm #username", { timeout: Math.max(1000, deadline - Date.now()) });
    await frame.fill("#username", username);
    await frame.fill("#password", password);
    await frame.setChecked("#remember", true).catch(() => {});
    await frame.click("#login");

    // Success: the top bar shows the account name. Failure: the editor opens a dialog.
    while (Date.now() < deadline) {
      const account = await readAccount(page, text);
      if (isLoggedIn(account)) return { outcome: "logged-in", account, ...(loggedOut ? { loggedOut } : {}) };
      const dialog = await page.evaluate(() => {
        const d = [...document.querySelectorAll("dialog[open]")].find((x) => x.id !== "loginDialog" && x.id !== "progressDialog");
        return d ? { id: d.id, text: (d as HTMLElement).innerText.replace(/\s+/g, " ").trim() } : null;
      });
      if (dialog) {
        await page.keyboard.press("Escape").catch(() => {});
        return { outcome: "login-failed", account, dialog: { id: dialog.id, text: scrub(dialog.text) }, ...(loggedOut ? { loggedOut } : {}) };
      }
      await page.waitForTimeout(250);
    }
    return { outcome: "login-failed", account: await readAccount(page, text), error: "timed out waiting for the login to finish", ...(loggedOut ? { loggedOut } : {}) };
  } catch (e) {
    return { outcome: "login-failed", account: await readAccount(page, text).catch(() => before), error: scrub((e as Error).message.split("\n")[0]), ...(loggedOut ? { loggedOut } : {}) };
  }
}

export type LogoutOutcome = "logged-out" | "not-logged-in" | "logout-failed";

export interface LogoutResult {
  outcome: LogoutOutcome;
  account: Account;
  // The account that was logged out.
  from?: string;
  // The server confirmed it dropped the saved session (logout.json). False when the request
  // failed or never came (a login made without "Keep me logged in" has nothing to drop).
  serverDropped?: boolean;
  error?: string;
}

// Menu → Account → Log out. The editor asks nothing; its login frame tells the server to drop
// the saved session (logout.json) without waiting for the answer, so this waits for it:
// closing the browser right away could cut the request off.
export async function logOut(page: Page, timeoutMs: number, text: EditorText): Promise<LogoutResult> {
  const before = await waitForAccount(page, 15_000, text);
  if (!isLoggedIn(before)) return { outcome: "not-logged-in", account: before };
  const dropped = page.waitForResponse((r) => ACCOUNT_SITE.test(r.url()) && new URL(r.url()).pathname === "/logout.json", { timeout: Math.min(timeoutMs, 10_000) })
    .then((r) => r.ok(), () => false);
  try {
    await clickMainSubmenuItem(page, text.t("main-menu.account-menu"), text.t("user-account.menu.log-out"));
    const deadline = Date.now() + timeoutMs;
    let account = await readAccount(page, text);
    while (isLoggedIn(account) && Date.now() < deadline) { await page.waitForTimeout(250); account = await readAccount(page, text); }
    if (isLoggedIn(account)) return { outcome: "logout-failed", account, error: "still logged in after Log out" };
    return { outcome: "logged-out", account, from: before.name, serverDropped: await dropped };
  } catch (e) {
    return { outcome: "logout-failed", account: await readAccount(page, text).catch(() => before), error: (e as Error).message.split("\n")[0] };
  }
}
