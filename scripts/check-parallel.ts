// Manual integration check (needs the daemon: `c3cli daemon start --tabs 3`).
// 6 projects at once against the daemon's 3 tabs; then 3 parallel previews.
const { C3Editor, resolveRelease } = await import("../src/api.ts");
const release = await resolveRelease({});
const expected: Record<string, string> = {
  "fixtures/c3p/untitled.c3p": "opened", "fixtures/folder/demofoil": "missing-addons",
  "fixtures/c3p/_garbage.c3p": "refused", "fixtures/c3p/sokoban-gen.c3p": "opened",
  "fixtures/folder/3d_shadow_volume": "refused", "fixtures/c3p/test-gizmos.c3p": "opened",
};
const t0 = Date.now();
const results = await Promise.all(Object.keys(expected).map(async (f) => {
  const editor = await C3Editor.connect();
  const s = Date.now();
  const p = await editor.open(f, { release: release.name });
  const r = `${f.padEnd(34)} ${p.report.outcome.padEnd(15)} ${p.report.tab} ${((Date.now() - s) / 1000).toFixed(1)}s ${p.report.outcome === expected[f] ? "ok" : `EXPECTED ${expected[f]}`}`;
  await p.close(); await editor.close();
  return r;
}));
console.log(results.join("\n"), `\n6 opens on 3 tabs: ${((Date.now() - t0) / 1000).toFixed(1)}s total`);

const t1 = Date.now();
const layouts = await Promise.all([["fixtures/c3p/3d-lighting.c3p", "Layout 2"], ["fixtures/c3p/3d-lighting.c3p", "Layout 1"], ["fixtures/c3p/untitled.c3p", undefined]].map(async ([f, layout]) => {
  const editor = await C3Editor.connect();
  const p = await editor.open(f!, { release: release.name });
  const pv = await p.preview({ layout });
  const got = await pv.eval((runtime) => runtime.layout.name);
  await p.close(); await editor.close();
  return `${f} --layout ${layout ?? "(project)"} → runtime on "${got}" (${pv.runtimeIn}) ${layout && got !== layout ? "MISMATCH" : "ok"}`;
}));
console.log(layouts.join("\n"), `\n3 parallel previews: ${((Date.now() - t1) / 1000).toFixed(1)}s`);
