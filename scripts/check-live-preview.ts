// Manual integration check (needs the daemon: `c3cli daemon start --tabs 3`).
// Exercise the live preview API through the daemon.
const { C3Editor } = await import("../src/api.ts");
for (const f of ["fixtures/c3p/3d-lighting.c3p", "fixtures/c3p/battleship.c3p"]) {
  const editor = await C3Editor.connect();
  const project = await editor.open(f);
  const pv = await project.preview();
  let events = 0;
  pv.on("log", () => events++);
  const out: Record<string, unknown> = { runtimeIn: pv.runtimeIn, layout: await pv.eval((rt) => rt.layout.name) };
  // Keyboard: focus the canvas, hold a key, wait until the runtime sees it.
  const box = await pv.window.locator("canvas").first().boundingBox();
  await pv.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await pv.keyboard.down("ArrowRight");
  out.keySeen = await pv.waitFor((rt) => rt.keyboard?.isKeyDown("ArrowRight"), { timeoutMs: 5000 }).catch((e) => `no: ${e.message}`);
  await pv.keyboard.up("ArrowRight");
  out.keyReleased = await pv.waitFor((rt) => !rt.keyboard?.isKeyDown("ArrowRight"), { timeoutMs: 5000 }).catch((e) => `no: ${e.message}`);
  // Mouse: move, then read the runtime's view of it (if the project has the Mouse object).
  const readMouse = () => pv.eval((rt) => { try { return [Math.round(rt.mouse.getMouseX()), Math.round(rt.mouse.getMouseY())]; } catch { return "no Mouse object"; } });
  await pv.mouse.move(box!.x + 100, box!.y + 80, { steps: 5 });
  await pv.window.waitForTimeout(300);
  out.mouseAfterMove = await readMouse();
  await pv.mouse.move(box!.x + 700, box!.y + 400, { steps: 5 });
  await pv.window.waitForTimeout(300);
  out.mouseAfterMove2 = await readMouse();
  out.canvasBox = [Math.round(box!.x), Math.round(box!.y), Math.round(box!.width), Math.round(box!.height)];
  // DOM side, even when the runtime is in a worker.
  out.dom = await pv.evalDom(() => ({ title: document.title, canvas: [document.querySelector("canvas")?.width, document.querySelector("canvas")?.height] }));
  // Pass data in, and a string body.
  out.withArg = await pv.eval((rt, arg) => `${arg.greeting} from ${rt.layout.name}`, { greeting: "hi" });
  out.stringBody = await pv.eval("return runtime.getAllLayouts().length");
  out.screenshotBytes = (await pv.screenshot()).length;
  out.logEvents = events;
  console.log(f, JSON.stringify(out, null, 1));
  await project.close();
  await editor.close();
}
