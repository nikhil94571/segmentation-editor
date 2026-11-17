// Upload a library (.zip) through the real Open dialog, screenshot the review panel, change one image's outline
// file, accept, and print what happened.
//   node dev/browser/library-run.js <editor url> <library.zip> <out prefix>
const fs = require("fs"), path = require("path");
const [url, zip, out] = process.argv.slice(2);
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
  const doc = await send("DOM.getDocument", {});
  const node = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#f_lib_zip" });
  await send("DOM.setFileInputFiles", { files: [path.resolve(zip)], nodeId: node.nodeId });
  await sleep(300); await shot(out + "-uploading.png");
  let shown = false;
  for (let i = 0; i < 240 && !shown; i++) { await sleep(500); shown = await ev(`!document.getElementById("libReview").hidden`); }
  await sleep(500);
  console.log("REVIEW:\n" + await ev(`document.getElementById("libReview").innerText`));
  await shot(out + "-review.png");
  const changed = await ev(`(async () => { const s = document.querySelector("#revList select[id^=rvOut]"); if (!s) return "no select";
    const want = [...s.options].find((o) => /_mask\\.tif$/.test(o.value)); s.value = want.value; s.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 2500)); return document.querySelector("#revList .rev-item").innerText; })()`);
  console.log("AFTER CHANGING THE FIRST IMAGE'S OUTLINES:\n" + changed);
  await ev(`document.querySelector("#libReview [data-accept]").click()`);
  await sleep(120); console.log("ACCEPT BUTTON WHILE OPENING:", await ev(`(() => { const b = document.querySelector("#libReview [data-accept]"); return b.textContent + (b.disabled ? " (disabled)" : "") + " | review shown: " + !document.getElementById("libReview").hidden; })()`));
  await shot(out + "-accepting.png");
  for (let i = 0; i < 120; i++) { await sleep(500); if (await ev(`!document.getElementById("openModal").classList.contains("show")`)) break; }
  await sleep(1500);
  console.log("OPENED:", await ev(`document.getElementById("sessionName").textContent + " · " + document.getElementById("casePos").textContent`));
  await shot(out + "-opened.png");
  // browse another library without choosing it, then open one of its images with a double-click
  await ev(`document.getElementById("open").click()`); await sleep(900);
  await ev(`[...document.querySelectorAll("#libList .li")].find((r) => r.textContent.includes("Practice")).click()`); await sleep(900);
  console.log("PRACTICE EXPANDED WITHOUT WORKING ON IT:", await ev(`document.querySelectorAll("#libList .cases [data-lid=practice]").length + " images shown; still working on " + document.querySelector(".li.current .q-name").textContent`));
  await ev(`document.querySelectorAll("#libList .cases [data-lid=practice]")[2].click()`); await sleep(1200);
  await shot(out + "-browse.png");
  await ev(`document.querySelectorAll("#libList .cases [data-lid=practice]")[2].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
  for (let i = 0; i < 60; i++) { await sleep(500); if (await ev(`!document.getElementById("openModal").classList.contains("show")`)) break; }
  await sleep(800);
  console.log("AFTER DOUBLE-CLICK:", await ev(`window.__editor.S.lib.id + " · " + document.getElementById("casePos").textContent + " · " + document.getElementById("sessionName").textContent`));
  console.log("console:", logs.length ? logs.join(" | ") : "clean");
  ws.close();
})();
