// Manual integration check (needs the daemon: `c3cli daemon start --tabs 3`).
// Where does a daemon-backed open spend its time?
const t0 = performance.now();
const lap = (label: string) => console.log(`${label.padEnd(26)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`);
const { resolveRelease, C3Editor } = await import("../src/api.ts");
const { DaemonSource } = await import("../src/daemon.ts");
lap("imports");
const release = await resolveRelease({});
lap("resolve stable release");
const source = await DaemonSource.connect();
const editor = C3Editor.fromSource(source!);
lap("connect to daemon");
const project = await editor.open("fixtures/c3p/untitled.c3p", { release: release.name });
lap(`open (report ${project.report.durationMs} ms)`);
await project.close();
lap("close (give tab back)");
await editor.close();
lap("disconnect");
