// Open projects from their real location and let the editor write them back, without copies.
//
// A browser-level drag of a real path (CDP Input.dispatchDragEvent) gives the page a real
// FileSystemHandle to it. Headless Chromium grants read access only (write access needs a
// prompt nobody can click), so an init script patches the File System Access API for
// handles that came from c3cli's drops: permission checks answer "granted", and writes,
// creations and deletions go to Node through a binding, which does them on disk. Reads stay
// native.
//
// Each dropped path is a "root". Node decides where a root's writes go: nowhere (refused,
// the default), in place, or into a copy (a "mirror", for saving to another place). A drop
// can also be caught before the editor sees it, to answer the editor's next file picker.
import { access, appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

// A string, not a function: tsx/esbuild's keepNames wraps named functions in __name(),
// which doesn't exist in the page. The first line also defines it, as a no-op, for every
// page.evaluate that declares a named helper.
export const BRIDGE_SCRIPT = `(() => {
  globalThis.__name = (fn) => fn;
  if (typeof FileSystemHandle === "undefined" || window.__c3cliBridge) return;
  const D = FileSystemDirectoryHandle.prototype, F = FileSystemFileHandle.prototype, H = FileSystemHandle.prototype;
  const nat = {
    dir: D.getDirectoryHandle, file: D.getFileHandle, rm: D.removeEntry, remove: H.remove,
    entries: D.entries, values: D.values, keys: D.keys, writable: F.createWritable,
    getAs: DataTransferItem.prototype.getAsFileSystemHandle,
  };
  // handle -> { root, rel }, for every handle reached from a c3cli drop.
  const where = new WeakMap();
  // root id -> { mirror }: with a mirror, lookups resolve in that folder instead.
  const roots = new Map();
  const rootOf = (id) => { if (!roots.has(id)) roots.set(id, { mirror: null }); return roots.get(id); };
  const tag = (h, root, rel) => { where.set(h, { root, rel }); return h; };
  const join = (a, b) => (a ? a + "/" + b : b);
  const fs = async (...args) => {
    try { return await window.__c3cliFs(...args); }
    catch (e) {
      const msg = String((e && e.message) || e);
      const m = /c3cli: [^\\n]*/.exec(msg);
      throw new DOMException(m ? m[0] : msg, /not allowed/.test(msg) ? "NotAllowedError" : "InvalidModificationError");
    }
  };
  const walk = async (dir, rel, kind) => {
    const parts = rel ? rel.split("/") : [];
    let d = dir;
    for (let i = 0; i < parts.length - 1; i++) d = await nat.dir.call(d, parts[i]);
    if (!parts.length) return d;
    return (kind === "dir" ? nat.dir : nat.file).call(d, parts[parts.length - 1]);
  };

  const lookup = (kind) => async function (name, opts) {
    const w = where.get(this);
    const native = kind === "dir" ? nat.dir : nat.file;
    if (!w) return native.call(this, name, opts);
    const rel = join(w.rel, name);
    if (opts && opts.create) await fs(kind === "dir" ? "mkdir" : "touch", w.root, rel);
    const mirror = rootOf(w.root).mirror;
    return tag(mirror ? await walk(mirror, rel, kind) : await native.call(this, name), w.root, rel);
  };
  D.getDirectoryHandle = lookup("dir");
  D.getFileHandle = lookup("file");
  D.removeEntry = async function (name, opts) {
    const w = where.get(this);
    if (!w) return nat.rm.call(this, name, opts);
    await fs("rm", w.root, join(w.rel, name), !!(opts && opts.recursive));
  };
  if (nat.remove) H.remove = async function (opts) {
    const w = where.get(this);
    if (!w) return nat.remove.call(this, opts);
    await fs("rm", w.root, w.rel, !!(opts && opts.recursive));
  };
  const iter = (native, pick) => function () {
    const w = where.get(this);
    if (!w) return native.call(this);
    const self = this;
    let it = null;
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (!it) {
          const mirror = rootOf(w.root).mirror;
          it = native.call(mirror ? await walk(mirror, w.rel, "dir") : self);
        }
        const r = await it.next();
        const h = r.done ? null : pick(r.value);
        if (h) tag(h, w.root, join(w.rel, h.name));
        return r;
      },
      async return(v) { return it && it.return ? it.return(v) : { done: true, value: v }; },
    };
  };
  D.entries = iter(nat.entries, (v) => v[1]);
  D.values = iter(nat.values, (v) => v);
  D.keys = iter(nat.keys, () => null);
  D[Symbol.asyncIterator] = D.entries;
  for (const m of ["queryPermission", "requestPermission"]) {
    const o = H[m];
    H[m] = async function (d) { return where.has(this) ? "granted" : o.call(this, d); };
  }

  // Buffer the file in the page and send it to Node on close, in 8 MB chunks. Node writes a
  // temporary file and renames it over the target, like Chrome's own writer.
  const CHUNK = 8 * 1024 * 1024;
  const b64 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const bytes = async (d) => d instanceof Blob ? new Uint8Array(await d.arrayBuffer())
    : typeof d === "string" ? new TextEncoder().encode(d)
    : d instanceof ArrayBuffer ? new Uint8Array(d)
    : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  F.createWritable = async function (opts) {
    const w = where.get(this);
    if (!w) return nat.writable.call(this, opts);
    let buf = opts && opts.keepExistingData ? new Uint8Array(await (await this.getFile()).arrayBuffer()) : new Uint8Array(0);
    let len = buf.length, pos = 0, done = false;
    const grow = (n) => { if (n > buf.length) { const b = new Uint8Array(Math.max(n, buf.length * 2)); b.set(buf.subarray(0, len)); buf = b; } };
    const put = (b, at) => { grow(at + b.length); buf.set(b, at); pos = at + b.length; len = Math.max(len, pos); };
    const op = async (d) => {
      if (done) throw new TypeError("the stream is closed");
      if (d && typeof d === "object" && !(d instanceof Blob) && !(d instanceof ArrayBuffer) && !ArrayBuffer.isView(d) && "type" in d) {
        if (d.type === "seek") { pos = d.position; return; }
        if (d.type === "truncate") { grow(d.size); buf.fill(0, d.size, Math.max(len, d.size)); len = d.size; pos = Math.min(pos, d.size); return; }
        put(await bytes(d.data), d.position ?? pos);
        return;
      }
      put(await bytes(d), pos);
    };
    const close = async () => {
      if (done) return;
      done = true;
      const data = buf.subarray(0, len);
      const n = Math.max(1, Math.ceil(data.length / CHUNK));
      for (let i = 0; i < n; i++) await fs("write", w.root, w.rel, b64(data.subarray(i * CHUNK, (i + 1) * CHUNK)), i, i === n - 1);
    };
    const abort = async () => { done = true; };
    const ws = new WritableStream({ write: op, close, abort });
    ws.write = op; ws.close = close; ws.abort = abort;
    ws.seek = async (p) => { pos = p; };
    ws.truncate = (size) => op({ type: "truncate", size });
    return ws;
  };

  // Drops. The editor reads a drop's handle during the drop event, so the root to tag it
  // with is set just before the drop and cleared right after it.
  DataTransferItem.prototype.getAsFileSystemHandle = function () {
    const root = window.__c3cliDropRoot;
    if (root != null) window.__c3cliDropTaken = root;
    return nat.getAs.call(this).then((h) => { if (h && root != null && !where.has(h)) tag(h, root, ""); return h; });
  };
  // A drop c3cli catches for itself: the editor never sees it.
  const catchDrag = (e) => {
    const c = window.__c3cliCatch;
    if (!c) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== "drop") return;
    window.__c3cliCatch = null;
    const item = e.dataTransfer && e.dataTransfer.items[0];
    const got = item ? nat.getAs.call(item) : Promise.resolve(null);
    window.__c3cliCaught = got.then((h) => {
      if (!h) return false;
      if (c.mirrorOf != null) rootOf(c.mirrorOf).mirror = h;
      else window.__c3cliPick = tag(h, c.root, "");
      return true;
    });
  };
  for (const t of ["dragenter", "dragover", "drop"]) window.addEventListener(t, catchDrag, true);
  window.addEventListener("drop", () => { setTimeout(() => { window.__c3cliDropRoot = null; }, 0); }, true);

  // The editor's file pickers return the handle c3cli caught, if any; else the real picker.
  const take = () => { const h = window.__c3cliPick; window.__c3cliPick = null; return h; };
  const picker = (name, wrap) => {
    const orig = window[name];
    if (typeof orig !== "function") return;
    window[name] = async function (o) { const h = take(); return h ? wrap(h) : orig.call(window, o); };
  };
  picker("showDirectoryPicker", (h) => h);
  picker("showOpenFilePicker", (h) => [h]);
  picker("showSaveFilePicker", (h) => h);

  window.__c3cliBridge = { unmirror: (id) => { rootOf(id).mirror = null; } };
})();`;

export interface Root {
  id: number;
  kind: "folder" | "file";
  // The dropped path. The page's handle reads from here.
  path: string;
  // Where writes go: nowhere (refused), the path itself (in place), or a copy.
  writeTo: string | null;
}

export interface WriteOp { op: "mkdir" | "touch" | "write" | "rm"; root: number; rel: string; at: number }

// Node's side of one editor page.
export class Bridge {
  private roots = new Map<number, Root>();
  private nextId = 1;
  readonly ops: WriteOp[] = [];
  // How many drops the last open() took (more than 1: the editor ignored the first).
  dropAttempts = 0;

  private constructor(readonly page: Page) {}

  // One bridge per page; a page is only ever leased once.
  static async attach(page: Page): Promise<Bridge> {
    const known = bridges.get(page);
    if (known) return known;
    if (!(await page.evaluate(() => !!(window as any).__c3cliBridge).catch(() => false))) {
      throw new Error("the editor page has no c3cli bridge (a daemon started by an older c3cli? restart it)");
    }
    const bridge = new Bridge(page);
    await page.exposeBinding("__c3cliFs", (_src, op: WriteOp["op"], id: number, rel: string, a?: string | boolean, i?: number, last?: boolean) =>
      bridge.handle(op, id, rel, a, i, last));
    bridges.set(page, bridge);
    return bridge;
  }

  // Drop a real file or folder onto the editor, which opens it. Returns its root, with
  // writes refused until a save allows them. Throws if the editor ignored the drop.
  async open(abs: string, kind: Root["kind"]): Promise<Root> {
    const root = this.add(abs, kind);
    // The editor reads a drop's handle in its drop handler, so a drop it didn't take was never
    // handled (seen now and then, with nothing in the way): dropping again is safe.
    for (let attempt = 1; ; attempt++) {
      await this.page.evaluate((id) => { const w = window as any; w.__c3cliDropRoot = id; w.__c3cliDropTaken = null; }, root.id);
      await drop(this.page, abs);
      const taken = await this.page.waitForFunction((id) => (window as any).__c3cliDropTaken === id, root.id, { timeout: attempt < 3 ? 3000 : 5000 }).then(() => true, () => false);
      if (taken) { this.dropAttempts = attempt; return root; }
      if (attempt === 3) {
        const open = await this.page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => d.id)).catch(() => []);
        throw new Error(`the editor did not take the dropped project after 3 drops (${open.length ? `dialogs open: ${open.join(", ")}` : "no dialog open; did its drop handling change?"})`);
      }
      await this.page.waitForTimeout(500);
    }
  }

  // Drop a real file or folder that the editor doesn't see: the editor's next file picker
  // returns it. For "save as" targets; writes go to it in place.
  async pick(abs: string, kind: Root["kind"]): Promise<Root> {
    const root = this.add(abs, kind);
    root.writeTo = abs;
    await this.catchDrop(abs, { root: root.id });
    return root;
  }

  // Until unmirror(): lookups and writes for `root` (a folder) happen in `copy`, a copy of it.
  async mirror(root: Root, copy: string): Promise<void> {
    await this.catchDrop(copy, { mirrorOf: root.id });
    root.writeTo = copy;
  }

  async unmirror(root: Root): Promise<void> {
    root.writeTo = null;
    await this.page.evaluate((id) => (window as any).__c3cliBridge.unmirror(id), root.id);
  }

  // Files written (or created or deleted) since `since`, relative to their root (a file
  // root by its name).
  changedSince(since: number, root?: Root): string[] {
    const rels = this.ops.filter((o) => o.at >= since && (!root || o.root === root.id) && o.op !== "mkdir")
      .map((o) => o.rel || path.basename(this.roots.get(o.root)!.path));
    return [...new Set(rels)].sort();
  }

  // Resolves once something was written after `since` and nothing more for quietMs.
  async quiet(since: number, timeoutMs: number, quietMs = 1500, tick?: () => Promise<void>): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(250);
      await tick?.();
      const last = this.ops.at(-1)?.at ?? 0;
      if (last >= since && Date.now() - last >= quietMs) return true;
    }
    return false;
  }

  private add(abs: string, kind: Root["kind"]): Root {
    const root: Root = { id: this.nextId++, kind, path: path.resolve(abs), writeTo: null };
    this.roots.set(root.id, root);
    return root;
  }

  private async catchDrop(abs: string, spec: { root?: number; mirrorOf?: number }) {
    await this.page.evaluate((spec) => { const w = window as any; w.__c3cliCaught = null; w.__c3cliCatch = spec; }, spec);
    await drop(this.page, abs);
    const ok = await this.page.waitForFunction(() => (window as any).__c3cliCaught, null, { timeout: 5000 })
      .then(() => this.page.evaluate(() => (window as any).__c3cliCaught))
      .catch(() => false);
    if (!ok) throw new Error(`c3cli could not get a handle to ${abs} (drop not caught)`);
  }

  private async handle(op: WriteOp["op"], id: number, rel: string, a?: string | boolean, i?: number, last?: boolean) {
    const root = this.roots.get(id);
    if (!root) throw new Error(`c3cli: unknown root ${id}`);
    if (root.writeTo === null) throw new Error(`c3cli: writing is not allowed outside a c3cli save (${rel || path.basename(root.path)})`);
    const base = root.writeTo;
    const target = rel ? path.resolve(base, ...rel.split("/")) : base;
    if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`c3cli: ${rel} is outside the project`);
    const entry: WriteOp = { op, root: id, rel, at: Date.now() };
    this.ops.push(entry);
    if (op === "mkdir") await mkdir(target, { recursive: true });
    else if (op === "touch") await access(target).catch(() => writeFile(target, ""));
    else if (op === "rm") await rm(target, { recursive: a === true, force: true });
    else if (op === "write") {
      const tmp = `${target}.c3cli-tmp`;
      const buf = Buffer.from(a as string, "base64");
      if (i === 0) { await mkdir(path.dirname(target), { recursive: true }); await writeFile(tmp, buf); }
      else await appendFile(tmp, buf);
      if (last) await rename(tmp, target);
    }
    entry.at = Date.now();
  }
}

const bridges = new WeakMap<Page, Bridge>();

// A browser-level drag and drop of real paths onto the middle of the page.
export async function drop(page: Page, paths: string | string[]): Promise<void> {
  const size = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const cdp = await page.context().newCDPSession(page);
  try {
    const data = { items: [], files: [paths].flat().map((p) => path.resolve(p)), dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await cdp.send("Input.dispatchDragEvent", { type, x: Math.round(size.width / 2), y: Math.round(size.height / 2), data } as any);
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
}
