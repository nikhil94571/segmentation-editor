const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const targets = await (await fetch("http://127.0.0.1:9334/json")).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || d); pending.delete(d.id); } };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params) => new Promise((ok) => { pending.set(++id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const r = await send("Runtime.evaluate", { expression: process.argv[2], awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result?.value ?? r, null, 0).slice(0, 2500)); ws.close();
})();
