// Log in with email/username + password through the editor's own login dialog
// (an account.construct.net iframe). OAuth providers are deliberately not supported.
//
// The password is only ever passed to frame.fill(). It is never logged or returned, and
// every error message is scrubbed of it (Playwright call logs echo fill() values).
import type { Page } from "playwright";

export interface Account { name: string; edition: "free" | "paid" }

// The editor always puts "Free edition" in #userLicenseType but hides it (display: none)
// for licensed accounts, so the label's visibility is the signal, not its text.
export async function readAccount(page: Page): Promise<Account> {
  return page.evaluate(() => {
    const label = document.querySelector("#userLicenseType") as HTMLElement | null;
    const shown = !!label && getComputedStyle(label).display !== "none";
    return {
      name: document.querySelector("#userAccountName")?.textContent?.trim() ?? "",
      edition: shown ? "free" as const : "paid" as const,
    };
  });
}

// Until the editor has checked the account, the name reads "..." and the edition label is
// hidden (which would look like "paid"): nothing is known yet (r495-2 / r500 lang strings).
export const isSettled = (a: Account) => a.name !== "" && a.name !== "...";
// "Guest" is the only name shown when logged out.
export const isLoggedIn = (a: Account) => isSettled(a) && a.name !== "Guest";

export async function waitForAccount(page: Page, timeoutMs: number): Promise<Account> {
  const deadline = Date.now() + timeoutMs;
  let a = await readAccount(page);
  while (!isSettled(a) && Date.now() < deadline) { await page.waitForTimeout(250); a = await readAccount(page); }
  return a;
}

export type LoginOutcome = "logged-in" | "already-logged-in" | "login-failed";

export interface LoginResult { outcome: LoginOutcome; account: Account; dialog?: { id: string; text: string }; error?: string }

export async function logIn(page: Page, username: string, password: string, timeoutMs: number): Promise<LoginResult> {
  const scrub = (s: string) => (password ? s.split(password).join("•••") : s);
  const before = await waitForAccount(page, 15_000);
  if (isLoggedIn(before)) return { outcome: "already-logged-in", account: before };
  try {
    await page.click("#mainMenuButton");
    await page.locator("ui-menuitem[sub-menu]", { hasText: "Account" }).first().click();
    await page.waitForTimeout(500);
    await page.locator("ui-menuitem", { hasText: /^Log in$/ }).first().click();

    const deadline = Date.now() + timeoutMs;
    let frame = null;
    while (!frame && Date.now() < deadline) {
      frame = page.frames().find((f) => f.url().startsWith("https://account.construct.net/login")) ?? null;
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
      const account = await readAccount(page);
      if (isLoggedIn(account)) return { outcome: "logged-in", account };
      const dialog = await page.evaluate(() => {
        const d = [...document.querySelectorAll("dialog[open]")].find((x) => x.id !== "loginDialog" && x.id !== "progressDialog");
        return d ? { id: d.id, text: (d as HTMLElement).innerText.replace(/\s+/g, " ").trim() } : null;
      });
      if (dialog) {
        await page.keyboard.press("Escape").catch(() => {});
        return { outcome: "login-failed", account, dialog: { id: dialog.id, text: scrub(dialog.text) } };
      }
      await page.waitForTimeout(250);
    }
    return { outcome: "login-failed", account: await readAccount(page), error: "timed out waiting for the login to finish" };
  } catch (e) {
    return { outcome: "login-failed", account: await readAccount(page).catch(() => before), error: scrub((e as Error).message.split("\n")[0]) };
  }
}
