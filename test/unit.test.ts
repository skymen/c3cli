import { test } from "node:test";
import assert from "node:assert/strict";
import { exactRelease, releaseName, releaseNum } from "../src/release.ts";
import { buildTemplates, fillTemplate, isProjectTitle, makeText, matchLangKey } from "../src/lang.ts";
import { parseBundledAddon, parseMissingAddons } from "../src/observe.ts";

test("release names and numbers round-trip", () => {
  assert.equal(releaseNum("r495-2"), 49502);
  assert.equal(releaseNum("r495.2"), 49502);
  assert.equal(releaseNum("r497"), 49700);
  assert.equal(releaseName(49700), "r497");
  assert.equal(releaseName(44902), "r449-2");
  assert.equal(exactRelease("r495.2").url, "https://editor.construct.net/r495-2/");
  assert.throws(() => releaseNum("latest"));
});

const lang = buildTemplates({
  ui: {
    errors: {
      "project-saved-in-newer-release": "This project cannot be opened since it was saved in a newer version of Construct. The project was saved in [a1]{0}[/a1], and you are currently using [b]{1}[/b]. Use a newer version of Construct to open the project.",
      "failed-to-open-c3-project": "Failed to open project. Check it is a valid Construct 3 single-file (.c3p) project.",
    },
    dialogs: { missingAddons: { "header-text": "The project you are opening uses the following addons that are not installed. Try installing these missing plugins, behaviors and effects and then re-open the project." } },
    catchall: "{0}: [b]{1}[/b] events and more",
  },
});

test("lang keys match through placeholders and markup", () => {
  assert.equal(
    matchLangKey(lang, "This project cannot be opened since it was saved in a newer version of Construct. The project was saved in r497, and you are currently using r495.2. Use a newer version of Construct to open the project."),
    "ui.errors.project-saved-in-newer-release");
  assert.equal(matchLangKey(lang, "Failed to open project. Check it is a valid Construct 3 single-file (.c3p) project."), "ui.errors.failed-to-open-c3-project");
});

test("mostly-placeholder templates don't match arbitrary text", () => {
  assert.equal(matchLangKey(lang, "Layout 1: 25 events and more, plus a long tail of unrelated words that the template does not cover"), null);
});

test("missing addons are parsed from the dialog body", () => {
  const dialogs = [{ id: "missingAddonsDialog", langKey: null, title: "Missing addons", buttons: ["Close"],
    body: "The project you are opening uses…\nEffect Foil Effect (dumivid_HolographicFoil) by dumivid\nPlugin Dedra SDK (skymen_dedra_sdk_wrapper)\n" +
      "Note: legacy (SDK v1) addons are no longer supported in this release of Construct and so cannot be installed. The last release that supports legacy addons is the r449 LTS release." }];
  assert.deepEqual(parseMissingAddons(dialogs), [
    { type: "Effect", name: "Foil Effect", id: "dumivid_HolographicFoil", author: "dumivid" },
    { type: "Plugin", name: "Dedra SDK", id: "skymen_dedra_sdk_wrapper", author: null },
  ]);
});

test("bundled addon prompt fields are parsed", () => {
  const body = "Only install addons from sources you trust.\nWould you like to install the following addon?\nName\nSSAOFOG\nVersion\n1.1.1\nType\nEffect\nAuthor\nMikal, FedericoCalchera\nWebsite\nhttps://www.construct.net";
  assert.deepEqual(parseBundledAddon(body, true), { name: "SSAOFOG", version: "1.1.1", type: "Effect", author: "Mikal, FedericoCalchera", installed: true });
});

// The editor in French: the same dialogs, parsed with the French lang file (r495-2 strings),
// falling back to English for keys it doesn't translate.
const fr = makeText([{
  "ui": { "dialogs": {
    "missingAddons": {
      "missing-plugin-format": "Plugin [b]{0}[/b] ({1}) par [i]{2}[/i]",
      "missing-behavior-format": "Comportement [b]{0}[/b] ({1}) par [i]{2}[/i]",
      "missing-effect-format": "Effet [b]{0}[/b] ({1}) par [i]{2}[/i]",
    },
    "addonConfirmInstall": { "name": "Nom", "version": "Version", "type": "Type", "author": "Auteur" },
  } },
  "user-account": { "guest": "Invité" },
}, {
  "user-account": { "guest": "Guest", "waiting": "..." },
  "main-menu": { "project-menu": { "save-as": "Save as" } },
}], "fr-FR");

test("lang lookups use the editor's language, then English in brackets like the editor", () => {
  assert.equal(fr.t("user-account.guest"), "Invité");
  assert.equal(fr.t("user-account.waiting"), "[...]");
  assert.equal(fr.t("main-menu.project-menu.save-as"), "[Save as]");
  assert.equal(fr.raw("main-menu.project-menu.save-as"), "[Save as]");
  assert.throws(() => fr.t("main-menu.no-such-key"), /no-such-key/);
});

test("templates fill their placeholders in order", () => {
  assert.deepEqual(fillTemplate("Plugin [b]{0}[/b] ({1}) by [i]{2}[/i]", "Plugin Dedra SDK (skymen_dedra) by skymen"), ["Dedra SDK", "skymen_dedra", "skymen"]);
  assert.deepEqual(fillTemplate("{1} ({0})", "b (a)"), ["a", "b"]);
  assert.equal(fillTemplate("Plugin [b]{0}[/b] ({1}) by [i]{2}[/i]", "Behavior X (y) by z"), null);
});

test("missing addons and the install prompt are parsed in French", () => {
  const dialogs = [{ id: "missingAddonsDialog", langKey: null, title: "Addons manquants", buttons: ["Fermer"],
    body: "Le projet que vous ouvrez utilise…\nEffet Foil Effect (dumivid_HolographicFoil) par dumivid\nComportement Better Input (skymen_bim) par skymen" }];
  assert.deepEqual(parseMissingAddons(dialogs, fr), [
    { type: "Effect", name: "Foil Effect", id: "dumivid_HolographicFoil", author: "dumivid" },
    { type: "Behavior", name: "Better Input", id: "skymen_bim", author: "skymen" },
  ]);
  const body = "N'installez des addons que de sources sûres.\nNom\nSSAOFOG\nVersion\n1.1.1\nType\nEffet\nAuteur\nMikal";
  assert.deepEqual(parseBundledAddon(body, false, fr), { name: "SSAOFOG", version: "1.1.1", type: "Effet", author: "Mikal", installed: false });
});

test("window titles follow the language's branch wording", () => {
  const en = makeText([{ ui: { "title-beta": "{0} beta", "title-lts": "{0} LTS" } }], "en-US");
  const it = makeText([{ ui: { "title-beta": "beta {0}" } }, { ui: { "title-beta": "{0} beta", "title-lts": "{0} LTS" } }], "it-IT");
  assert.ok(isProjectTitle("Pong - Construct 3", "Pong", en));
  assert.ok(isProjectTitle("Pong - Construct 3 beta", "Pong", en));
  assert.ok(isProjectTitle("Pong - Construct 3 LTS", "Pong", en));
  assert.ok(isProjectTitle("Pong - beta Construct 3", "Pong", it));
  assert.ok(!isProjectTitle("Pong - beta Construct 3", "Pong", en));
  assert.ok(!isProjectTitle("Pongo - Construct 3", "Pong", en));
  // r449-5 in Japanese: no ui.title-lts, so the editor shows the English one in brackets.
  const ja = makeText([{ ui: { "title-beta": "{0} ベータ" } }, { ui: { "title-beta": "{0} beta", "title-lts": "{0} LTS" } }], "ja-JP");
  assert.ok(isProjectTitle("Pong - [Construct 3 LTS]", "Pong", ja));
  assert.ok(isProjectTitle("Pong - Construct 3 ベータ", "Pong", ja));
});

test("token.json form fields are read and replaced", async () => {
  const { formField, setFormField } = await import("../src/session.ts");
  const b = "------B\r\nContent-Disposition: form-data; name=\"userID\"\r\n\r\n12\r\n------B\r\nContent-Disposition: form-data; name=\"token\"\r\n\r\nold-token\r\n------B\r\nContent-Disposition: form-data; name=\"productType\"\r\n\r\ngames\r\n------B--\r\n";
  assert.equal(formField(b, "token"), "old-token");
  assert.equal(formField(b, "userID"), "12");
  assert.equal(formField(b, "password"), null);
  const c = setFormField(setFormField(b, "token", "a-much-longer-new-token"), "userID", "345");
  assert.equal(formField(c, "token"), "a-much-longer-new-token");
  assert.equal(formField(c, "userID"), "345");
  assert.equal(formField(c, "productType"), "games");
});

test("the session file store keeps the session private and round-trips it", async () => {
  const { mkdtemp, rm, stat } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "c3cli-session-"));
  const file = path.join(dir, "sub", "session.json");
  const saved = process.env.C3CLI_SESSION_FILE;
  process.env.C3CLI_SESSION_FILE = file;
  try {
    const { sessionStore } = await import("../src/session.ts");
    const store = await sessionStore();
    assert.equal(await store.get(), null);
    const s = { userID: 1, token: "t", username: "someone", savedAt: "2026-10-06T00:00:00.000Z" };
    await store.set(s);
    assert.deepEqual(await store.get(), s);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await store.delete(), true);
    assert.equal(await store.delete(), false);
  } finally {
    if (saved === undefined) delete process.env.C3CLI_SESSION_FILE; else process.env.C3CLI_SESSION_FILE = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the session lock runs one handover at a time and takes over a dead holder's lock", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { withSessionLock } = await import("../src/session.ts");
  const dir = await mkdtemp(path.join(os.tmpdir(), "c3cli-lock-"));
  const lock = path.join(dir, "session.lock");
  try {
    let inside = 0, most = 0;
    const job = () => withSessionLock(lock, async () => { inside++; most = Math.max(most, inside); await new Promise((r) => setTimeout(r, 20)); inside--; });
    await Promise.all([job(), job(), job()]);
    assert.equal(most, 1);
    await writeFile(lock, "999999"); // no such process
    assert.equal(await withSessionLock(lock, async () => "ran", 2000), "ran");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("export options are checked against the platform and the release", async () => {
  const { planExport, parseSettings } = await import("../src/export.ts");
  const { exactRelease } = await import("../src/release.ts");
  const stable = exactRelease("r495-2"), beta = exactRelease("r505"), lts = exactRelease("r449-5");
  assert.deepEqual(parseSettings(["arch=x64,arm64", "command-line=--a=b"]), { arch: "x64,arm64", "command-line": "--a=b" });
  assert.throws(() => parseSettings(["arch"]), /name=value/);
  const arch = planExport("windows", stable, { settings: { arch: "x64" } })[0].control;
  assert.deepEqual(arch, { kind: "boxes", checked: ["#wv2Platformx64"], unchecked: ["#wv2PlatformArm64"] });
  assert.throws(() => planExport("windows", stable, { settings: { arch: "x86" } }), /x86 not available in r495-2/);
  assert.equal(planExport("windows", lts, { settings: { arch: "x86" } }).length, 1);
  // The same option, a select on newer releases and a checkbox before.
  assert.deepEqual(planExport("windows", beta, { settings: { steam: "overlay" } })[0].control, { kind: "select", sel: "#wv2SteamModeSelect", value: "overlay", any: false });
  assert.deepEqual(planExport("windows", stable, { settings: { steam: "on" } })[0].control, { kind: "check", sel: "#wv2SteamMode", value: true });
  assert.deepEqual(planExport("windows", stable, { settings: { steam: "overlay" } })[0].control, { kind: "check", sel: "#wv2SteamMode", value: true });
  assert.throws(() => planExport("windows", stable, { settings: { steam: "capture" } }), /steam=capture/);
  assert.throws(() => planExport("windows", lts, { settings: { bundle: "single-file" } }), /bundle=single-file/);
  assert.throws(() => planExport("windows", lts, { settings: { "window-caption": "off" } }), /isn't in r449-5/);
  assert.equal((planExport("android", stable, { settings: { "min-version": "8.1" } })[0].control as { value: string }).value, "810");
  assert.throws(() => planExport("android", stable, { settings: { "version-code": "-1" } }), /whole number/);
  assert.throws(() => planExport("ios", stable, { settings: { "version-code": "3" } }), /has no option "version-code"/);
  assert.throws(() => planExport("nwjs", stable, {}), /up to r449 \(LTS\)/);
  assert.throws(() => planExport("linux", stable, { offline: true }), /web export option/);
  assert.equal(planExport("macos", stable, { settings: { camera: "To take photos" } })[0].where, "permissions");
  assert.equal(planExport("linux", stable, { settings: { "optimize-images": "on" } })[0].where, "standard");
});

