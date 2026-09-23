import { test } from "node:test";
import assert from "node:assert/strict";
import { exactRelease, releaseName, releaseNum } from "../src/release.ts";
import { buildTemplates, matchLangKey } from "../src/lang.ts";
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
    body: "The project you are opening uses…\nEffect Foil Effect (dumivid_HolographicFoil) by dumivid\nPlugin Dedra SDK (skymen_dedra_sdk_wrapper)" }];
  assert.deepEqual(parseMissingAddons(dialogs), [
    { type: "Effect", name: "Foil Effect", id: "dumivid_HolographicFoil", author: "dumivid" },
    { type: "Plugin", name: "Dedra SDK", id: "skymen_dedra_sdk_wrapper", author: null },
  ]);
});

test("bundled addon prompt fields are parsed", () => {
  const body = "Only install addons from sources you trust.\nWould you like to install the following addon?\nName\nSSAOFOG\nVersion\n1.1.1\nType\nEffect\nAuthor\nMikal, FedericoCalchera\nWebsite\nhttps://www.construct.net";
  assert.deepEqual(parseBundledAddon(body, true), { name: "SSAOFOG", version: "1.1.1", type: "Effect", author: "Mikal, FedericoCalchera", installed: true });
});
