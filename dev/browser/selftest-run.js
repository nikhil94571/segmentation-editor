const fs = require("fs"); const [url, shot] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const targets = await (await fetch("http://127.0.0.1:9334/json")).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  let id = 0; const pending = new Map(), logs = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || d); pending.delete(d.id); }
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") logs.push(d.params.args.map((a) => a.value || a.description).join(" "));
    if (d.method === "Runtime.exceptionThrown") logs.push("EXC " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text)); };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params) => new Promise((ok) => { pending.set(++id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.value;
  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 860, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  let res = null;
  for (let i = 0; i < 240 && !res; i++) { await sleep(500); res = await ev("document.getElementById('selftest') && document.getElementById('selftest').textContent"); }
  console.log(res || "NO RESULT"); console.log("console:", logs.length ? logs.join(" | ") : "clean");
  if (shot) { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(shot, Buffer.from(r.data, "base64")); }
  ws.close();
})();
