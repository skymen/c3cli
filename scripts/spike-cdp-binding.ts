// Spike (step 0.2 of the drop plan): can a client connected over CDP (like a daemon client)
// add the bridge binding to an editor page that is already loaded, and save through it?
// usage: tsx scripts/spike-cdp-binding.ts <scratch dir>
import { chromium } from "playwright";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Bridge } from "../src/bridge.ts";
import { dismissDialogs } from "../src/editor.ts";
import { waitForOutcome } from "../src/observe.ts";
import { LocalPool } from "../src/pool.ts";
import { resolveBranch } from "../src/release.ts";

const scratch = path.resolve(process.argv[2]);
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });
const A = path.join(scratch, "project");
await cp("fixtures/folder/untitled", A, { recursive: true });
const release = await resolveBranch("stable");
const pool = await LocalPool.launch({ headed: false, tabs: 2, warm: release, cdp: true });
const lease = await pool.lease(release, 60_000);
const tabId = lease.tabId;
// The client side: its own CDP connection, finds the tab like DaemonSource does.
const browser = await chromium.connectOverCDP(pool.cdpUrl!);
let page = null;
for (const p of browser.contexts()[0].pages()) if ((await p.evaluate(() => (window as any).__c3cliTabId).catch(() => null)) === tabId) page = p;
if (!page) throw new Error("tab not found");
const bridge = await Bridge.attach(page);
const root = await bridge.open(A, "folder");
const r = await waitForOutcome(page, { projectName: "New project", assetUrl: release.assetUrl, timeoutMs: 30_000, installBundledAddons: true });
console.log("open over CDP:", r.outcome);
root.writeTo = root.path;
const since = Date.now();
await dismissDialogs(page);
await page.keyboard.press("ControlOrMeta+s");
console.log("save over CDP: quiet", await bridge.quiet(since, 20_000), bridge.changedSince(since));
await browser.close();
await lease.done();
await pool.close();
