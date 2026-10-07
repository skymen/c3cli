// Manual integration check (network): c3cli in every language the editor offers. For each,
// a fresh profile whose browser language is that one (or, when C3 doesn't pick it from the
// browser, set in Settings), then: open, missing-addons parsing, save as, export, preview,
// new, the account name, and the login menu up to the login form. With C3CLI_USERNAME and
// C3CLI_PASSWORD set, a full login too.
// usage: tsx scripts/check-languages.ts <scratch dir> [--branch stable] [--langs fr-FR,ja-JP]
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { C3Editor, resolveRelease } from "../src/api.ts";
import { clickMainMenuItem, dismissDialogs, launch, loadEditor } from "../src/editor.ts";
import { editorLang, editorText } from "../src/lang.ts";
import { logIn, waitForAccount } from "../src/login.ts";
import type { Branch } from "../src/release.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { branch: { type: "string", default: "stable" }, langs: { type: "string" } } });
if (!positionals[0]) throw new Error("usage: check-languages.ts <scratch dir>");
const scratch = path.resolve(positionals[0]);
const release = await resolveRelease({ branch: values.branch as Branch });

// The languages this release offers: its Settings dialog's language list.
const html = await (await fetch(new URL("main.html", release.assetUrl))).text();
const select = /<select class="languageSetting">([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
const all = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
if (!all.length) throw new Error("no language list in main.html");
const langs = values.langs ? values.langs.split(",") : all;
console.log(`${release.name}: ${all.length} languages (${all.join(", ")})`);

let failures = 0;
for (const lang of langs) {
  const dir = path.join(scratch, lang);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const profile = await mkdtemp(path.join(os.tmpdir(), "c3cli-lang-"));
  const results: string[] = [];
  const check = (ok: boolean, what: string) => { if (!ok) failures++; results.push(`${ok ? "ok" : "FAIL"} ${what}`); };
  try {
    // The editor's language: from the browser's, or picked in Settings, like a user would.
    const s = await launch({ profile, headed: false, locale: lang });
    let via = "browser";
    try {
      await loadEditor(s.page, release, 60_000);
      if ((await editorLang(s.page)) !== lang) {
        via = "settings";
        const ui = await editorText(s.page, release.assetUrl);
        await clickMainMenuItem(s.page, ui.t("main-menu.settings-tooltip"));
        await s.page.waitForSelector("#settingsDialog[open]");
        await s.page.selectOption("#settingsDialog select.languageSetting", lang);
        await s.page.waitForTimeout(1000);
        await dismissDialogs(s.page);
        await loadEditor(s.page, release, 60_000);
      }
      check((await editorLang(s.page)) === lang, `editor in ${await editorLang(s.page)} (via ${via})`);
      const ui = await editorText(s.page, release.assetUrl);
      const account = await waitForAccount(s.page, 15_000, ui);
      check(account.settled && !account.loggedIn, `account: "${account.name}" read as ${account.loggedIn ? "logged in" : "guest"}`);
      if (process.env.C3CLI_USERNAME && process.env.C3CLI_PASSWORD) {
        const r = await logIn(s.page, process.env.C3CLI_USERNAME, process.env.C3CLI_PASSWORD, 60_000, ui);
        check(r.outcome === "logged-in", `login → ${r.outcome}${r.error ? ` ${r.error}` : ""}`);
      } else {
        // The menu path to the login form, without logging in.
        await s.page.click("#mainMenuButton");
        await s.page.locator("ui-menuitem[sub-menu]", { hasText: ui.t("main-menu.account-menu") }).first().click();
        await s.page.waitForTimeout(500);
        const label = ui.t("user-account.menu.log-in").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        await s.page.locator("ui-menuitem", { hasText: new RegExp(`^${label}$`) }).first().click();
        const form = await s.page.waitForFunction(() => !!document.querySelector("#loginDialog[open]"), null, { timeout: 15_000 }).then(() => true, () => false);
        check(form, "login menu opens the login dialog");
      }
    } finally {
      await s.close();
    }

    // The project commands, in that language (the profile keeps the choice).
    const editor = await C3Editor.launch({ profile, locale: lang });
    try {
      const input = path.join(dir, "untitled");
      await cp("fixtures/folder/untitled", input, { recursive: true });
      const p = await editor.open(input, { release: release.name });
      check(p.report.outcome === "opened" && (await editorLang(p.page)) === lang, `open → ${p.report.outcome} (editor in ${await editorLang(p.page)})`);
      if (p.report.outcome === "opened") {
        const sa = await p.saveAs(path.join(dir, "saveas"));
        check(sa.ok, `save as → ${sa.ok ? `${sa.written.length} files` : sa.error}`);
        const ex = await p.export(path.join(dir, "export.zip"));
        check(ex.outcome === "exported", `export → ${ex.outcome}${ex.error ? ` ${ex.error}` : ""}`);
        const pv = await p.runPreview({ seconds: 1 });
        check(pv.started, `preview → ${pv.started ? "ran" : pv.error}`);
      }
      await p.close();
      const created = await editor.create(path.join(dir, "new.c3p"), { release: release.name }).catch((e: Error) => e);
      check(!(created instanceof Error), `new → ${created instanceof Error ? created.message : `${created.saved!.written.join(", ")}`}`);
      if (!(created instanceof Error)) await created.close();
      // demofoil is saved with r466: older releases (LTS) refuse it as newer, so they get one
      // saved with r449-2.
      const [fixture, missing] = release.num >= 46600 ? ["demofoil", "Effect:dumivid_HolographicFoil"] : ["16-color-replace-alpha", "Effect:16-color-replacer"];
      const m = await editor.open(`fixtures/folder/${fixture}`, { release: release.name });
      const ids = m.report.missingAddons.map((a) => `${a.type}:${a.id}`);
      check(m.report.outcome === "missing-addons" && ids.includes(missing), `missing addons → ${m.report.outcome} ${ids.join(" ")}`);
      await m.close();
    } finally {
      await editor.close();
    }
  } catch (e) {
    check(false, `threw: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
  console.log(`${lang}\n  ${results.join("\n  ")}`);
}
console.log(failures ? `${failures} failure(s)` : "all ok");
process.exitCode = failures ? 1 : 0;
