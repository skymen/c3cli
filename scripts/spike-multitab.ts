// Spike: can one browser profile run several editor tabs, each with its own project open?
import { chromium } from "playwright";
import { clickOpen, loadEditor, stageProject } from "../src/editor.ts";
import { waitForOutcome } from "../src/observe.ts";
import { readProjectInfo } from "../src/project.ts";
import { resolveBranch } from "../src/release.ts";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const release = await resolveBranch("stable");
const ctx = await chromium.launchPersistentContext(await mkdtemp(path.join(os.tmpdir(), "c3cli-mt-")), { headless: true, viewport: { width: 1400, height: 900 } });
await ctx.addInitScript(`globalThis.__name = (fn) => fn; window.__c3cliPick = null; const take = () => { const h = window.__c3cliPick; window.__c3cliPick = null; if (!h) throw new DOMException("x", "AbortError"); return h; }; window.showDirectoryPicker = async () => take(); window.showOpenFilePicker = async () => [take()];`);
const tabs = [ctx.pages()[0] ?? await ctx.newPage(), await ctx.newPage(), await ctx.newPage()];
const t0 = Date.now();
await Promise.all(tabs.map((p) => loadEditor(p, release, 60000)));
console.log(`3 editors loaded in ${Date.now() - t0}ms`);
for (const [i, p] of tabs.entries()) console.log(`tab ${i} dialogs:`, await p.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => d.id + ": " + (d as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 150))));
const projects = ["fixtures/c3p/untitled.c3p", "fixtures/folder/demofoil", "fixtures/c3p/3d-lighting.c3p"];
const t1 = Date.now();
const results = await Promise.all(tabs.map(async (p, i) => {
  const info = await readProjectInfo(projects[i]);
  await stageProject(p, info, `tab${i}`);
  await clickOpen(p, info.kind);
  const r = await waitForOutcome(p, { projectName: info.name, assetUrl: release.assetUrl, timeoutMs: 60000, installBundledAddons: true });
  return `${projects[i]} → ${r.outcome} (title "${await p.title()}")`;
}));
console.log(`parallel opens in ${Date.now() - t1}ms:\n  ` + results.join("\n  "));
await ctx.close();
