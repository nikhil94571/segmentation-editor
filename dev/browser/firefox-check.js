/* Drives headless Firefox over WebDriver BiDi: loads the editor, lets the tour start, saves a screenshot, then draws a
   loop and splits it through the page's own events, and prints any console errors.
     /Applications/Firefox.app/Contents/MacOS/firefox --headless --profile <empty folder> --remote-debugging-port 9335 about:blank &
     node dev/browser/firefox-check.js "http://127.0.0.1:8768/editor?lib=practice&i=0" firefox.png
   The drawn loop and the cut are at fixed image positions on the BCSS practice-01. */
const fs = require("fs"); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const ws = new WebSocket("ws://127.0.0.1:9335/session");
  let id = 0; const pending = new Map(); const logs = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } if (d.method === "log.entryAdded" && d.params.level === "error") logs.push(d.params.text); };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params) => new Promise((ok) => { pending.set(++id, ok); ws.send(JSON.stringify({ id, method, params })); });
  await send("session.new", { capabilities: {} });
  await send("session.subscribe", { events: ["log.entryAdded"] });
  const tree = await send("browsingContext.getTree", {}); const ctx = tree.result.contexts[0].context;
  await send("browsingContext.setViewport", { context: ctx, viewport: { width: 1400, height: 900 } });
  const ev = async (e) => { const r = await send("script.evaluate", { expression: e, target: { context: ctx }, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : JSON.stringify(r).slice(0, 300); };
  await send("browsingContext.navigate", { context: ctx, url: process.argv[2], wait: "complete" });
  await sleep(6000);
  console.log("tour:", await ev("String(window.Tour && Tour.active)"));
  await sleep(9000);
  const shot = await send("browsingContext.captureScreenshot", { context: ctx }); fs.writeFileSync(process.argv[3], Buffer.from(shot.result.data, "base64"));
  await ev("Tour.end()"); await sleep(1500);
  console.log("state:", await ev(`JSON.stringify({ image: __editor.S.meta && __editor.S.meta.name, regions: __editor.S.regions.length, um: __editor.S.lib && __editor.S.lib.pixel_um })`));
  console.log("edit:", await ev(`(async () => { const E = __editor, S = E.S, cv = document.getElementById("cv");
    const scr = (p) => { const b = cv.getBoundingClientRect(); return { x: b.left + S.view.x + p.x * S.view.s, y: b.top + S.view.y + p.y * S.view.s }; };
    const evp = (t, p) => cv.dispatchEvent(new PointerEvent(t, { clientX: scr(p).x, clientY: scr(p).y, button: 0, pointerId: 1, bubbles: true }));
    E.setTool("draw"); const n0 = S.regions.length, pts = []; for (let i = 0; i <= 48; i++) { const t = i / 48 * 6.283; pts.push({ x: 1120 + 90 * Math.cos(t), y: 420 + 70 * Math.sin(t) }); }
    evp("pointerdown", pts[0]); pts.slice(1).forEach((p) => evp("pointermove", p)); evp("pointerup", pts[pts.length - 1]);
    const n1 = S.regions.length, line = []; for (let x = 990; x <= 1250; x += 8) line.push({ x, y: 420 });
    evp("pointerdown", line[0]); line.slice(1).forEach((p) => evp("pointermove", p)); evp("pointerup", line[line.length - 1]);
    return JSON.stringify({ drawn: n1 - n0, after_split: S.regions.length - n1 }); })()`));
  console.log("console errors:", logs.length ? logs.join(" | ") : "none");
  await send("session.end", {}); ws.close();
})();
