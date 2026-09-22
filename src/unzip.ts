// Extract a .c3p (zip) into a folder. C3 projects saved on Windows can use backslash
// separators, which `unzip` refuses to treat as directories — normalise them here.
import yauzl from "yauzl";
import { mkdir, writeFile } from "node:fs/promises";
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
        const chunks: Buffer[] = [];
        for await (const c of stream!) chunks.push(c as Buffer);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, Buffer.concat(chunks));
        count++;
        zip.readEntry();
      });
    });
    zip.readEntry();
  });
  return count;
}
