// Download an editor release: let the editor cache itself for offline use, then copy what it
// cached to disk. The layout is the hosted one: rNNN/… plus the shared files at the root.
import { mkdir, rm, writeFile, access } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { REPORT_VERSION, checkTarget, resolveRelease } from "./api.ts";
import { ReleaseNotFound, launch } from "./editor.ts";
import { EDITOR_ORIGIN, type Branch, type Release } from "./release.ts";

export interface DownloadOptions {
  release?: string;
  branch?: Branch;
  headed?: boolean;
  // Default 300 s: the editor takes 30 to 80 s to cache a release.
  timeoutMs?: number;
  onProgress?: (cached: number, total: number) => void;
}

export interface DownloadReport {
  version: number;
  outcome: "downloaded" | "timeout";
  release: string;
  to: string;
  files: number;
  bytes: number;
  // Times the editor had to be reloaded because it stopped caching.
  reloads: number;
  error?: string;
  totalMs: number;
}

export interface CacheEntry { cache: string; url: string }
export interface CachedFile extends CacheEntry { path: string }

// With nothing cached for this long, reload: the service worker gives up on any failed fetch
// and only tries again on the next navigation, and it isn't registered if the editor's
// startup failed.
const STALL_MS = 30_000;

// Example projects are cached as they're opened, and aren't part of the editor.
const SKIP = /(^|\/)example-projects\//i;

// Where each cached URL goes on disk. Several can name one file (a folder and its
// index.html, the root cache and the release's own): the release's cache wins, then the
// URL that spells the file out.
export function planFiles(entries: CacheEntry[], release: Release): CachedFile[] {
  const rank = (e: CacheEntry) => (e.cache.includes(release.assetUrl) ? 0 : 4) + (e.url.includes("?") ? 2 : 0) + (e.url.endsWith("/") ? 1 : 0);
  const files = new Map<string, CachedFile>();
  for (const e of [...entries].sort((a, b) => rank(a) - rank(b))) {
    const url = new URL(e.url);
    if (url.origin !== EDITOR_ORIGIN) continue;
    let file = decodeURIComponent(url.pathname).slice(1);
    if (file === "" || file.endsWith("/")) file += "index.html";
    if (SKIP.test(file)) continue;
    if (file.split(/[\\/]/).includes("..")) throw new Error(`unsafe path in the editor's cache: ${e.url}`);
    if (!files.has(file)) files.set(file, { ...e, path: file });
  }
  return [...files.values()];
}

// Everything the release's offline manifest lists, as absolute URLs.
async function offlineManifest(release: Release): Promise<string[]> {
  const url = new URL("offline.json", release.assetUrl).href;
  const res = await fetch(url);
  if (!res.ok) throw new ReleaseNotFound(`editor release ${release.name} not available (HTTP ${res.status} for ${url})`);
  const { version, fileList } = (await res.json()) as { version: number; fileList: string[] };
  if (version !== release.num) throw new Error(`${url} is for release ${version}, not ${release.name}`);
  return fileList.map((f) => new URL(f, release.assetUrl).href);
}

async function cacheEntries(page: Page): Promise<CacheEntry[]> {
  return page.evaluate(async () => {
    const out: { cache: string; url: string }[] = [];
    for (const cache of await caches.keys()) {
      for (const req of await (await caches.open(cache)).keys()) out.push({ cache, url: req.url });
    }
    return out;
  });
}

// Cached bodies, as base64.
async function readCached(page: Page, batch: CacheEntry[]): Promise<string[]> {
  return page.evaluate((batch) => Promise.all(batch.map(async ({ cache, url }) => {
    const res = await (await caches.open(cache)).match(url, { ignoreVary: true });
    if (!res?.ok) throw new Error(`${url} is cached with status ${res?.status ?? "none"}`);
    const blob = await res.blob();
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const data = reader.result as string;
        resolve(data.includes(",") ? data.slice(data.indexOf(",") + 1) : ""); // an empty file can be a bare "data:"
      };
      reader.readAsDataURL(blob);
    });
  })), batch);
}

export async function downloadEditor(to: string, opts: DownloadOptions = {}): Promise<DownloadReport> {
  const started = Date.now();
  const dest = path.resolve(to);
  await checkTarget(dest, "folder");
  const release = await resolveRelease(opts);
  const manifest = await offlineManifest(release);
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const deadline = started + timeoutMs;
  const report: DownloadReport = { version: REPORT_VERSION, outcome: "downloaded", release: release.name, to: dest, files: 0, bytes: 0, reloads: 0, totalMs: 0 };

  // A fresh profile: only this release gets cached, and nothing is left behind.
  const session = await launch({ headed: opts.headed ?? false });
  const { context, page } = session;
  try {
    const swUrl = new URL("sw.js", release.assetUrl).href;
    let fetched = 0, lastActivity = Date.now();
    context.on("requestfinished", (r) => {
      if (r.serviceWorker()?.url() !== swUrl) return;
      fetched = Math.min(fetched + 1, manifest.length);
      lastActivity = Date.now();
      opts.onProgress?.(fetched, manifest.length);
    });

    // No query string: the service worker also caches the page's own URL, and would file
    // one with a search under the site's root.
    const res = await page.goto(release.assetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if (res && !res.ok()) throw new ReleaseNotFound(`editor release ${release.name} not available (HTTP ${res.status()} for ${release.assetUrl})`);

    // Ready = the release's cache holds its whole manifest. The cache existing isn't enough:
    // it's filled after it's created (r449-5 seen with 401 of 938 files).
    let entries: CacheEntry[], missing: number;
    for (;;) {
      // Fails while the page navigates.
      entries = await cacheEntries(page).catch(() => []);
      const cached = new Set(entries.filter((e) => e.cache.includes(release.assetUrl)).map((e) => e.url));
      missing = manifest.filter((u) => !cached.has(u)).length;
      if (missing === 0 || Date.now() > deadline) break;
      if (Date.now() - lastActivity > STALL_MS) {
        report.reloads++;
        fetched = 0;
        await page.reload({ waitUntil: "domcontentloaded", timeout: Math.max(1000, deadline - Date.now()) }).catch(() => {});
        lastActivity = Date.now();
      }
      await page.waitForTimeout(500);
    }
    if (missing > 0) {
      report.outcome = "timeout";
      report.error = `the editor had not cached ${release.name} after ${Math.round(timeoutMs / 1000)} s (${missing} of ${manifest.length} files missing)`;
      return report;
    }

    // The worker caches some files only as the editor asks for them (tours, other
    // languages: its lazyLoad list), and only once it controls the page. Run the editor
    // once from its cache, so what it fetches at startup is kept too
    // (tours/defaultToursList.json).
    await page.reload({ waitUntil: "networkidle", timeout: Math.min(30_000, Math.max(1000, deadline - Date.now())) }).catch(() => {});
    entries = await cacheEntries(page);
    const files = planFiles(entries, release);
    const existed = await access(dest).then(() => true, () => false);
    try {
      for (let i = 0; i < files.length; i += 25) {
        const batch = files.slice(i, i + 25);
        const bodies = await readCached(page, batch.map(({ cache, url }) => ({ cache, url })));
        await Promise.all(batch.map(async (f, j) => {
          const body = Buffer.from(bodies[j], "base64");
          const target = path.join(dest, f.path);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, body);
          report.files++;
          report.bytes += body.length;
        }));
      }
    } catch (e) {
      if (!existed) await rm(dest, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    return report;
  } finally {
    report.totalMs = Date.now() - started;
    await session.close();
  }
}
