// Extract a zip (a .c3p, an export) into a folder. C3 projects saved on Windows can use
// backslash separators, which `unzip` refuses to treat as directories — normalise them here.
// Unix modes and symlinks recorded in the zip are kept: desktop exports (Linux, macOS .app,
// NW.js) carry executables that must stay executable.
import yauzl from "yauzl";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function unzipProject(zipPath: string, outDir: string): Promise<number> {
  const zip = await new Promise<yauzl.ZipFile>((res, rej) =>
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (e, z) => (e ? rej(e) : res(z!))),
  );
  let count = 0;
  await new Promise<void>((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", resolve);
    zip.on("entry", (entry: yauzl.Entry) => {
      const rel = entry.fileName.replace(/\\/g, "/");
      const dest = path.join(outDir, rel);
      if (!dest.startsWith(path.resolve(outDir) + path.sep)) return reject(new Error(`unsafe path in zip: ${rel}`));
      if (rel.endsWith("/")) return mkdir(dest, { recursive: true }).then(() => zip.readEntry(), reject);
      zip.openReadStream(entry, async (err, stream) => {
        if (err) return reject(err);
        try {
          const chunks: Buffer[] = [];
          for await (const c of stream!) chunks.push(c as Buffer);
          await mkdir(path.dirname(dest), { recursive: true });
          // Made on Unix: the high 16 bits of the external attributes are st_mode.
          const mode = (entry.versionMadeBy >> 8) === 3 ? (entry.externalFileAttributes >>> 16) & 0o177777 : 0;
          if ((mode & 0o170000) === 0o120000) {
            const target = Buffer.concat(chunks).toString("utf8");
            if (path.isAbsolute(target) || !path.resolve(path.dirname(dest), target).startsWith(path.resolve(outDir) + path.sep)) throw new Error(`unsafe symlink in zip: ${rel} → ${target}`);
            await symlink(target, dest);
          } else {
            await writeFile(dest, Buffer.concat(chunks));
            if (mode & 0o777) await chmod(dest, mode & 0o777);
          }
          count++;
          zip.readEntry();
        } catch (e) { reject(e); }
      });
    });
    zip.readEntry();
  });
  return count;
}
