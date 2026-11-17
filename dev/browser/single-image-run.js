// Open one image's folder through the real Open dialog ("Single image"), as a person would, and save screenshots
// of what the editor picked and of the opened image.
//   node dev/browser/single-image-run.js <editor url> <folder> <out prefix>
const fs = require("fs"), path = require("path");
const [url, folder, out] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const targets = await (await fetch("http://127.0.0.1:9334/json")).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  let id = 0; const pending = new Map(), logs = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || d); pending.delete(d.id); }
    if (d.method === "Runtime.exceptionThrown") logs.push("EXC " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") logs.push(d.params.args.map((a) => a.value || a.description).join(" ")); };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params) => new Promise((ok) => { pending.set(++id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.value;
  const shot = async (f) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(f, Buffer.from(r.data, "base64")); };
  await send("Runtime.enable"); await send("Page.enable"); await send("DOM.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url }); await sleep(1500);
  await ev("localStorage.setItem('seg-editor-welcomed','1')");
  await send("Page.navigate", { url }); await sleep(3500);
  await ev(`document.getElementById("open").click()`); await sleep(800);
  await ev(`document.querySelector('#openTabs [data-tab="import"]').click()`); await sleep(300);
  const doc = await send("DOM.getDocument", {});
  const node = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#f_one_files" });
  const files = fs.readdirSync(folder).filter((f) => !f.startsWith(".")).map((f) => path.resolve(folder, f));
  await send("DOM.setFileInputFiles", { files, nodeId: node.nodeId });
  let shown = false;
  for (let i = 0; i < 240 && !shown; i++) { await sleep(500); shown = await ev(`!document.getElementById("onePick").hidden`); }
  const picked = await ev(`document.getElementById("onePick").innerText`);
  console.log("PICKED:\n" + picked);
  await shot(out + "-picked.png");
  await ev(`document.getElementById("pkOpen").click()`);
  let opened = false;
  for (let i = 0; i < 120 && !opened; i++) { await sleep(500); opened = await ev(`!document.getElementById("openModal").classList.contains("show") && !!window.__E && true || !document.getElementById("openModal").classList.contains("show")`); }
  await sleep(1500);
  console.log("OPENED:", await ev(`document.getElementById("sessionName").textContent + " | toast: " + (document.querySelector(".toast") ? document.querySelector(".toast").textContent : "")`));
  await shot(out + "-opened.png");
  await ev(`document.getElementById("export").click()`); await sleep(1200);
  console.log("EXPORT TICKED:", await ev(`[...document.querySelectorAll("input[name=exFmt]:checked")].map((x) => x.value).join(",")`));
  console.log("console:", logs.length ? logs.join(" | ") : "clean");
  ws.close();
})();
