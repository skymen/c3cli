// Compare an input project with what the editor saved, file by file. .c3p files are
// unzipped first, so both kinds diff at the level of project files.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listFiles } from "./editor.ts";
import { unzipProject } from "./unzip.ts";

export interface SaveDiff { filesChanged: number; added: string[]; removed: string[]; changed: string[] }

export async function diffProjects(before: string, after: string): Promise<SaveDiff> {
  const tmp: string[] = [];
  const asFolder = async (p: string) => {
    if ((await stat(p)).isDirectory()) return p;
    const dir = await mkdtemp(path.join(os.tmpdir(), "c3cli-diff-"));
    tmp.push(dir);
    await unzipProject(p, dir);
    return dir;
  };
  try {
    const [a, b] = [await asFolder(before), await asFolder(after)];
    const norm = (l: string[]) => new Set(l.map((f) => f.split(path.sep).join("/")));
    const [fa, fb] = [norm(await listFiles(a)), norm(await listFiles(b))];
    const added = [...fb].filter((f) => !fa.has(f)).sort();
    const removed = [...fa].filter((f) => !fb.has(f)).sort();
    const changed: string[] = [];
    for (const f of [...fa].filter((f) => fb.has(f)).sort()) {
      const [x, y] = await Promise.all([readFile(path.join(a, f)), readFile(path.join(b, f))]);
      if (!x.equals(y)) changed.push(f);
    }
    return { filesChanged: added.length + removed.length + changed.length, added, removed, changed };
  } finally {
    for (const d of tmp) await rm(d, { recursive: true, force: true });
  }
}
