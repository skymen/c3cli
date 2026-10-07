// The shared login: one Construct account session for every c3cli run, so logging in once
// (`c3cli login`) is enough instead of once per profile (tasks/auth.md).
//
// Construct keeps a login as {userID, token} in account.construct.net's IndexedDB
// (localforage → "login-data"); beta releases use accountbeta.construct.net, which accepts
// the same tokens (checked 2026-10-06), so c3cli treats both alike. At startup the editor's hidden login frame posts it to
// token.json and saves the newToken it gets back, so every editor load rotates the token.
// The token (never the password) is kept in the OS keychain, the only live copy:
// - a browser context gets it planted, so its login frame tries an auto-login at all;
// - every token.json post that carries a token c3cli handed out is rewritten to carry the
//   keychain's current one, and the newToken in the answer goes back into the keychain. A
//   lock (in this process and across processes) covers just that request, so parallel runs
//   and tabs never spend the same token twice.
// A profile with a login of its own (`c3cli login --profile`) keeps it: nothing is planted
// or rewritten there.
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Route } from "playwright";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "c3cli");

export interface StoredSession { userID: number; token: string; username: string; savedAt: string }

export interface LoginData { userID: number; token: string }

export interface SessionStore {
  // Where the session is kept, for messages.
  readonly where: string;
  readonly lockPath: string;
  get(): Promise<StoredSession | null>;
  set(s: StoredSession): Promise<void>;
  // False when there was nothing to delete.
  delete(): Promise<boolean>;
}

const SERVICE = "c3cli", ACCOUNT = "construct-session";

function decode(text: string): StoredSession | null {
  try {
    const s = JSON.parse(text);
    return typeof s?.userID === "number" && typeof s?.token === "string" && s.token && typeof s?.username === "string" ? s : null;
  } catch { return null; }
}

function run(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    p.stdin.end(input ?? "");
  });
}

// macOS: a generic password in the login keychain, through /usr/bin/security. The item's
// access list then trusts that tool, which doesn't change with Node updates, so no prompt
// ever blocks a headless run. The secret goes in on stdin (`security -i`), never in argv
// where `ps` would show it, base64-encoded so it needs no quoting.
class KeychainStore implements SessionStore {
  readonly where = `the macOS keychain (item "${SERVICE}", account "${ACCOUNT}")`;
  readonly lockPath = path.join(CONFIG_DIR, "session.lock");

  async get() {
    const r = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
    if (r.code === 44) return null; // not found
    if (r.code !== 0) throw new Error(`could not read the keychain: ${r.stderr.trim()}`);
    return decode(Buffer.from(r.stdout.trim(), "base64").toString("utf8"));
  }

  async set(s: StoredSession) {
    const secret = Buffer.from(JSON.stringify(s)).toString("base64");
    const r = await run("/usr/bin/security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "c3cli Construct 3 session" -w ${secret}\n`);
    // Interactive mode exits 0 even when the command fails; failures show on stderr.
    if (r.code !== 0 || r.stderr.trim()) throw new Error(`could not write the keychain: ${r.stderr.trim() || `exit ${r.code}`}`);
  }

  async delete() {
    const r = await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
    return r.code === 0;
  }
}

// Windows (Credential Manager) and Linux (the Secret Service: GNOME Keyring, KWallet…),
// through @napi-rs/keyring. Exported for tests.
export class KeyringStore implements SessionStore {
  readonly where: string;
  readonly lockPath = path.join(CONFIG_DIR, "session.lock");
  constructor(private entry: import("@napi-rs/keyring").AsyncEntry, where: string) { this.where = where; }

  async get() {
    const s = await this.entry.getPassword();
    return s ? decode(s) : null;
  }

  async set(s: StoredSession) { await this.entry.setPassword(JSON.stringify(s)); }

  async delete() { return this.entry.deletePassword(); }
}

// The OS store for Windows and Linux, or null when there's none: no Secret Service on this
// Linux (a server, CI), or no build of the native module for this platform. On Linux the
// Secret Service is required: the package would otherwise fall back to the kernel keyring,
// which forgets everything on reboot.
async function keyringStore(service = SERVICE): Promise<KeyringStore | null> {
  try {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    const linux = process.platform === "linux";
    const entry = new AsyncEntry(service, ACCOUNT, linux ? { linux: { store: "secret-service" } } : undefined);
    if (linux) await entry.getPassword(); // a Secret Service that is there but can't be read
    const name = linux ? "the Secret Service keyring" : process.platform === "win32" ? "the Windows Credential Manager" : "the OS keyring";
    return new KeyringStore(entry, `${name} (item "${service}")`);
  } catch {
    return null;
  }
}

// Otherwise (and with C3CLI_SESSION_FILE): a JSON file only the user can read (0600 in a
// 0700 folder). Weaker than a keychain: anything that can read the user's files can read it.
class FileStore implements SessionStore {
  readonly where: string;
  readonly lockPath: string;
  constructor(readonly file: string) { this.where = file; this.lockPath = `${file}.lock`; }

  async get() {
    try { return decode(await readFile(this.file, "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }

  async set(s: StoredSession) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  async delete() {
    try { await rm(this.file); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  }
}

// macOS: the keychain through `security`. Windows, Linux: their store through the keyring
// module, else the file.
export async function sessionStore(): Promise<SessionStore> {
  const file = process.env.C3CLI_SESSION_FILE;
  if (file) return new FileStore(path.resolve(file));
  if (process.platform === "darwin") return new KeychainStore();
  return (await keyringStore()) ?? new FileStore(path.join(CONFIG_DIR, "session.json"));
}

// For tests: a keyring store under another service name, whatever the platform.
export const testKeyringStore = (service: string) => keyringStore(service);

// One handover at a time: in this process (a promise chain) and across processes (a lock file
// created exclusively; one whose process is gone, or older than 30 s, is taken over).
let chain: Promise<unknown> = Promise.resolve();

export function withSessionLock<T>(lockPath: string, fn: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  const result = chain.then(() => fileLocked(lockPath, fn, timeoutMs));
  chain = result.catch(() => {});
  return result;
}

async function fileLocked<T>(lockPath: string, fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const h = await open(lockPath, "wx", 0o600);
      await h.writeFile(String(process.pid));
      await h.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (await staleLock(lockPath)) { await rm(lockPath, { force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`the shared session stayed locked by another c3cli (${lockPath})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { return await fn(); } finally { await rm(lockPath, { force: true }); }
}

async function staleLock(lockPath: string): Promise<boolean> {
  try {
    const [pid, info] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    if (Date.now() - info.mtimeMs > 30_000) return true;
    const n = Number(pid);
    if (!n) return false; // being written
    try { process.kill(n, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code !== "EPERM"; }
  } catch { return false; } // gone already: the next try takes it
}

export const ACCOUNT_ORIGINS = ["https://account.construct.net", "https://accountbeta.construct.net"];

// Read or change "login-data" in a context's storage on both account sites (a get returns
// the first found), from a blank page c3cli serves at each origin (nothing is fetched). The
// editor's login frame is same-site with the editor, so it sees this same storage.
export async function accountStorage(context: BrowserContext, op: "get" | "delete"): Promise<LoginData | null>;
export async function accountStorage(context: BrowserContext, op: "set", value: LoginData): Promise<LoginData | null>;
export async function accountStorage(context: BrowserContext, op: "get" | "set" | "delete", value?: LoginData): Promise<LoginData | null> {
  let found: LoginData | null = null;
  for (const origin of ACCOUNT_ORIGINS) found = found ?? (await accountStorageAt(context, origin, op, value));
  return found;
}

async function accountStorageAt(context: BrowserContext, origin: string, op: "get" | "set" | "delete", value?: LoginData): Promise<LoginData | null> {
  const STUB = `${origin}/__c3cli_session`;
  const serve = (r: Route) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>c3cli</title>" });
  await context.route(STUB, serve);
  const page = await context.newPage();
  try {
    await page.goto(STUB);
    return await page.evaluate(async ([op, value]) => {
      // The database and store localforage (and the frame's kvstorage) use.
      const db: IDBDatabase = await new Promise((ok, ko) => {
        const q = indexedDB.open("localforage", 2);
        q.onupgradeneeded = () => { if (!q.result.objectStoreNames.contains("keyvaluepairs")) q.result.createObjectStore("keyvaluepairs"); };
        q.onsuccess = () => ok(q.result);
        q.onerror = () => ko(q.error);
      });
      try {
        const tx = db.transaction("keyvaluepairs", op === "get" ? "readonly" : "readwrite");
        const store = tx.objectStore("keyvaluepairs");
        const req = op === "get" ? store.get("login-data") : op === "set" ? store.put(value, "login-data") : store.delete("login-data");
        const got = await new Promise((ok, ko) => { req.onsuccess = () => ok(req.result); req.onerror = () => ko(req.error); });
        await new Promise((ok, ko) => { tx.oncomplete = ok; tx.onerror = () => ko(tx.error); });
        const d = got as { userID?: unknown; token?: unknown } | undefined;
        return op === "get" && d && typeof d.userID === "number" && typeof d.token === "string" ? { userID: d.userID, token: d.token } : null;
      } finally { db.close(); }
    }, [op, value ?? null] as const);
  } finally {
    await page.close().catch(() => {});
    await context.unroute(STUB, serve).catch(() => {});
  }
}

// token.json posts are multipart form data; the fields are plain text.
export function formField(body: string, name: string): string | null {
  const m = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(body);
  return m ? m[1] : null;
}

export function setFormField(body: string, name: string, value: string): string {
  return body.replace(new RegExp(`(name="${name}"\\r\\n\\r\\n)[^\\r]*(\\r\\n)`), (_, a, b) => `${a}${value}${b}`);
}


export interface TokenReply { status: number; headers: Record<string, string>; body: string }

// Sends the rewritten token.json post to the server (from Node, with the context's cookies).
// Tests swap it for a local answer, so no made-up token ever reaches Scirra.
export type TokenTransport = (route: Route, postData: string) => Promise<TokenReply>;

const sendToServer: TokenTransport = async (route, postData) => {
  const res = await route.fetch({ postData });
  // The body comes back decoded: headers about its encoding and length no longer apply.
  const headers = Object.fromEntries(Object.entries(res.headers()).filter(([k]) => !["content-encoding", "content-length", "transfer-encoding"].includes(k.toLowerCase())));
  return { status: res.status(), headers, body: await res.text() };
};

// The shared session in one browser context.
export class SharedSession {
  // Tokens this context got from c3cli or from the server through c3cli: a post with one of
  // these is the shared session's auto-login. Any other (a login typed in the form) passes.
  private known = new Set<string>();
  // What happened (expired, unreachable…), for reports. Read with drainNotes().
  private notes: string[] = [];
  // The account the last handover logged in as.
  username: string | null = null;

  private constructor(readonly store: SessionStore) {}

  static transport: TokenTransport = sendToServer;

  drainNotes(): string[] { return this.notes.splice(0); }

  // Use the stored session in `context`, unless `profile` (a persistent profile) has a login of
  // its own. Null when nothing is stored, or when the store can't be read (with a note).
  static async attach(context: BrowserContext, profile: string | null, notes: string[] = []): Promise<SharedSession | null> {
    let store: SessionStore;
    let stored: StoredSession | null;
    try { store = await sessionStore(); stored = await store.get(); }
    catch (e) { notes.push(`shared session not used: ${(e as Error).message}`); return null; }
    if (!stored) return null;
    if (profile && !(await hasMarker(profile)) && (await accountStorage(context, "get"))) return null; // its own login wins
    if (profile) await writeFile(markerPath(profile), "This profile gets c3cli's shared session (c3cli login); its login-data is a copy.\n");
    const shared = new SharedSession(store);
    shared.known.add(stored.token);
    shared.username = stored.username;
    await accountStorage(context, "set", { userID: stored.userID, token: stored.token });
    for (const origin of ACCOUNT_ORIGINS) await context.route(`${origin}/token.json`, (route) => shared.handle(route));
    return shared;
  }

  private async handle(route: Route) {
    const body = route.request().postData() ?? "";
    const posted = formField(body, "token");
    // Not the shared session: the "is a game jam live" check, or a login typed in the form.
    if (posted === null || !this.known.has(posted)) return route.continue();
    try {
      await withSessionLock(this.store.lockPath, async () => {
        const s = await this.store.get();
        if (!s) {
          this.notes.push("the shared session was removed (c3cli logout): the editor stays logged out");
          return route.abort();
        }
        const postData = setFormField(setFormField(body, "token", s.token), "userID", String(s.userID));
        let res: TokenReply;
        try { res = await SharedSession.transport(route, postData); }
        catch (e) {
          // Like an outage for the frame: it keeps its copy, and the keychain keeps the token.
          this.notes.push(`shared session: could not reach the account server (${(e as Error).message.split("\n")[0]})`);
          return route.abort();
        }
        const ok = res.status >= 200 && res.status < 300;
        let json: any = null;
        try { json = JSON.parse(res.body); } catch { /* an outage page: leave everything as it is */ }
        if (ok && json?.request?.status === "ok" && typeof json?.response?.newToken === "string") {
          const next = json.response.newToken as string;
          this.known.add(next);
          this.username = typeof json.response.user?.username === "string" ? json.response.user.username : s.username;
          await this.store.set({ userID: typeof json.response.user?.id === "number" ? json.response.user.id : s.userID, token: next, username: this.username!, savedAt: new Date().toISOString() });
        } else if (ok && json?.request) {
          // Refused: the token is dead for every run, so forget it.
          await this.store.delete();
          this.notes.push(`the shared session for ${s.username} has expired (the server refused it): log in again with c3cli login`);
        }
        await route.fulfill({ status: res.status, headers: res.headers, body: res.body });
      });
    } catch (e) {
      this.notes.push(`shared session: ${(e as Error).message.split("\n")[0]}`);
      await route.abort().catch(() => {});
    }
  }
}

// Persistent profiles that got the shared session carry a marker, so their copy of it is never
// taken for a login of their own.
const markerPath = (profile: string) => path.join(profile, "c3cli-shared-session");

export async function hasMarker(profile: string): Promise<boolean> {
  return stat(markerPath(profile)).then(() => true, () => false);
}

export async function removeMarker(profile: string): Promise<void> {
  await rm(markerPath(profile), { force: true });
}

// Keep the session c3cli's own login just made (the frame saves it once it has checked it).
export async function harvestLogin(context: BrowserContext, username: string, timeoutMs = 10_000): Promise<StoredSession | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await accountStorage(context, "get");
    if (d) return { ...d, username, savedAt: new Date().toISOString() };
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}
