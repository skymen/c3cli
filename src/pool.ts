// A pool of warm editor tabs in one browser profile. A tab is leased for one project at a
// time; when it comes back it is replaced by a fresh page with the editor reloaded, so the
// next lease never sees the previous project, its dialogs or its preview windows.
// Used in-process by C3Editor.launch() and, behind a socket, by the daemon.
import type { BrowserContext, Page } from "playwright";
import { ReleaseNotFound, clearStaging, launch, loadEditor, type Session } from "./editor.ts";
import type { Worker } from "playwright";
import { captureRuntime, evalIn, type RemoteRuntime } from "./preview.ts";
import type { Release } from "./release.ts";

export interface TabStartup { dialogs: string[]; pageErrors: string[]; consoleErrors: string[] }

export interface Lease {
  tabId: string;
  page: Page;
  context: BrowserContext;
  release: Release;
  // What happened while this tab's editor was loading, before the lease.
  startup: TabStartup;
  // Only for leases driven over CDP (daemon), where workers aren't visible to the client.
  remoteRuntime?: RemoteRuntime;
  done(): Promise<void>;
}

// Where leases come from: a local pool, or the daemon over its socket.
export interface TabSource {
  lease(release: Release, timeoutMs: number): Promise<Lease>;
  close(): Promise<void>;
}

// The editor never became usable in a tab (distinct from a bad release name).
export class EditorLoadError extends Error {
  constructor(message: string, readonly startup: TabStartup) { super(message); }
}

interface Tab {
  id: string;
  page: Page | null;
  release: Release | null;
  startup: TabStartup;
  busy: boolean;
  // Loading or resetting in the background; a lease waits for it.
  ready: Promise<void>;
  loading: boolean;
  popups: Page[];
}

export interface PoolOptions {
  profile?: string;
  headed: boolean;
  tabs: number;
  // Load every tab with this release right away, so the first leases are warm.
  warm?: Release;
  cdp?: boolean;
  loadTimeoutMs?: number;
}

export class LocalPool implements TabSource {
  private waiters: (() => void)[] = [];
  private closed = false;

  private constructor(readonly session: Session, private tabs: Tab[], private loadTimeoutMs: number) {}

  static async launch(opts: PoolOptions): Promise<LocalPool> {
    const session = await launch({ profile: opts.profile, headed: opts.headed, cdp: opts.cdp });
    const tabs: Tab[] = Array.from({ length: Math.max(1, opts.tabs) }, (_, i) => ({
      id: `tab-${i + 1}`, page: null, release: null, busy: false, ready: Promise.resolve(), loading: false, popups: [],
      startup: { dialogs: [], pageErrors: [], consoleErrors: [] },
    }));
    const pool = new LocalPool(session, tabs, opts.loadTimeoutMs ?? 60_000);
    // Leftover staged projects from a crashed run: safe to clear, nothing is leased yet.
    await clearStaging(session.page);
    tabs[0].page = session.page;
    if (opts.warm) {
      for (const tab of tabs) tab.ready = pool.load(tab, opts.warm).catch(() => {});
      await Promise.all(tabs.map((t) => t.ready));
    }
    return pool;
  }

  get cdpUrl() { return this.session.cdpUrl; }

  status() {
    return this.tabs.map((t) => ({ id: t.id, busy: t.busy, release: t.release?.name ?? null }));
  }

  async lease(release: Release, timeoutMs: number): Promise<Lease> {
    const tab = await this.acquire(timeoutMs);
    try {
      await tab.ready;
      if (!tab.page || tab.page.isClosed() || tab.release?.name !== release.name) await this.load(tab, release);
    } catch (e) {
      this.free(tab, true);
      throw e;
    }
    return {
      tabId: tab.id,
      page: tab.page!,
      context: this.session.context,
      release,
      startup: tab.startup,
      done: async () => this.free(tab, true),
    };
  }

  // The runtime of a tab's most recent preview window, captured with this pool's own
  // browser connection (which sees workers). Remembered until the next preview.
  private runtimes = new Map<string, { window: Page; realm: Page | Worker }>();

  async attachRuntime(tabId: string): Promise<"page" | "worker" | null> {
    const tab = this.tabs.find((t) => t.id === tabId);
    const window = tab?.popups.filter((p) => !p.isClosed()).at(-1);
    if (!window) return null;
    const realm = await captureRuntime<Page | Worker>([window, ...window.workers()]);
    if (!realm) return null;
    this.runtimes.set(tabId, { window, realm });
    return realm === window ? "page" : "worker";
  }

  async evalRuntime(tabId: string, expr: string): Promise<unknown> {
    const r = this.runtimes.get(tabId);
    if (!r || r.window.isClosed()) throw new Error("no attached preview runtime for this tab");
    return evalIn(r.realm, expr);
  }

  async close() {
    this.closed = true;
    await this.session.close();
  }

  private async acquire(timeoutMs: number): Promise<Tab> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.closed) throw new Error("the editor pool is closed");
      // Prefer a warm tab over one still being reset from its last project.
      const tab = this.tabs.find((t) => !t.busy && !t.loading) ?? this.tabs.find((t) => !t.busy);
      if (tab) { tab.busy = true; return tab; }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no free editor tab within ${Math.round(timeoutMs / 1000)} s (all ${this.tabs.length} busy)`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  // Return a tab. With `reset`, it is replaced by a fresh page in the background; the next
  // lease waits for that (and reloads with the release it needs).
  private free(tab: Tab, reset: boolean) {
    if (reset && !this.closed) {
      const old = tab.page;
      const popups = tab.popups.splice(0);
      tab.page = null;
      const release = tab.release;
      tab.loading = true;
      tab.ready = (async () => {
        for (const p of [...popups, old]) await p?.close({ runBeforeUnload: false }).catch(() => {});
        if (release) await this.load(tab, release).catch(() => {});
        tab.loading = false;
      })();
    }
    tab.busy = false;
    this.waiters.shift()?.();
  }

  // Put a fresh page in the tab (unless it has an unused one) and load the editor in it.
  private async load(tab: Tab, release: Release) {
    if (!tab.page || tab.page.isClosed()) tab.page = await this.session.context.newPage();
    const page = tab.page;
    tab.release = null;
    const startup: TabStartup = { dialogs: [], pageErrors: [], consoleErrors: [] };
    const onError = (e: Error) => startup.pageErrors.push(e.stack ?? e.message);
    const onConsole = (m: import("playwright").ConsoleMessage) => { if (m.type() === "error") startup.consoleErrors.push(m.text()); };
    page.on("pageerror", onError);
    page.on("console", onConsole);
    page.on("popup", (p) => tab.popups.push(p));
    try {
      startup.dialogs = await loadEditor(page, release, this.loadTimeoutMs);
    } catch (e) {
      if (e instanceof ReleaseNotFound) throw e;
      throw new EditorLoadError((e as Error).message.split("\n")[0], startup);
    } finally {
      page.off("pageerror", onError);
      page.off("console", onConsole);
    }
    // Lets a daemon client find this tab among the browser's pages.
    await page.evaluate((id) => { (window as any).__c3cliTabId = id; }, tab.id);
    tab.release = release;
    tab.startup = startup;
  }
}
