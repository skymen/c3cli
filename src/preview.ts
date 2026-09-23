// Preview: start the project (or one layout) in the preview window, find the live runtime,
// and collect what it logs. Built so a long-lived session can keep driving the preview.
import type { BrowserContext, Page, Worker } from "playwright";
import { clickProjectMenuItem, dismissDialogs } from "./editor.ts";

const PROJECT_PREVIEW_TITLE = "Run a preview of the current project.";

// Evaluated as a string in the preview page and its workers (workers don't get the
// __name shim). The runtime instance is private, but it calls C3.Runtime.prototype.Tick
// every frame: wrap it once to catch `this`, keep its IRuntime (the public scripting
// API), then restore the method.
const CAPTURE_RUNTIME = `(async () => {
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
const evalIn = <T>(realm: Page | Worker, expr: string) => (realm as Worker).evaluate(expr) as Promise<T>;

export interface Preview {
  window: Page;
  // Where the runtime lives: the preview page (DOM mode) or its runtime worker.
  realm: Page | Worker | null;
  log: string[];
  consoleErrors: string[];
  pageErrors: string[];
  // Evaluate a function body with `runtime` (IRuntime) in scope, e.g. "return runtime.layout.name".
  evalRuntime<T = unknown>(body: string): Promise<T>;
  close(): Promise<void>;
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

// Start a preview. Without `layout`: the whole project (Menu → Preview, from its first
// layout). With `layout`: make that layout active and "Preview layout" (F5), so the
// runtime starts directly on it.
export async function startPreview(context: BrowserContext, page: Page, opts: { layout?: string } = {}): Promise<Preview> {
  await dismissDialogs(page);
  if (opts.layout) await activateLayout(page, opts.layout);
  const popupP = context.waitForEvent("page", { timeout: 20_000 });
  if (opts.layout) await page.keyboard.press("F5");
  else await clickProjectMenuItem(page, PROJECT_PREVIEW_TITLE);
  const window = await popupP.catch(() => { throw new Error("no preview window opened within 20 s"); });

  const p: Preview = {
    window, realm: null, log: [], consoleErrors: [], pageErrors: [],
    async evalRuntime<T>(body: string): Promise<T> {
      if (!p.realm) throw new Error("the preview runtime was not found");
      return evalIn<T>(p.realm, `(async (runtime) => { ${body} })(globalThis.__c3cliRuntime)`);
    },
    close: () => window.close().catch(() => {}),
  };
  // Worker console output and uncaught worker errors also arrive on these page events.
  window.on("console", (m) => {
    const text = m.text();
    if (/Registered (root )?service worker/.test(text)) return;
    if (m.type() === "error") p.consoleErrors.push(text);
    else p.log.push(`[${m.type()}] ${text}`);
  });
  window.on("pageerror", (e) => p.pageErrors.push(e.stack ?? e.message));
  await window.waitForLoadState("domcontentloaded").catch(() => {});
  return p;
}

// Find the realm that runs the runtime and capture it. Returns false if it never showed up.
export async function attachRuntime(p: Preview, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const realm of [p.window, ...p.window.workers()]) {
      if (await evalIn<boolean>(realm, CAPTURE_RUNTIME).catch(() => false)) { p.realm = realm; return true; }
    }
    await p.window.waitForTimeout(250);
  }
  return false;
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
export async function runPreview(context: BrowserContext, page: Page, opts: { seconds: number; layout?: string }): Promise<PreviewResult> {
  const r: PreviewResult = {
    started: false, url: null, seconds: opts.seconds, requestedLayout: opts.layout ?? null,
    startLayout: null, runtimeIn: null, log: [], consoleErrors: [], pageErrors: [],
  };
  let p: Preview;
  try { p = await startPreview(context, page, { layout: opts.layout }); }
  catch (e) { return { ...r, error: (e as Error).message }; }
  r.url = p.window.url();
  const t0 = Date.now();
  if (await attachRuntime(p)) {
    r.started = true;
    r.runtimeIn = p.realm === p.window ? "page" : "worker";
    r.startLayout = await p.evalRuntime<string>("return runtime.layout.name").catch(() => null);
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
