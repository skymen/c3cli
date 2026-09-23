// Spike: find layout items in the Project bar and how to make one active.
import { clickOpen, launch, loadEditor, stageProject } from "../src/editor.ts";
import { waitForOutcome } from "../src/observe.ts";
import { readProjectInfo } from "../src/project.ts";
import { resolveBranch } from "../src/release.ts";

const project = await readProjectInfo(process.argv[2] ?? "fixtures/c3p/3d-lighting.c3p");
const release = await resolveBranch("stable");
const s = await launch({ headed: false });
const page = s.page;
await loadEditor(page, release, 60000);
await stageProject(page, project, "layout");
await clickOpen(page, project.kind);
console.log("open:", (await waitForOutcome(page, { projectName: project.name, assetUrl: release.assetUrl, timeoutMs: 60000, installBundledAddons: true })).outcome);
await page.keyboard.press("Escape");
console.log("TREE ITEMS:", await page.evaluate(() =>
  [...document.querySelectorAll("ui-treeitem, [role=treeitem]")].slice(0, 25).map((e) => {
    const attrs = [...e.attributes].map((a) => `${a.name}=${a.value}`).join(" ").slice(0, 120);
    return `${e.tagName} {${attrs}} "${(e as HTMLElement).innerText.trim().split("\n")[0]}"`;
  })));
console.log("TABS:", await page.evaluate(() => [...document.querySelectorAll("ui-tab, [role=tab]")].map((t) => `${(t as HTMLElement).innerText.trim()}${t.getAttribute("aria-selected") === "true" || t.hasAttribute("selected") || t.classList.contains("active") ? " *" : ""} {${[...t.attributes].map((a) => a.name).join(",")}}`)));
const popupP = s.context.waitForEvent("page");
await page.keyboard.press("F5");
const popup = await popupP;
await popup.waitForTimeout(9000);
console.log("LAYOUT (DOM)", JSON.stringify(await popup.evaluate(`(() => { try { const rt = globalThis.c3_runtimeInterface._GetLocalRuntime(); const ir = rt.GetIRuntime(); return { layout: ir.layout.name, layouts: ir.getAllLayouts ? ir.getAllLayouts().map((l) => l.name) : null, useWorker: globalThis.c3_useWorker }; } catch (e) { return { err: String(e), useWorker: globalThis.c3_useWorker }; } })()`)));
console.log("RI PROTO", JSON.stringify(await popup.evaluate(`(() => { const ri = globalThis.c3_runtimeInterface; const names = new Set(); for (let o = ri; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const n of Object.getOwnPropertyNames(o)) names.add(n); return [...names].filter((n) => /runtime|layout|local|get/i.test(n)).slice(0, 60); })()`)));
console.log("C3 SEARCH", JSON.stringify(await popup.evaluate(`(() => {
  const hits = [];
  const seen = new Set();
  const visit = (o, path, depth) => {
    if (!o || (typeof o !== "object" && typeof o !== "function") || seen.has(o) || depth > 3) return;
    seen.add(o);
    try { if (o instanceof globalThis.IRuntime) hits.push(path + " (IRuntime)"); } catch {}
    try { if (typeof o.GetIRuntime === "function" && typeof o !== "function") hits.push(path + " (has GetIRuntime)"); } catch {}
    for (const k of Object.getOwnPropertyNames(o)) { let v; try { v = o[k]; } catch { continue; } visit(v, path + "." + k, depth + 1); }
  };
  visit(globalThis.C3, "C3", 0);
  visit(globalThis.c3_runtimeInterface, "ri", 0);
  return hits.slice(0, 10);
})()`)));
console.log("TICKY METHODS", JSON.stringify(await popup.evaluate(`Object.getOwnPropertyNames(C3.Runtime.prototype).filter((n) => /tick|frame|step|render|draw/i.test(n)).slice(0, 20)`)));
console.log("CAPTURE", JSON.stringify(await popup.evaluate(`new Promise((resolve) => {
  const proto = C3.Runtime.prototype;
  const name = Object.getOwnPropertyNames(proto).find((n) => /^_?Tick$/.test(n)) || Object.getOwnPropertyNames(proto).find((n) => /tick/i.test(n));
  const orig = proto[name];
  proto[name] = function (...a) { proto[name] = orig; const ir = this.GetIRuntime(); resolve({ via: name, layout: ir.layout.name, layouts: ir.getAllLayouts().map((l) => l.name) }); return orig.apply(this, a); };
  setTimeout(() => { proto[name] = orig; resolve({ via: name, err: "no tick within 3s" }); }, 3000);
})`)));
console.log("PAGE KEYS", JSON.stringify(await popup.evaluate(`Object.getOwnPropertyNames(globalThis).filter((k) => /c3|runtime|construct/i.test(k)).slice(0, 30)`)));
for (const w of popup.workers()) {
  const probe = await w.evaluate(`(() => {
    const keys = Object.getOwnPropertyNames(globalThis).filter((k) => /c3|runtime|construct/i.test(k));
    return { url: location.href, keys: keys.slice(0, 20) };
  })()`).catch((e) => ({ err: e.message }));
  console.log("WORKER", JSON.stringify(probe));
}
await s.close();
