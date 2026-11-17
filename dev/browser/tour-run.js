const fs = require("fs"); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const out = process.argv[3];
  const targets = await (await fetch("http://127.0.0.1:9334/json")).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  let id = 0; const pending = new Map(), logs = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || d); pending.delete(d.id); }
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") logs.push(d.params.args.map((a) => a.value || a.description).join(" "));
    if (d.method === "Runtime.exceptionThrown") logs.push("EXC " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text)); };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params) => new Promise((ok) => { pending.set(++id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.value;
  const shot = async (n) => { const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 72 }); fs.writeFileSync(`${out}/${n}.jpg`, Buffer.from(r.data, "base64")); };
  await send("Runtime.enable"); await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: process.argv[2] }); await sleep(3000);
  const before = await ev("__editor.S.regions.length");
  await ev("document.getElementById('tutBtn').click()"); await sleep(500); await ev("document.getElementById('tourBtn').click()"); await sleep(1500);
  const waits = [4200, 4200, 4500, 12500, 9000, 13500, 6500, 22000, 10500, 7500, 2500];
  for (let i = 0; i < waits.length; i++) { await sleep(waits[i]); await shot("s" + (i + 1));
    console.log(i + 1, await ev("document.querySelector('.tour-card h4').textContent"), "| regions", await ev("__editor.S.regions.map(r=>r.name+(r.cls?':'+r.cls:'')+(r.edited?'*':'')).join(' ')"), "| ruler", await ev("__editor.S.ruler&&__editor.S.ruler.kind"), "| sel", await ev("__editor.S.selected"), "| fmts", await ev("[...document.querySelectorAll('input[name=exFmt]:checked')].map(x=>x.value).join(',')"));
    await ev("document.querySelector('.tour-next').click()"); }
  await sleep(900);
  console.log("after: active", await ev("window.Tour.active"), "regions", before, "->", await ev("__editor.S.regions.length"), "tool", await ev("__editor.S.tool"), "saved:", await ev("document.getElementById('saved').textContent"));
  console.log("console:", logs.length ? logs.join(" | ") : "clean"); ws.close();
})();
