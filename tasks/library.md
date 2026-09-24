# Node library

**Status:** implemented (2026-09-23). `src/api.ts`, `src/preview.ts`, entry `src/index.ts`
(built to `dist/index.js` with types). c3merge consumes it as a local path dev dependency
(`"c3cli": "file:../c3cli"`); npm later. c3merge's final version must not depend on it:
merging is plain JSON, and c3cli is only for its tests (skymen, 2026-09-23).

```ts
import { C3Editor } from "@skymen75/c3cli";

const editor = await C3Editor.connect();            // daemon's warm tabs
// or: await C3Editor.launch({ tabs: 2, profile, headed, warm: { branch: "stable" } })
const project = await editor.open("game.c3p", { useProjectRelease: true });
project.report;                                     // same report as `c3cli open --report json`
if (project.report.outcome === "opened") {
  await project.save("out/");                       // Ctrl+S: rewrites only files C3 considers changed
  await project.saveAs("full/");                    // Save as folder: every file, from memory
  await project.export("out.zip", { minify: "none" });
  const preview = await project.preview({ layout: "Level 1" });  // or {} for the whole project
  await preview.eval((runtime) => runtime.layout.name);          // IRuntime, page or worker
  await preview.eval((runtime, arg) => runtime.callFunction(arg.fn), { fn: "Reset" });
  await preview.evalDom(() => document.title);      // the preview page's DOM
  await preview.keyboard.down("ArrowRight");        // real input (click the canvas first)
  await preview.waitFor((runtime) => runtime.keyboard.isKeyDown("ArrowRight"));
  await preview.screenshot({ path: "shot.png" });
  preview.on("pageError", (e) => console.error(e)); // also "log", "consoleError"
  await preview.close();
}
await project.close();                              // gives the tab back
await editor.close();
```

Notes:
- `eval`/`waitFor` functions are serialized, so they can't use outer variables; pass data
  through the JSON `arg`. A string is a function body with `runtime` and `arg` in scope.
  The code runs where the runtime is: the preview page (DOM mode) or its worker.
- The runtime is reached by wrapping `C3.Runtime.prototype.Tick` once and keeping
  `this.GetIRuntime()`. See preview.md.
- `runtime.mouse.getMouseX()` returns *layout* coordinates (scroll, scale, 3D camera),
  not canvas pixels. Accessing `runtime.mouse`/`runtime.keyboard` throws if the project
  lacks that object.
- `project.page` / `preview.window` give the underlying Playwright pages as an escape hatch.

Verified (2026-09-23): through the daemon and a local pool; runtime in the page
(3d-lighting) and in a worker (untitled, battleship); keyboard down/up seen by the runtime
in both modes; mouse position; evalDom; arg passing; string bodies; screenshots; errors
thrown in the worker come back as rejected promises. Checks: `scripts/check-*.ts`.
