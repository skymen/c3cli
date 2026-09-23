// Run `c3cli open` over every fixture, as .c3p and as folder, and write a summary.
// usage: tsx scripts/sweep.ts [label]   → reports/sweep-<label>.jsonl + .md
import { execFile } from "node:child_process";
import { appendFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const label = process.argv[2] ?? "run";
const jsonl = `reports/sweep-${label}.raw.jsonl`;
await writeFile(jsonl, "");
const targets = [
  ...(await readdir("fixtures/c3p")).filter((f) => f.endsWith(".c3p")).map((f) => path.join("fixtures/c3p", f)),
  ...(await readdir("fixtures/folder")).map((f) => path.join("fixtures/folder", f)),
].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

const rows: string[] = [];
for (const t of targets) {
  const t0 = Date.now();
  const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
    const child = execFile("npx", ["tsx", "src/cli.ts", "open", t, "--report", "json", "--timeout", "90", "--use-project-release"], { maxBuffer: 64 << 20 }, (err, stdout) =>
      resolve({ code: err ? ((err as any).code ?? 99) : 0, stdout }));
    child.stdin?.end();
  });
  let r: any;
  try { r = JSON.parse(stdout); } catch { r = { outcome: "unparseable", error: stdout.slice(0, 300) }; }
  await appendFile(jsonl, JSON.stringify({ target: t, exit: code, wallMs: Date.now() - t0, ...r }) + "\n");
  const extra = r.missingAddons?.length ? r.missingAddons.map((a: any) => a.id).join(", ")
    : r.dialogs?.[0]?.langKey ?? r.error ?? "";
  const row = `| ${path.basename(t)} | ${t.includes("/folder/") ? "folder" : "c3p"} | ${r.release ?? ""} | ${r.outcome} | ${code} | ${((r.durationMs ?? 0) / 1000).toFixed(1)}s | ${String(extra).replace(/\|/g, "/").slice(0, 120)} |`;
  rows.push(row);
  console.log(row);
}
await writeFile(`reports/sweep-${label}.md`, `# c3cli open sweep: ${label}\n\n${new Date().toISOString()}\n\n| project | kind | release | outcome | exit | open time | detail |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}\n`);
