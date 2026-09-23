// The daemon: one long-lived browser with a pool of warm editor tabs, shared by every
// c3cli command and library user on the machine.
//
// It listens on a Unix socket for newline-delimited JSON requests, and only hands out tabs:
//   {id, op: "lease", release}  → {id, ok, tabId, cdpUrl, release, startup}   (waits for a free tab)
//   {id, op: "done", tabId}     → {id, ok}    (the tab is reset in the background)
//   {id, op: "attachRuntime", tabId}     → {id, ok, realm: "page"|"worker"|null}
//   {id, op: "evalRuntime", tabId, expr} → {id, ok, value}
//     (a client's CDP connection doesn't see preview workers; the daemon's does)
//   {id, op: "status"}          → {id, ok, pid, startedAt, profile, cdpUrl, tabs}
//   {id, op: "stop"}            → {id, ok}    (then the daemon exits)
// Clients drive a leased tab themselves over the Chrome DevTools protocol (cdpUrl), with the
// same code as a local pool. A client that disconnects gives back all its tabs.
import { chromium, type Browser, type Page } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, open, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EditorLoadError, LocalPool, type Lease, type TabSource, type TabStartup } from "./pool.ts";
import { ReleaseNotFound } from "./editor.ts";
import { exactRelease, type Release } from "./release.ts";

export const DAEMON_DIR = path.join(os.homedir(), ".config", "c3cli");
export const DEFAULT_SOCKET = path.join(DAEMON_DIR, "daemon.sock");
export const DAEMON_LOG = path.join(DAEMON_DIR, "daemon.log");

export interface DaemonOptions { socket: string; tabs: number; profile?: string; headed: boolean; warm: Release }

export interface DaemonStatus {
  pid: number;
  startedAt: string;
  profile: string;
  cdpUrl: string;
  tabs: { id: string; busy: boolean; release: string | null }[];
}

// Run the daemon in this process until it is stopped.
export async function runDaemon(opts: DaemonOptions): Promise<void> {
  await mkdir(path.dirname(opts.socket), { recursive: true });
  if (await isRunning(opts.socket)) throw new Error(`a daemon is already running on ${opts.socket}`);
  await rm(opts.socket, { force: true });

  const pool = await LocalPool.launch({ profile: opts.profile, headed: opts.headed, tabs: opts.tabs, warm: opts.warm, cdp: true });
  const startedAt = new Date().toISOString();
  const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
  const leases = new Map<string, Lease>();

  let stopping = false;
  const server = net.createServer((sock) => {
    const mine = new Set<string>();
    let buf = "";
    const reply = (msg: object) => { if (!sock.destroyed) sock.write(JSON.stringify(msg) + "\n"); };
    sock.on("data", (chunk) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) void handle(JSON.parse(line));
      }
    });
    // A client that goes away gives its tabs back.
    sock.on("close", () => { for (const id of mine) void giveBack(id); });
    sock.on("error", () => {});

    const handle = async (req: { id: number; op: string; release?: string; tabId?: string; timeoutMs?: number; expr?: string }) => {
      try {
        if (req.op === "status") {
          reply({ id: req.id, ok: true, pid: process.pid, startedAt, profile: opts.profile ?? "(temporary)", cdpUrl: pool.cdpUrl, tabs: pool.status() });
        } else if (req.op === "lease") {
          const lease = await pool.lease(exactRelease(req.release!), req.timeoutMs ?? 120_000);
          if (sock.destroyed) { await lease.done(); return; }
          leases.set(lease.tabId, lease);
          mine.add(lease.tabId);
          log(`lease ${lease.tabId} ${lease.release.name}`);
          reply({ id: req.id, ok: true, tabId: lease.tabId, cdpUrl: pool.cdpUrl, release: lease.release.name, startup: lease.startup });
        } else if (req.op === "done") {
          mine.delete(req.tabId!);
          await giveBack(req.tabId!);
          reply({ id: req.id, ok: true });
        } else if (req.op === "attachRuntime") {
          reply({ id: req.id, ok: true, realm: await pool.attachRuntime(req.tabId!) });
        } else if (req.op === "evalRuntime") {
          reply({ id: req.id, ok: true, value: await pool.evalRuntime(req.tabId!, req.expr!) });
        } else if (req.op === "stop") {
          reply({ id: req.id, ok: true });
          void stop();
        } else {
          reply({ id: req.id, ok: false, error: `unknown op ${req.op}` });
        }
      } catch (e) {
        const err = e as Error;
        reply({
          id: req.id, ok: false, error: err.message,
          kind: e instanceof EditorLoadError ? "editor-load" : e instanceof ReleaseNotFound ? "release-not-found" : "error",
          startup: e instanceof EditorLoadError ? e.startup : undefined,
        });
      }
    };
  });

  const giveBack = async (tabId: string) => {
    const lease = leases.get(tabId);
    if (!lease) return;
    leases.delete(tabId);
    log(`done ${tabId}`);
    await lease.done();
  };

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log("stopping");
    server.close();
    await pool.close().catch(() => {});
    await rm(opts.socket, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await new Promise<void>((resolve) => server.listen(opts.socket, resolve));
  log(`daemon ready: ${opts.tabs} tab(s), ${opts.warm.name}, socket ${opts.socket}, cdp ${pool.cdpUrl}`);
}

// Start the daemon in the background and wait until it answers.
export async function startDaemon(args: string[], socket: string, timeoutMs = 120_000): Promise<DaemonStatus> {
  await mkdir(DAEMON_DIR, { recursive: true });
  const logFile = await open(DAEMON_LOG, "a");
  // Same runtime and entry point as this process (node + dist/cli.js, or tsx + src/cli.ts).
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "daemon", "run", ...args], {
    detached: true,
    stdio: ["ignore", logFile.fd, logFile.fd],
  });
  child.unref();
  await logFile.close();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await daemonStatus(socket).catch(() => null);
    if (status) return status;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the daemon did not start; see ${DAEMON_LOG}`);
}

export async function isRunning(socket = DEFAULT_SOCKET): Promise<boolean> {
  return (await daemonStatus(socket).catch(() => null)) !== null;
}

export async function daemonStatus(socket = DEFAULT_SOCKET): Promise<DaemonStatus | null> {
  if (!(await stat(socket).catch(() => null))) return null;
  const c = await Connection.open(socket).catch(() => null);
  if (!c) return null;
  try {
    const r = await c.request({ op: "status" }, 5000);
    return { pid: r.pid, startedAt: r.startedAt, profile: r.profile, cdpUrl: r.cdpUrl, tabs: r.tabs };
  } finally {
    c.close();
  }
}

export async function stopDaemon(socket = DEFAULT_SOCKET): Promise<boolean> {
  const c = await Connection.open(socket).catch(() => null);
  if (!c) return false;
  try { await c.request({ op: "stop" }, 5000); } finally { c.close(); }
  for (let i = 0; i < 40 && (await stat(socket).catch(() => null)); i++) await new Promise((r) => setTimeout(r, 250));
  return true;
}

// One socket connection with request/response matching by id.
class Connection {
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  private constructor(private sock: net.Socket) {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        this.pending.get(msg.id)?.resolve(msg);
        this.pending.delete(msg.id);
      }
    });
    sock.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("the daemon closed the connection"));
      this.pending.clear();
    });
  }

  static open(socket: string): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(socket, () => resolve(new Connection(sock)));
      sock.once("error", reject);
    });
  }

  request(msg: object, timeoutMs: number): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("the daemon did not answer in time")); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.sock.write(JSON.stringify({ ...msg, id }) + "\n");
    });
  }

  close() { this.sock.end(); }
}

// Leases tabs from the daemon and drives them over CDP.
export class DaemonSource implements TabSource {
  private browser: Browser | null = null;

  private constructor(private conn: Connection) {}

  static async connect(socket = DEFAULT_SOCKET): Promise<DaemonSource | null> {
    if (!(await isRunning(socket))) return null;
    return new DaemonSource(await Connection.open(socket));
  }

  async lease(release: Release, timeoutMs: number): Promise<Lease> {
    // Waiting for a free tab can take a while when the pool is busy.
    const r = await this.conn.request({ op: "lease", release: release.name, timeoutMs }, timeoutMs + 60_000);
    if (!r.ok) {
      if (r.kind === "editor-load") throw new EditorLoadError(r.error, r.startup as TabStartup);
      if (r.kind === "release-not-found") throw new ReleaseNotFound(r.error);
      throw new Error(`daemon: ${r.error}`);
    }
    this.browser ??= await chromium.connectOverCDP(r.cdpUrl);
    const page = await this.findTab(r.tabId);
    return {
      tabId: r.tabId,
      page,
      context: this.browser.contexts()[0],
      release,
      startup: r.startup,
      remoteRuntime: {
        attach: async () => {
          const a = await this.conn.request({ op: "attachRuntime", tabId: r.tabId }, 30_000);
          if (!a.ok) throw new Error(a.error);
          return a.realm;
        },
        eval: async (expr: string) => {
          const a = await this.conn.request({ op: "evalRuntime", tabId: r.tabId, expr }, 60_000);
          if (!a.ok) throw new Error(a.error);
          return a.value;
        },
      },
      done: async () => { await this.conn.request({ op: "done", tabId: r.tabId }, 30_000).catch(() => {}); },
    };
  }

  private async findTab(tabId: string): Promise<Page> {
    for (const page of this.browser!.contexts()[0].pages()) {
      if ((await page.evaluate(() => (window as any).__c3cliTabId).catch(() => null)) === tabId) return page;
    }
    throw new Error(`daemon tab ${tabId} not found in the browser`);
  }

  async close() {
    // Disconnects only; the daemon's browser keeps running.
    await this.browser?.close().catch(() => {});
    this.conn.close();
  }
}
