// Read the few project.c3proj fields c3cli needs, from a folder or a .c3p, without the editor.
import yauzl from "yauzl";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface ProjectInfo {
  path: string;
  kind: "folder" | "file";
  name: string | null;
  savedWithRelease: number | null;
}

export async function readProjectInfo(p: string): Promise<ProjectInfo> {
  const abs = path.resolve(p);
  const kind = (await stat(abs)).isDirectory() ? "folder" : "file";
  let raw: string | null = null;
  try {
    raw = kind === "folder" ? await readFile(path.join(abs, "project.c3proj"), "utf8") : await readZipEntry(abs, "project.c3proj");
  } catch { /* not a readable project; the editor will say so */ }
  let json: any = null;
  try { json = raw && JSON.parse(raw); } catch { /* ditto */ }
  return { path: abs, kind, name: json?.name ?? null, savedWithRelease: json?.savedWithRelease ?? null };
}

function readZipEntry(zipPath: string, wanted: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip!.on("error", reject);
      zip!.on("end", () => resolve(null));
      zip!.on("entry", (e: yauzl.Entry) => {
        if (e.fileName.replace(/\\/g, "/") !== wanted) return zip!.readEntry();
        zip!.openReadStream(e, async (err2, stream) => {
          if (err2) return reject(err2);
          const chunks: Buffer[] = [];
          for await (const c of stream!) chunks.push(c as Buffer);
          zip!.close();
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      });
      zip!.readEntry();
    });
  });
}
