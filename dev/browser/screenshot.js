const fs = require("fs"); const [url, out, expr, clip] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const targets = await (await fetch("http://127.0.0.1:9334/json")).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || d); pending.delete(d.id); } };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params) => new Promise((ok) => { pending.set(++id, ok); ws.send(JSON.stringify({ id, method, params })); });
  await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url }); await sleep(2500); await send("Page.navigate", { url }); await sleep(3500);
  const r0 = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r0.exceptionDetails) console.log("EXC", JSON.stringify(r0.exceptionDetails).slice(0, 400));
  await sleep(700);
  const p = { format: "png" }; if (clip) { const [x, y, w, h] = clip.split(",").map(Number); p.clip = { x, y, width: w, height: h, scale: 1 }; }
  const r = await send("Page.captureScreenshot", p); fs.writeFileSync(out, Buffer.from(r.data, "base64")); ws.close();
})();
