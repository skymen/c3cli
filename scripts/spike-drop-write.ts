// Spike: open a folder by dropping its real path, then let C3 save *in place*: permission
// checks on the dropped tree answer "granted", and writes go to disk through Node.
// usage: tsx scripts/spike-drop-write.ts <folder> [--saveas]
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { launch, loadEditor } from "../src/editor.ts";
import { resolveBranch } from "../src/release.ts";
import { readProjectInfo } from "../src/project.ts";
import { collect, waitForOutcome } from "../src/observe.ts";

// Plain string (see PICKER_SHIM in src/editor.ts).
const BRIDGE = `(() => {
  if (typeof FileSystemHandle === "undefined") return;
  const paths = new WeakMap();
  const join = (a, b) => (a ? a + "/" + b : b);
  const fs = (...a) => window.__c3cliFs(...a);
  const D = FileSystemDirectoryHandle.prototype, F = FileSystemFileHandle.prototype, H = FileSystemHandle.prototype;
  const oGetAs = DataTransferItem.prototype.getAsFileSystemHandle;
  DataTransferItem.prototype.getAsFileSystemHandle = async function () {
    const h = await oGetAs.call(this);
    if (h) paths.set(h, "");
    return h;
  };
  const oDir = D.getDirectoryHandle, oFile = D.getFileHandle, oRm = D.removeEntry;
  D.getDirectoryHandle = async function (name, opts) {
    const p = paths.get(this);
    if (p === undefined) return oDir.call(this, name, opts);
    if (opts && opts.create) await fs("mkdir", join(p, name));
    const h = await oDir.call(this, name);
    paths.set(h, join(p, name));
    return h;
  };
  D.getFileHandle = async function (name, opts) {
    const p = paths.get(this);
    if (p === undefined) return oFile.call(this, name, opts);
    if (opts && opts.create) await fs("touch", join(p, name));
    const h = await oFile.call(this, name);
    paths.set(h, join(p, name));
    return h;
  };
  D.removeEntry = async function (name, opts) {
    const p = paths.get(this);
    if (p === undefined) return oRm.call(this, name, opts);
    await fs("rm", join(p, name), opts && opts.recursive ? "r" : "");
  };
  const iter = (orig, pick) => function () {
    const p = paths.get(this), it = orig.call(this);
    if (p === undefined) return it;
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() { const r = await it.next(); if (!r.done) { const h = pick(r.value); paths.set(h, join(p, h.name)); } return r; },
      async return(v) { return it.return ? it.return(v) : { done: true, value: v }; },
    };
  };
  D.entries = iter(D.entries, (v) => v[1]);
  D.values = iter(D.values, (v) => v);
  D[Symbol.asyncIterator] = D.entries;
  for (const m of ["queryPermission", "requestPermission"]) {
    const o = H[m];
    H[m] = async function (d) { return paths.has(this) ? "granted" : o.call(this, d); };
  }
  const oCW = F.createWritable;
  F.createWritable = async function (opts) {
    const p = paths.get(this);
    if (p === undefined) return oCW.call(this, opts);
    let buf = opts && opts.keepExistingData ? new Uint8Array(await (await this.getFile()).arrayBuffer()) : new Uint8Array(0);
    let pos = 0, closed = false;
    const bytes = async (d) => d instanceof Blob ? new Uint8Array(await d.arrayBuffer())
      : typeof d === "string" ? new TextEncoder().encode(d)
      : d instanceof ArrayBuffer ? new Uint8Array(d)
      : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    const put = (b, at) => { const end = at + b.length; if (end > buf.length) { const n = new Uint8Array(end); n.set(buf); buf = n; } buf.set(b, at); pos = end; };
    const op = async (d) => {
      if (d && typeof d === "object" && !(d instanceof Blob) && !(d instanceof ArrayBuffer) && !ArrayBuffer.isView(d) && "type" in d) {
        if (d.type === "seek") { pos = d.position; return; }
        if (d.type === "truncate") { const n = new Uint8Array(d.size); n.set(buf.subarray(0, Math.min(d.size, buf.length))); buf = n; pos = Math.min(pos, d.size); return; }
        put(await bytes(d.data), d.position ?? pos); return;
      }
      put(await bytes(d), pos);
    };
    const flush = async () => {
      if (closed) return; closed = true;
      let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      await fs("write", p, btoa(s));
    };
    const ws = new WritableStream({ write: op, close: flush });
    ws.write = op; ws.close = flush; ws.seek = async (n) => { pos = n; }; ws.truncate = (n) => op({ type: "truncate", size: n });
    return ws;
  };
})();`;

const dir = path.resolve(process.argv[2]);
const session = await launch({ headed: false });
const { context, page } = session;
const ops: string[] = [];
await context.exposeBinding("__c3cliFs", async (_src, op: string, rel: string, arg?: string) => {
  const target = rel === "" ? dir : path.resolve(dir, rel);
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error(`c3cli: ${rel} is outside the project`);
  ops.push(`${op} ${rel}${op === "write" ? ` (${Buffer.from(arg!, "base64").length} B)` : ""}`);
  if (op === "mkdir") await mkdir(target, { recursive: true });
  else if (op === "touch") await access(target).catch(() => writeFile(target, ""));
  else if (op === "write") await writeFile(target, Buffer.from(arg!, "base64"));
  else if (op === "rm") await rm(target, { recursive: arg === "r", force: true });
});
await context.addInitScript(BRIDGE);
const release = await resolveBranch("stable");
const collector = collect(page);
await page.reload({ waitUntil: "domcontentloaded" });
await loadEditor(page, release, 60_000);
const info = await readProjectInfo(dir);
const cdp = await context.newCDPSession(page);
const data = { items: [], files: [dir], dragOperationsMask: 1 };
for (const type of ["dragEnter", "dragOver", "drop"]) await cdp.send("Input.dispatchDragEvent", { type, x: 700, y: 450, data } as any);
const result = await waitForOutcome(page, { projectName: info.name, assetUrl: release.assetUrl, timeoutMs: 30_000, installBundledAddons: true });
console.log("open:", result.outcome, "| fs ops during open:", ops.length ? ops.join(", ") : "none");
ops.length = 0;

// Make an edit: select everything in the layout and nudge it 1 px right, then Ctrl+S.
await page.mouse.click(700, 600);
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(500);
console.log("after nudge: title", JSON.stringify(await page.title()));
await page.screenshot({ path: process.env.SHOT ?? "/dev/null" });
await page.keyboard.press("ControlOrMeta+s");
await page.waitForTimeout(5000);
const dialogs = await page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => d.id + ": " + (d as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 160)));
console.log("after Ctrl+S: title", JSON.stringify(await page.title()), "dialogs", JSON.stringify(dialogs));
console.log("fs ops during save:\n  " + (ops.join("\n  ") || "none"));
console.log("errors", JSON.stringify([...collector.pageErrors, ...collector.consoleErrors.filter((e) => !/400|adapters/.test(e))].slice(0, 8)));
await session.close();
