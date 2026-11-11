/* Recorder for the tutorial clips: drives the real editor in headless Chrome (DevTools protocol) with real mouse
   and key events, draws a pointer on the page, and saves one screenshot per video frame.
   Needs: the editor server on :8765 and Chrome started with --headless=new --remote-debugging-port=9333. */
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, ".."), TMP = path.join(ROOT, "scratch", "tut");
const OUT = path.join(ROOT, "viewer", "editor", "tutorial");
const BASE = "http://127.0.0.1:8765", PORT = 9333, W = 1280, H = 760, FPS = 30, SCALE = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t);          // minimum-jerk easing: how a hand moves point to point
const lerp = (a, b, t) => a + (b - a) * t;

const PAGE_SETUP = (lib) => `(() => {
  try { localStorage.setItem("seg-editor-theme", "light"); localStorage.removeItem("seg-editor-formats"); } catch (e) {}
  const f = window.fetch, json = (o) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
  window.fetch = async (u, o) => {
    if (typeof u === "string" && u.startsWith("/api/editor/save")) return json({ ok: true });      // recordings never save edits
    if (u === "/api/editor/library/export" || u === "/api/editor/export") {                         // exports go to scratch, shown as Downloads
      const b = JSON.parse(o.body); b.dest = ${JSON.stringify(path.join(ROOT, "scratch", "tut-export"))};
      const j = await (await f(u, Object.assign({}, o, { body: JSON.stringify(b) }))).json(); if (j.dir) j.dir = "~/Downloads/" + j.dir.split("/").pop(); return json(j);
    }
    const r = await f(u, o);
    if (u === "/api/editor/settings") { const j = await r.json(); j.export_dir = j.home + "/Downloads"; return json(j); }
    if (u === "/api/editor/libraries") { const j = await r.json(); j.libraries = j.libraries.filter((l) => l.id === ${JSON.stringify(lib)}); return json(j); }
    return r;
  };
})();`;

const OVERLAY = `(() => {
  if (window.__cur) return;
  const st = document.createElement("style");
  st.textContent = "@keyframes __ring { from { transform: translate(-50%,-50%) scale(.35); opacity: .55 } to { transform: translate(-50%,-50%) scale(1.5); opacity: 0 } }" +
    "#__c { position: fixed; left: 0; top: 0; z-index: 99999; pointer-events: none; will-change: transform; }" +
    "#__c svg { position: absolute; filter: drop-shadow(0 1.5px 2px rgba(0,0,0,.35)); transition: transform .08s; transform-origin: 2px 2px; }" +
    "#__c.down svg { transform: scale(.86); }" +
    ".__ring { position: fixed; z-index: 99998; pointer-events: none; width: 44px; height: 44px; border-radius: 50%; border: 2.5px solid rgba(79,91,213,.9); background: rgba(79,91,213,.16); animation: __ring .5s ease-out forwards; }" +
    "#__k { position: fixed; z-index: 99997; pointer-events: none; display: flex; gap: 8px; align-items: center; padding: 9px 14px 10px; border-radius: 16px; background: rgba(20,22,46,.82); color: #fff;" +
    "  font: 500 15px -apple-system, 'SF Pro Text', Inter, sans-serif; box-shadow: 0 10px 30px -10px rgba(20,22,46,.6); opacity: 0; transform: translate(-50%, 6px); transition: opacity .18s, transform .18s; }" +
    "#__k.show { opacity: 1; transform: translate(-50%, 0); }" +
    "#__k b { display: inline-block; min-width: 30px; text-align: center; padding: 3px 9px; border-radius: 8px; background: #fff; color: #14162E; font: 600 15px 'SF Mono', ui-monospace, monospace; box-shadow: 0 2px 0 rgba(255,255,255,.45); }";
  document.head.appendChild(st);
  const c = document.createElement("div"); c.id = "__c";
  c.innerHTML = '<svg id="__a" width="30" height="40" viewBox="0 0 24 32" style="left:-2.5px;top:-2.5px"><path d="M2 2v21.5l5.4-5 3.7 8.7 3.4-1.5-3.7-8.5h7.4z" fill="#15151c" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>' +
    '<svg id="__x" width="34" height="34" viewBox="0 0 26 26" style="left:-17px;top:-17px;display:none;transform-origin:17px 17px"><path d="M13 2v9M13 15v9M2 13h9M15 13h9" stroke="#fff" stroke-width="4.2" stroke-linecap="round"/><path d="M13 2v9M13 15v9M2 13h9M15 13h9" stroke="#15151c" stroke-width="2.1" stroke-linecap="round"/></svg>';
  document.body.appendChild(c);
  const k = document.createElement("div"); k.id = "__k"; document.body.appendChild(k);
  let kt = null;
  window.__cur = (x, y, down, ring) => {
    c.style.transform = "translate(" + x + "px," + y + "px)"; c.classList.toggle("down", !!down);
    const el = document.elementFromPoint(x, y), cross = el && getComputedStyle(el).cursor === "crosshair";
    document.getElementById("__a").style.display = cross ? "none" : ""; document.getElementById("__x").style.display = cross ? "" : "none";
    if (ring) { const r = document.createElement("div"); r.className = "__ring"; r.style.left = x + "px"; r.style.top = y + "px"; document.body.appendChild(r); setTimeout(() => r.remove(), 700); }
  };
  window.__key = (html, x, y, ms) => { k.innerHTML = html; k.style.left = x + "px"; k.style.top = y + "px"; k.classList.add("show"); clearTimeout(kt); kt = setTimeout(() => k.classList.remove("show"), ms || 1300); };
  window.__nocur = (hide) => { c.style.display = hide ? "none" : ""; };
})();`;

const KEYS = {
  Enter: { code: "Enter", vk: 13, text: "\r" }, Escape: { code: "Escape", vk: 27 }, Backspace: { code: "Backspace", vk: 8 }, Delete: { code: "Delete", vk: 46 },
  ArrowDown: { code: "ArrowDown", vk: 40 }, ArrowUp: { code: "ArrowUp", vk: 38 }, "[": { code: "BracketLeft", vk: 219, text: "[" }, "]": { code: "BracketRight", vk: 221, text: "]" },
};

async function connect(lib) {
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch (e) { await sleep(200); } }
  if (!targets) throw new Error("Chrome is not listening on " + PORT);
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  let id = 0; const pending = new Map(), logs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.error ? { __err: d.error } : d.result); pending.delete(d.id); }
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") logs.push(d.params.args.map((a) => a.value || a.description).join(" "));
    if (d.method === "Runtime.exceptionThrown") logs.push("EXCEPTION: " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params) => new Promise((ok, bad) => { pending.set(++id, (r) => (r && r.__err ? bad(new Error(method + ": " + r.__err.message)) : ok(r))); ws.send(JSON.stringify({ id, method, params })); });
  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_SETUP(lib) });

  const R = { send, logs, lib, pos: { x: 640, y: 380 }, down: false, clip: { x: 0, y: 0, w: W, h: H }, n: 0, dir: null, on: false, mods: 0 };
  R.ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; };
  R.waitFor = async (e, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await R.ev(e)) return; await sleep(120); } throw new Error("timed out waiting for " + e); };

  /* Load one image of the library, fresh (nothing is ever saved). */
  R.load = async (index, opts = {}) => {
    await send("Page.navigate", { url: opts.blank ? `${BASE}/editor?lib=none` : `${BASE}/editor?lib=${lib}&i=${index}` });
    await R.waitFor("document.readyState==='complete' && !!window.__editor");
    if (!opts.blank) { await R.ev("window.__ready"); await R.waitFor("!!window.__editor.S.img"); }
    await R.ev("document.fonts.ready.then(() => true)");
    await R.ev(OVERLAY); await sleep(250);
    R.down = false; await R.cursor();
  };
  R.cursor = (ring) => R.ev(`__cur(${R.pos.x.toFixed(1)},${R.pos.y.toFixed(1)},${R.down},${!!ring})`);
  /* image coordinates -> screen */
  R.at = async (ix, iy) => { const v = await R.ev("(()=>{const b=document.getElementById('cv').getBoundingClientRect(),v=__editor.S.view;return [b.left+v.x,b.top+v.y,v.s]})()"); return { x: v[0] + ix * v[2], y: v[1] + iy * v[2] }; };
  R.ats = async (ptsImg) => { const v = await R.ev("(()=>{const b=document.getElementById('cv').getBoundingClientRect(),v=__editor.S.view;return [b.left+v.x,b.top+v.y,v.s]})()"); return ptsImg.map(([x, y]) => ({ x: v[0] + x * v[2], y: v[1] + y * v[2] })); };
  R.el = async (sel) => { const b = await R.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const b=e.getBoundingClientRect();return [b.left,b.top,b.width,b.height]})()`); if (!b) throw new Error("no element " + sel); return { x: b[0] + b[2] / 2, y: b[1] + b[3] / 2, l: b[0], t: b[1], w: b[2], h: b[3] }; };

  /* ---- frames ---- */
  R.begin = (name, clip) => {
    R.name = name; R.clip = clip || { x: 0, y: 0, w: W, h: H }; R.n = 0; R.on = true;
    R.dir = path.join(TMP, name); fs.rmSync(R.dir, { recursive: true, force: true }); fs.mkdirSync(R.dir, { recursive: true });
  };
  R.frame = async () => {
    if (!R.on) return;
    const c = R.clip, r = await send("Page.captureScreenshot", { format: "jpeg", quality: 93, clip: { x: c.x, y: c.y, width: c.w, height: c.h, scale: 1 }, optimizeForSpeed: true });
    fs.writeFileSync(path.join(R.dir, "f" + String(R.n++).padStart(5, "0") + ".jpg"), Buffer.from(r.data, "base64"));
  };
  R.hold = async (sec) => { const n = Math.max(1, Math.round(sec * FPS)); for (let i = 0; i < n; i++) { if (R.on) await sleep(18); await R.frame(); } };
  R.end = async (poster) => {
    R.on = false; fs.mkdirSync(OUT, { recursive: true });
    const out = path.join(OUT, R.name + ".mp4"), ow = 1440, oh = Math.round(ow * R.clip.h / R.clip.w / 2) * 2;
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(R.dir, "f%05d.jpg"), "-vf", `scale=${ow}:${oh}:flags=lanczos`,
      "-c:v", "libx264", "-preset", "slow", "-crf", "25", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", out]);
    const pf = path.join(R.dir, "f" + String(Math.min(R.n - 1, Math.max(0, Math.round((poster == null ? 0.999 : poster) * (R.n - 1))))).padStart(5, "0") + ".jpg");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", pf, "-vf", `scale=${ow}:${oh}:flags=lanczos`, "-q:v", "4", path.join(OUT, R.name + ".jpg")]);
    console.log(`${R.name}: ${R.n} frames, ${(R.n / FPS).toFixed(1)} s, ${(fs.statSync(out).size / 1024).toFixed(0)} KB` + (logs.length ? "  CONSOLE: " + logs.splice(0).join(" | ") : ""));
  };

  /* ---- mouse ---- */
  const raw = (type, extra) => send("Input.dispatchMouseEvent", Object.assign({ type, x: R.pos.x, y: R.pos.y, button: R.down ? "left" : "none", buttons: R.down ? 1 : 0, modifiers: R.mods, pointerType: "mouse" }, extra || {}));
  R.put = async (x, y) => { R.pos = { x, y }; await raw("mouseMoved"); };
  /* Glide to a point along a slightly bowed path. */
  R.move = async (p, opt = {}) => {
    const a = R.pos, d = Math.hypot(p.x - a.x, p.y - a.y); if (d < 0.5) return;
    const dur = opt.dur || Math.min(1.15, Math.max(0.32, 0.26 + d / 850)), n = Math.max(2, Math.round(dur * FPS));
    const bow = (opt.bow == null ? 0.07 : opt.bow) * d * (p.x > a.x ? 1 : -1), mx = (a.x + p.x) / 2 - (p.y - a.y) / d * bow, my = (a.y + p.y) / 2 + (p.x - a.x) / d * bow;
    for (let i = 1; i <= n; i++) {
      const t = jerk(i / n), u = 1 - t;
      await R.put(u * u * a.x + 2 * u * t * mx + t * t * p.x, u * u * a.y + 2 * u * t * my + t * t * p.y); await R.cursor(); await R.frame();
    }
  };
  R.press = async (count = 1) => { R.down = true; await raw("mousePressed", { button: "left", buttons: 1, clickCount: count }); await R.cursor(true); await R.frame(); };
  R.release = async (count = 1) => { await raw("mouseReleased", { button: "left", buttons: 0, clickCount: count }); R.down = false; await R.cursor(); await R.frame(); };
  R.click = async (p, opt = {}) => { if (p) await R.move(p, opt); await R.hold(opt.before == null ? 0.12 : opt.before); await R.press(); await R.hold(0.1); await R.release(); await R.hold(opt.after == null ? 0.3 : opt.after); };
  R.dbl = async (p, opt = {}) => { if (p) await R.move(p, opt); await R.hold(0.15); await R.press(1); await R.hold(0.07); await R.release(1); await R.hold(0.1); await R.press(2); await R.hold(0.07); await R.release(2); await R.hold(opt.after == null ? 0.4 : opt.after); };
  /* Follow a path of screen points with the button held (or not): speed in px/s, eased at both ends. */
  R.trace = async (ptsScr, opt = {}) => {
    const speed = opt.speed || 260, sub = opt.sub || 3, cum = [0];
    for (let i = 1; i < ptsScr.length; i++) cum.push(cum[i - 1] + Math.hypot(ptsScr[i].x - ptsScr[i - 1].x, ptsScr[i].y - ptsScr[i - 1].y));
    const L = cum[cum.length - 1], n = Math.max(4, Math.round(L / speed * FPS)) * sub, ramp = opt.ramp == null ? 0.14 : opt.ramp;
    const prof = (t) => { const v = (x) => Math.min(1, x / ramp, (1 - x) / ramp), area = 1 - ramp; return t < ramp ? t * v(t) / 2 / area : t > 1 - ramp ? 1 - (1 - t) * v(t) / 2 / area : (ramp / 2 + (t - ramp)) / area; };
    let j = 0;
    for (let i = 1; i <= n; i++) {
      const s = prof(i / n) * L; while (j < cum.length - 2 && cum[j + 1] < s) j++;
      const f = cum[j + 1] > cum[j] ? (s - cum[j]) / (cum[j + 1] - cum[j]) : 0;
      await R.put(lerp(ptsScr[j].x, ptsScr[j + 1].x, f), lerp(ptsScr[j].y, ptsScr[j + 1].y, f));
      if (i % sub === 0) { if (opt.wait) await sleep(opt.wait); await R.cursor(); await R.frame(); }
    }
  };
  R.drag = async (a, b, opt = {}) => {                           // press at a, glide to b, release
    if (a) await R.move(a); await R.hold(0.15); await R.press(); await R.hold(0.12);
    const d = Math.hypot(b.x - R.pos.x, b.y - R.pos.y), n = Math.max(6, Math.round((opt.dur || Math.min(1.4, 0.5 + d / 260)) * FPS)), s = R.pos;
    for (let i = 1; i <= n; i++) { const t = jerk(i / n); await R.put(lerp(s.x, b.x, t), lerp(s.y, b.y, t)); if (opt.wait) await sleep(opt.wait); await R.cursor(); await R.frame(); }
    await R.hold(opt.settle == null ? 0.2 : opt.settle); await R.release(); await R.hold(opt.after == null ? 0.4 : opt.after);
  };
  R.wheel = async (dx, dy, mods = 0) => { await raw("mouseWheel", { deltaX: dx, deltaY: dy, modifiers: mods }); await R.frame(); };

  /* ---- keys ---- */
  R.key = async (k, opt = {}) => {
    const d = KEYS[k] || { code: "Key" + k.toUpperCase(), vk: k.toUpperCase().charCodeAt(0), text: k }, mods = opt.mods || 0;
    if (opt.badge !== false) {
      const c = R.clip, label = opt.label || `<b>${opt.cap || (k.length === 1 ? k.toUpperCase() : k)}</b>`;
      await R.ev(`__key(${JSON.stringify(label)}, ${opt.bx || c.x + c.w / 2}, ${opt.by || c.y + c.h - 62}, ${opt.ms || 1500})`); await R.hold(0.3);
    }
    const base = { key: k, code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk, modifiers: mods };
    await send("Input.dispatchKeyEvent", Object.assign({ type: d.text && !mods ? "keyDown" : "rawKeyDown", text: mods ? undefined : d.text }, base));
    await send("Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, base));
    await R.hold(opt.after == null ? 0.5 : opt.after);
  };
  R.close = () => ws.close();
  return R;
}

/* A hand-drawn line through way-points: smooth spline plus a little wobble. Points are {x,y} in screen px. */
function hand(way, opt = {}) {
  const closed = !!opt.closed, n = way.length, out = [], per = opt.per || 14, amp = opt.wobble == null ? 0.9 : opt.wobble;
  const P = (i) => (closed ? way[((i % n) + n) % n] : way[Math.min(n - 1, Math.max(0, i))]);
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) for (let k = 0; k < per; k++) {
    const t = k / per, p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2), t2 = t * t, t3 = t2 * t;
    out.push({ x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3) });
  }
  out.push(closed ? Object.assign({}, out[0]) : Object.assign({}, way[n - 1]));
  let s = 0; const ph = opt.seed || 1.7;
  return out.map((p, i) => {
    if (i) s += Math.hypot(p.x - out[i - 1].x, p.y - out[i - 1].y);
    const a = out[Math.max(0, i - 1)], b = out[Math.min(out.length - 1, i + 1)], l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const edge = Math.min(1, i / 6, (out.length - 1 - i) / 6), w = amp * edge * (Math.sin(s / 23 + ph) + 0.6 * Math.sin(s / 9.5 + 2.3 * ph));
    return { x: p.x - (b.y - a.y) / l * w, y: p.y + (b.x - a.x) / l * w };
  });
}

module.exports = { connect, hand, sleep, W, H, FPS, ROOT, OUT, TMP };
