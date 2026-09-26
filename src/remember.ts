// Addons bundled in a project, trusted before the editor sees the project. C3 remembers
// "Don't ask me again for this addon" as the SHA-256 of each accepted .c3addon file, in
// IndexedDB `localforage` / `keyvaluepairs` under "c3-remembered-addons" (checked on r449-4,
// r449-5 and r495-2). With the project's own addons written there first, the editor installs
// them without a prompt: UTRS (57 bundled addons) opens in 4 s instead of 161 s in a fresh
// profile, where answering each prompt was nearly all the time.
import yauzl from "yauzl";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// SHA-256 of every .c3addon under the project's addons/ folder (folder project or .c3p).
export async function bundledAddonHashes(projectPath: string, kind: "folder" | "file"): Promise<string[]> {
  if (kind === "folder") {
    const out: string[] = [];
    const walk = async (d: string) => {
      let entries;
      try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.toLowerCase().endsWith(".c3addon")) out.push(sha256(await readFile(p)));
      }
    };
    await walk(path.join(projectPath, "addons"));
    return out;
  }
  return new Promise((resolve, reject) => {
    const out: string[] = [];
    yauzl.open(projectPath, { lazyEntries: true }, (err, zip) => {
      if (err) return resolve(out); // not a zip: the editor will say why
      zip!.on("error", reject);
      zip!.on("end", () => resolve(out));
      zip!.on("entry", (e: yauzl.Entry) => {
        const name = e.fileName.replace(/\\/g, "/");
        if (!name.startsWith("addons/") || !name.toLowerCase().endsWith(".c3addon")) return zip!.readEntry();
        zip!.openReadStream(e, async (err2, stream) => {
          if (err2) return reject(err2);
          const chunks: Buffer[] = [];
          for await (const c of stream!) chunks.push(c as Buffer);
          out.push(sha256(Buffer.concat(chunks)));
          zip!.readEntry();
        });
      });
      zip!.readEntry();
    });
  });
}

// Add hashes to the editor's remembered addons (on a loaded editor page). False when the
// editor's storage isn't there yet (its own first run creates it).
export async function rememberAddons(page: Page, hashes: string[]): Promise<boolean> {
  if (!hashes.length) return true;
  return page.evaluate(async (list: string[]) => {
    const db: IDBDatabase | null = await new Promise((ok) => {
      const r = indexedDB.open("localforage");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ok(null);
      r.onupgradeneeded = () => { r.transaction?.abort(); }; // never create the editor's database ourselves
    });
    if (!db) return false;
    try {
      if (!db.objectStoreNames.contains("keyvaluepairs")) return false;
      const tx = db.transaction("keyvaluepairs", "readwrite");
      const store = tx.objectStore("keyvaluepairs");
      const current: unknown = await new Promise((ok) => { const r = store.get("c3-remembered-addons"); r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); });
      const merged = [...new Set([...(Array.isArray(current) ? current : []), ...list])];
      store.put(merged, "c3-remembered-addons");
      return await new Promise<boolean>((ok) => { tx.oncomplete = () => ok(true); tx.onerror = () => ok(false); });
    } finally { db.close(); }
  }, hashes);
}
