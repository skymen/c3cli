// Preview: start the project (or one layout) in the preview window, find the live runtime,
// and drive it: run code against the runtime (IRuntime) or the preview page's DOM, send
// input, wait for conditions, take screenshots, and stream logs and errors.
import { EventEmitter } from "node:events";
import type { Page, Worker } from "playwright";
import { clickProjectMenuItem, dismissDialogs } from "./editor.ts";

const PROJECT_PREVIEW_TITLE = "Run a preview of the current project.";

// Evaluated as a string in the preview page and its workers (workers don't get the
// __name shim). The runtime instance is private, but it calls C3.Runtime.prototype.Tick
// every frame: wrap it once to catch `this`, keep its IRuntime (the public scripting
// API), then restore the method.
export const CAPTURE_RUNTIME = `(async () => {
  if (globalThis.__c3cliRuntime) return true;
  if (typeof C3 === "undefined" || !C3.Runtime || typeof C3.Runtime.prototype.Tick !== "function") return false;
  const proto = C3.Runtime.prototype;
  return await new Promise((resolve) => {
    const orig = proto.Tick;
    const timer = setTimeout(() => { proto.Tick = orig; resolve(false); }, 3000);
    proto.Tick = function (...args) {
      proto.Tick = orig;
      clearTimeout(timer);
      globalThis.__c3cliRuntime = this.GetIRuntime();
      resolve(true);
      return orig.apply(this, args);
    };
  });
})()`;

// Page.evaluate and Worker.evaluate overloads don't unify; both take a plain string.
export const evalIn = <T>(realm: Page | Worker, expr: string) => (realm as Worker).evaluate(expr) as Promise<T>;

// Turn a function (or a function body) into source that can run in any realm. Callers'
// functions may be compiled with esbuild's keepNames, which wraps names in __name(): define
// it locally so the code also runs in workers.
function callExpr(fn: Function | string, params: string, args: string): string {
  const src = typeof fn === "string" ? `async (${params}) => { ${fn} }` : fn.toString();
  return `(async () => { const __name = (f) => f; return await (${src})(${args}); })()`;
}

export async function activateLayout(page: Page, name: string): Promise<void> {
  const items = page.locator("ui-treeitem.layout:not(.parentItem)");
  const names = (await items.allInnerTexts()).map((t) => t.trim().split("\n")[0]);
  const index = names.indexOf(name);
  if (index < 0) throw new Error(`no layout named "${name}" (layouts: ${names.join(", ") || "none"})`);
  // The double-click handler sits on the name label, not on the tree item itself.
  await items.nth(index).locator(".tree-item-name").first().dblclick();
  await page.waitForFunction((name) =>
    [...document.querySelectorAll("ui-tab[active]")].some((t) => (t as HTMLElement).innerText.trim() === name), name, { timeout: 10_000 })
    .catch(() => { throw new Error(`layout "${name}" did not become the active view`); });
}

// For tabs driven over CDP (daemon): a client connection doesn't see the preview's
// workers, so worker-mode runtimes are found and evaluated by the daemon instead.
export interface RemoteRuntime {
  attach(): Promise<"page" | "worker" | null>;
  eval(expr: string): Promise<unknown>;
}

// Find the runtime among `realms` and capture it. Returns the realm it lives in.
export async function captureRuntime<R extends Page | Worker>(realms: R[]): Promise<R | null> {
  for (const realm of realms) if (await evalIn<boolean>(realm, CAPTURE_RUNTIME).catch(() => false)) return realm;
  return null;
}

export interface PreviewEvents {
  log: [text: string, type: string];
  consoleError: [text: string];
  pageError: [error: string];
}

export class LivePreview extends EventEmitter<PreviewEvents> {
  // Where the runtime lives: the preview page (DOM mode) or its runtime worker.
  realm: Page | Worker | null = null;
  // Set when the runtime was found through the daemon (a worker this client can't see).
  private remoteIn: "page" | "worker" | null = null;
  readonly log: string[] = [];
  readonly consoleErrors: string[] = [];
  readonly pageErrors: string[] = [];

  private constructor(readonly window: Page, private remote?: RemoteRuntime) {
    super();
    // Worker console output and uncaught worker errors also arrive on these page events.
    window.on("console", (m) => {
      const text = m.text();
      if (/Registered (root )?service worker/.test(text)) return;
      if (m.type() === "error") { this.consoleErrors.push(text); this.emit("consoleError", text); }
      else { this.log.push(`[${m.type()}] ${text}`); this.emit("log", text, m.type()); }
    });
    window.on("pageerror", (e) => { const s = e.stack ?? e.message; this.pageErrors.push(s); this.emit("pageError", s); });
  }

  // Start a preview from an editor page with a project open. Without `layout`: the whole
  // project (Menu → Preview, from its first layout). With `layout`: make that layout active
  // and "Preview layout" (F5), so the runtime starts directly on it.
  static async start(editor: Page, opts: { layout?: string; remote?: RemoteRuntime } = {}): Promise<LivePreview> {
    await dismissDialogs(editor);
    if (opts.layout) await activateLayout(editor, opts.layout);
    // The editor's own popup, not any new window (other tabs may be previewing too).
    const popupP = editor.waitForEvent("popup", { timeout: 20_000 });
    if (opts.layout) await editor.keyboard.press("F5");
    else await clickProjectMenuItem(editor, PROJECT_PREVIEW_TITLE);
    // If the editor can't build the preview it shows a dialog instead ("Failed to start
    // preview"): report that right away rather than waiting out the popup timeout.
    const refusedP = editor.waitForFunction(() => {
      const d = document.querySelector("dialog[open]:not(#progressDialog)") as HTMLElement | null;
      return d ? d.innerText.replace(/\s+/g, " ").trim() : null;
    }, null, { timeout: 20_000, polling: 250 }).then((h) => h.jsonValue() as Promise<string>, () => null);
    const first = await Promise.race([popupP.then((w) => ({ w }), () => null), refusedP.then((t) => (t ? { t } : null))]);
    if (first && "t" in first) {
      await dismissDialogs(editor);
      throw new Error(`the editor refused to start the preview: ${first.t}`);
    }
    const window = first?.w ?? (await popupP.catch(() => { throw new Error("no preview window opened within 20 s"); }));
    const preview = new LivePreview(window, opts.remote);
    await window.waitForLoadState("domcontentloaded").catch(() => {});
    return preview;
  }

  get runtimeIn(): "page" | "worker" | null {
    return this.realm ? (this.realm === this.window ? "page" : "worker") : this.remoteIn;
  }

  // Find the realm that runs the runtime and capture it. False if it never started ticking.
  async attach(timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.realm = await captureRuntime<Page | Worker>([this.window, ...this.window.workers()]);
      if (this.realm) return true;
      if (this.remote) {
        this.remoteIn = await this.remote.attach().catch(() => null);
        if (this.remoteIn) return true;
      }
      await this.window.waitForTimeout(250);
    }
    return false;
  }

  // Run `fn(runtime, arg)` where the runtime lives. `runtime` is the IRuntime scripting API.
  // `fn` is serialized: it can't close over local variables; pass data through `arg` (JSON).
  // A string is treated as a function body with `runtime` and `arg` in scope.
  async eval<T = unknown, A = undefined>(fn: ((runtime: any, arg: A) => T | Promise<T>) | string, arg?: A): Promise<T> {
    if (!this.runtimeIn && !(await this.attach())) throw new Error("the preview runtime was not found");
    const expr = callExpr(fn, "runtime, arg", `globalThis.__c3cliRuntime, ${JSON.stringify(arg ?? null)}`);
    return this.realm ? evalIn<T>(this.realm, expr) : this.remote!.eval(expr) as Promise<T>;
  }

  // Run `fn(arg)` in the preview page's DOM (window, document), even when the runtime is in
  // a worker.
  async evalDom<T = unknown, A = undefined>(fn: ((arg: A) => T | Promise<T>) | string, arg?: A): Promise<T> {
    return evalIn<T>(this.window, callExpr(fn, "arg", JSON.stringify(arg ?? null)));
  }

  // Poll `fn` on the runtime until it returns something truthy; returns that value.
  async waitFor<T = unknown, A = undefined>(fn: ((runtime: any, arg: A) => T | Promise<T>) | string, opts: { arg?: A; timeoutMs?: number; intervalMs?: number } = {}): Promise<T> {
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    for (;;) {
      const v = await this.eval<T, A>(fn, opts.arg);
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`waitFor timed out after ${opts.timeoutMs ?? 10_000} ms`);
      await this.window.waitForTimeout(opts.intervalMs ?? 100);
    }
  }

  // Input goes to the preview window like real user input. Click the canvas first if the
  // game needs focus for keyboard input.
  get keyboard() { return this.window.keyboard; }
  get mouse() { return this.window.mouse; }
  get touchscreen() { return this.window.touchscreen; }

  screenshot(opts: { path?: string } = {}) { return this.window.screenshot(opts); }

  async close() { await this.window.close().catch(() => {}); }
}

export interface PreviewResult {
  started: boolean;
  url: string | null;
  seconds: number;
  requestedLayout: string | null;
  startLayout: string | null;
  runtimeIn: "page" | "worker" | null;
  log: string[];
  consoleErrors: string[];
  pageErrors: string[];
  error?: string;
}

// One-shot preview for the CLI: start, record which layout the runtime is on, collect
// output for `seconds`, close.
export async function runPreview(editor: Page, opts: { seconds: number; layout?: string; remote?: RemoteRuntime }): Promise<PreviewResult> {
  const r: PreviewResult = {
    started: false, url: null, seconds: opts.seconds, requestedLayout: opts.layout ?? null,
    startLayout: null, runtimeIn: null, log: [], consoleErrors: [], pageErrors: [],
  };
  let p: LivePreview;
  try { p = await LivePreview.start(editor, { layout: opts.layout, remote: opts.remote }); }
  catch (e) { return { ...r, error: (e as Error).message }; }
  r.url = p.window.url();
  const t0 = Date.now();
  if (await p.attach()) {
    r.started = true;
    r.runtimeIn = p.runtimeIn;
    r.startLayout = await p.eval<string>((runtime) => runtime.layout.name).catch(() => null);
  }
  await p.window.waitForTimeout(Math.max(0, opts.seconds * 1000 - (Date.now() - t0)));
  Object.assign(r, { log: p.log, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors });
  if (!r.started) {
    const booted = r.log.some((l) => l.includes("[C3 runtime]"));
    r.error = booted
      ? `the runtime loaded but never ran its first tick${r.pageErrors.length ? " (crashed during startup)" : ""}`
      : "preview window opened but the runtime never loaded";
  }
  else if (opts.layout && r.startLayout !== opts.layout) r.error = `preview started on "${r.startLayout}", not "${opts.layout}"`;
  await p.close();
  return r;
}
