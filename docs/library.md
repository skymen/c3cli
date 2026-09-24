# Node library

```sh
npm install @skymen75/c3cli
npx playwright install chromium   # once, for the browser
```

```ts
import { C3Editor } from "@skymen75/c3cli";
```

The CLI is built on this API, so it gives the same results, plus live previews you can
script. It's an ES module with TypeScript types.

## Getting an editor

```ts
// A private browser with its own editor tabs.
const editor = await C3Editor.launch({
  tabs: 2,                            // projects open at once (default 1)
  profile: "/Users/me/.c3cli-profile", // keep logins; default: a fresh temporary profile
  headed: false,
  warm: { branch: "stable" },         // load this release in the tabs up front
});

// Or borrow tabs from a running daemon (`c3cli daemon start`). Throws if it isn't running.
const editor = await C3Editor.connect();

await editor.close();                 // when done (closes the browser, or disconnects)
```

## Opening a project

```ts
const project = await editor.open("game.c3p", {
  branch: "lts",                // or release: "r449-5"
  useProjectRelease: true,      // exactly the release it was saved with
  installBundledAddons: true,   // default
  timeoutMs: 60_000,
});

project.report;                 // the same report as `c3cli open --report json`
if (project.report.outcome !== "opened") console.log(project.report.dialogs);

await project.close();          // gives the tab back
```

`open` always returns a project, even when the editor refused it: check
`report.outcome` first. Save, export and preview throw when the project didn't open.
Several `open` calls can run at once, one per tab. Extra calls wait for a free tab.

## Save and export

```ts
await project.save("out/");              // Ctrl+S, written to a new folder (or a new .c3p), diffed with the input
await project.saveAs("full/");           // "Save as project folder": every file from the editor's memory
await project.export("game.zip", { minify: "none", offline: true });   // or a new folder
```

`save` only rewrites what C3 considers changed. `saveAs` writes everything C3 holds, so
use it to see the project the way C3 sees it. None of them overwrite an existing target.

## Live previews

```ts
const preview = await project.preview();               // the whole project
const preview = await project.preview({ layout: "Level 1" });

// Code on the runtime (the IRuntime scripting API), wherever it runs: page or worker.
await preview.eval((runtime) => runtime.layout.name);
await preview.eval((runtime, arg) => runtime.callFunction(arg.fn), { fn: "Reset" });
await preview.eval("return runtime.objects.Player.getFirstInstance().x");   // a function body

// Wait until something is true on the runtime.
await preview.waitFor((runtime) => runtime.layout.name === "Level 2", { timeoutMs: 5000 });

// The preview page's DOM.
await preview.evalDom(() => document.title);

// Input, like a real user. Click the canvas first if the game needs focus.
await preview.mouse.click(400, 300);
await preview.keyboard.down("ArrowRight");
await preview.keyboard.up("ArrowRight");

await preview.screenshot({ path: "shot.png" });

preview.on("pageError", (e) => console.error(e));     // also "log" and "consoleError"
preview.runtimeIn;                                     // "page" or "worker"

await preview.close();
```

- Functions passed to `eval` and `waitFor` are sent to the browser as text, so they can't use
  variables from your code. Pass data as JSON: the second argument of `eval`, or
  `{ arg }` in `waitFor`'s options.
- `runtime.mouse.getMouseX()` returns layout coordinates, not canvas pixels.
  `runtime.mouse` and `runtime.keyboard` throw if the project has no Mouse or Keyboard
  object.
- `project.runPreview({ seconds, layout })` is the one-shot version the CLI uses. It
  returns the errors and the start layout.

## Escape hatches

`project.page` is the editor's Playwright `Page`, and `preview.window` is the preview's.
Use them for anything the API doesn't cover.

## Other exports

- `REPORT_VERSION`
- `resolveRelease({ branch | release })`: the exact release a branch points to now
- `daemonStatus()`, `isDaemonRunning()`, `DEFAULT_SOCKET`
- The types: `OpenReport`, `OpenOptions`, `LaunchOptions`, `SaveReport`,
  `ExportReport`, `ExportOptions`, `PreviewResult`, `Branch`, `Release`
