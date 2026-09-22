import { readdir } from "node:fs/promises";
import path from "node:path";
import { unzipProject } from "../src/unzip.ts";

for (const f of (await readdir("fixtures/c3p")).filter((f) => f.endsWith(".c3p"))) {
  const out = path.resolve("fixtures/folder", f.replace(/\.c3p$/, ""));
  try { console.log(f, await unzipProject(path.join("fixtures/c3p", f), out)); }
  catch (e) { console.log(f, "FAIL", (e as Error).message); }
}
