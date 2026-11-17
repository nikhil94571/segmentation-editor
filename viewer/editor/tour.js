/* Guided tour: a pointer drawn on the page works the real editor on practice-01 while a spotlight and a caption
   card explain each step. Nothing the tour does is saved: it runs on a copy of the model's regions and puts back
   whatever was there before. window.Tour.start() resolves false if it cannot run (then the Tutorial panel is used). */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const CANCEL = { cancelled: true };
  const jerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t);    // how a hand moves from one point to another
  const lerp = (a, b, t) => a + (b - a) * t;
  const GLAND = [[1300, 990], [1322, 952], [1385, 936], [1447, 950], [1478, 990], [1523, 1003], [1550, 1040], [1552, 1100], [1528, 1150], [1478, 1168], [1428, 1135], [1392, 1155], [1340, 1140], [1322, 1085], [1298, 1045]];

  let root, card, cur, badge, dimPath, ringPath, cv;
  let active = false, run = 0, idx = 0, hosted = false;
  let pos = { x: 420, y: 420 }, down = false, holes = [], base = null, before = null, cameFrom = null, resizeTimer = null;
  const Ed = () => window.__editor, S = () => window.__editor.S;

  /* ---------------- page furniture ---------------- */
  function mount() {
    if (root) return;
    cv = $("cv");
    root = document.createElement("div"); root.id = "tour";
    root.innerHTML = `<div class="tour-block"></div>
      <svg class="tour-dim"><path class="d" fill-rule="evenodd"/><path class="r"/></svg>
      <div class="tour-badge"></div>
      <div class="tour-cur"><svg class="a" width="30" height="40" viewBox="0 0 24 32"><path d="M2 2v21.5l5.4-5 3.7 8.7 3.4-1.5-3.7-8.5h7.4z" fill="#15151c" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>
        <svg class="x" width="34" height="34" viewBox="0 0 26 26"><path d="M13 2v9M13 15v9M2 13h9M15 13h9" stroke="#fff" stroke-width="4.2" stroke-linecap="round"/><path d="M13 2v9M13 15v9M2 13h9M15 13h9" stroke="#15151c" stroke-width="1.8" stroke-linecap="round"/></svg></div>
      <div class="tour-card" role="dialog" aria-label="Tour of the editor">
        <div class="tour-top"><span class="tour-n"></span><span class="tour-dots"></span><button class="link tour-skip" type="button">Skip the tour</button></div>
        <h4></h4><p class="tour-text"></p>
        <div class="tour-btns"><button class="btn tour-back" type="button">Back</button><span class="spacer"></span><button class="btn primary tour-next" type="button">Next</button></div>
      </div>`;
    document.body.appendChild(root);
    card = root.querySelector(".tour-card"); cur = root.querySelector(".tour-cur"); badge = root.querySelector(".tour-badge");
    dimPath = root.querySelector(".tour-dim .d"); ringPath = root.querySelector(".tour-dim .r");
    root.querySelector(".tour-skip").onclick = () => end();
    root.querySelector(".tour-next").onclick = () => go(idx + 1);
    root.querySelector(".tour-back").onclick = () => go(idx - 1);
    const block = root.querySelector(".tour-block");            // the visitor's own mouse does nothing to the editor during the tour
    ["pointerdown", "pointerup", "click", "dblclick", "contextmenu"].forEach((t) => block.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); }));
    block.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });
    window.addEventListener("keydown", (e) => {                 // and their keys only steer the tour
      if (!active || !e.isTrusted) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.stopImmediatePropagation();
      if (e.key === "Escape") { e.preventDefault(); end(); }
      else if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") { e.preventDefault(); go(idx + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(idx - 1); }
    }, true);
    window.addEventListener("resize", () => { if (!active) return; clearTimeout(resizeTimer); resizeTimer = setTimeout(() => active && go(idx), 250); });
  }

  /* ---------------- timing: every wait can be cut short by Next, Back or Skip ---------------- */
  const frame = (t) => new Promise((ok, bad) => requestAnimationFrame((now) => (t === run ? ok(now) : bad(CANCEL))));
  const wait = (t, ms) => new Promise((ok, bad) => setTimeout(() => (t === run ? ok() : bad(CANCEL)), ms));
  async function tween(t, ms, fn) { const t0 = performance.now(); for (;;) { const u = Math.min(1, (await frame(t) - t0) / ms); fn(u); if (u >= 1) return; } }

  /* ---------------- spotlight ---------------- */
  const rr = (h) => { const r = Math.min(h.r == null ? 14 : h.r, h.w / 2, h.h / 2); return h.w < 1 || h.h < 1 ? "" : `M${h.x + r} ${h.y}h${h.w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h.h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(h.w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h.h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`; };
  function paint(list) {
    const cut = list.map(rr).join("");
    dimPath.setAttribute("d", `M0 0H${window.innerWidth}V${window.innerHeight}H0Z${cut}`); ringPath.setAttribute("d", cut);
  }
  const box = (el, pad) => { if (typeof el === "string") el = document.querySelector(el); const b = el.getBoundingClientRect(), p = pad == null ? 6 : pad; return { x: b.left - p, y: b.top - p, w: b.width + 2 * p, h: b.height + 2 * p }; };
  const union = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };
  async function spot(t, list, ms) {
    const from = list.map((h, i) => holes[i] || { x: h.x + h.w / 2, y: h.y + h.h / 2, w: 0, h: 0 });
    await tween(t, ms == null ? 420 : ms, (u) => { const e = jerk(u); paint(list.map((h, i) => ({ x: lerp(from[i].x, h.x, e), y: lerp(from[i].y, h.y, e), w: lerp(from[i].w, h.w, e), h: lerp(from[i].h, h.h, e), r: h.r }))); });
    holes = list;
  }

  /* ---------------- the pointer ---------------- */
  const inCanvas = (p) => { const b = cv.getBoundingClientRect(); return p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom; };
  function showCur() {
    cur.style.transform = `translate(${pos.x}px,${pos.y}px)`; cur.classList.toggle("down", down);
    cur.classList.toggle("cross", (S().tool === "draw" || S().tool === "ruler") && inCanvas(pos) && !document.querySelector(".backdrop.show"));
  }
  const fire = (type, buttons) => cv.dispatchEvent(new PointerEvent(type, { clientX: pos.x, clientY: pos.y, button: 0, buttons, pointerId: 1, pointerType: "mouse", bubbles: true, cancelable: true }));
  function put(x, y) { pos = { x, y }; if (down || inCanvas(pos)) fire("pointermove", down ? 1 : 0); showCur(); }
  function ring() { const r = document.createElement("div"); r.className = "tour-ring"; r.style.left = pos.x + "px"; r.style.top = pos.y + "px"; root.appendChild(r); setTimeout(() => r.remove(), 700); }
  async function move(t, p, dur) {
    const a = pos, d = Math.hypot(p.x - a.x, p.y - a.y); if (d < 0.5) return;
    const bow = 0.07 * d * (p.x > a.x ? 1 : -1), mx = (a.x + p.x) / 2 - (p.y - a.y) / d * bow, my = (a.y + p.y) / 2 + (p.x - a.x) / d * bow;
    await tween(t, (dur || Math.min(1.15, Math.max(0.36, 0.28 + d / 850))) * 1000, (u) => { const e = jerk(u), v = 1 - e; put(v * v * a.x + 2 * v * e * mx + e * e * p.x, v * v * a.y + 2 * v * e * my + e * e * p.y); });
  }
  const press = () => { down = true; fire("pointerdown", 1); ring(); showCur(); };
  const release = () => { fire("pointerup", 0); down = false; showCur(); };
  async function click(t, p, after) { await move(t, p); await wait(t, 140); press(); await wait(t, 110); release(); await wait(t, after == null ? 500 : after); }
  /* A real control (button, list row): the pointer goes there and the control is clicked. */
  async function clickEl(t, sel, after) {
    const el = typeof sel === "string" ? document.querySelector(sel) : sel; if (!el) return;
    const b = el.getBoundingClientRect(); await move(t, { x: b.left + b.width / 2, y: b.top + b.height / 2 }); await wait(t, 140);
    down = true; ring(); showCur(); await wait(t, 110); down = false; showCur(); el.click(); await wait(t, after == null ? 500 : after);
  }
  async function drag(t, a, b, dur, after) {
    await move(t, a); await wait(t, 170); press(); await wait(t, 130);
    const s = pos; await tween(t, (dur || 1.1) * 1000, (u) => { const e = jerk(u); put(lerp(s.x, b.x, e), lerp(s.y, b.y, e)); });
    await wait(t, 200); release(); await wait(t, after == null ? 450 : after);
  }
  /* Follow a line of screen points at a steady speed (px per second), eased at both ends. */
  async function trace(t, pts, speed) {
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const L = cum[cum.length - 1], ramp = 0.14, area = 1 - ramp;
    const prof = (u) => (u < ramp ? u * (u / ramp) / 2 / area : u > 1 - ramp ? 1 - (1 - u) * ((1 - u) / ramp) / 2 / area : (ramp / 2 + (u - ramp)) / area);
    let j = 0, last = 0;
    await tween(t, L / (speed || 240) * 1000, (u) => {
      const target = prof(u) * L;
      for (let s = last + 2.5; s < target + 2.5; s += 2.5) {     // small steps, so the drawn line is smooth whatever the frame rate
        const at = Math.min(s, target); while (j < cum.length - 2 && cum[j + 1] < at) j++;
        const f = cum[j + 1] > cum[j] ? (at - cum[j]) / (cum[j + 1] - cum[j]) : 0;
        put(lerp(pts[j].x, pts[j + 1].x, f), lerp(pts[j].y, pts[j + 1].y, f));
      }
      last = target;
    });
  }
  async function stroke(t, pts, speed, after) { await move(t, pts[0]); await wait(t, 220); press(); await wait(t, 110); await trace(t, pts, speed); await wait(t, 130); release(); await wait(t, after == null ? 600 : after); }
  /* A hand-drawn line through way-points: a smooth spline with a little wobble. */
  function hand(way, closed, amp) {
    const n = way.length, out = [], per = 14, P = (i) => (closed ? way[((i % n) + n) % n] : way[Math.min(n - 1, Math.max(0, i))]);
    for (let i = 0; i < (closed ? n : n - 1); i++) for (let k = 0; k < per; k++) {
      const u = k / per, a = P(i - 1), b = P(i), c = P(i + 1), d = P(i + 2), u2 = u * u, u3 = u2 * u;
      out.push({ x: 0.5 * (2 * b.x + (-a.x + c.x) * u + (2 * a.x - 5 * b.x + 4 * c.x - d.x) * u2 + (-a.x + 3 * b.x - 3 * c.x + d.x) * u3),
        y: 0.5 * (2 * b.y + (-a.y + c.y) * u + (2 * a.y - 5 * b.y + 4 * c.y - d.y) * u2 + (-a.y + 3 * b.y - 3 * c.y + d.y) * u3) });
    }
    out.push(Object.assign({}, closed ? out[0] : way[n - 1]));
    let s = 0;
    return out.map((p, i) => {
      if (i) s += Math.hypot(p.x - out[i - 1].x, p.y - out[i - 1].y);
      const a = out[Math.max(0, i - 1)], b = out[Math.min(out.length - 1, i + 1)], l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const w = (amp == null ? 0.8 : amp) * Math.min(1, i / 6, (out.length - 1 - i) / 6) * (Math.sin(s / 23 + 1.7) + 0.6 * Math.sin(s / 9.5 + 3.9));
      return { x: p.x - (b.y - a.y) / l * w, y: p.y + (b.x - a.x) / l * w };
    });
  }
  function say(html, ms) { badge.innerHTML = html; const b = area(); badge.style.left = b.x + b.w / 2 + "px"; badge.style.top = b.y + 6 + "px"; badge.classList.add("show"); clearTimeout(say.t); say.t = setTimeout(() => badge.classList.remove("show"), ms || 2600); }
  async function key(t, label, k, after) { say(`<b>${label}</b>`, 1500); await wait(t, 380); window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); await wait(t, after == null ? 700 : after); }

  /* ---------------- the image ---------------- */
  /* Where the action is shown: the image area, less the part the caption card covers. */
  function area() {
    const b = $("stage").getBoundingClientRect(), c = card.getBoundingClientRect();
    const docked = card.dataset.at === "dock", bottom = docked ? Math.min(b.bottom, c.top) : b.bottom;
    return { x: b.left + 26, y: b.top + 26, w: b.width - 52, h: bottom - b.top - 46 };
  }
  const at = (ix, iy) => { const b = cv.getBoundingClientRect(), v = S().view; return { x: b.left + v.x + ix * v.s, y: b.top + v.y + iy * v.s }; };
  const ats = (pts) => pts.map(([x, y]) => at(x, y));
  const reg = (name) => S().regions.find((r) => r.name === name);
  // each step starts from the model's own regions; the class picked in "Say what a region is" is put back on region-04
  // in the steps after it, so the Measure panel can show a split by class
  let chosenCls = null;
  const keepClass = () => { const r = reg("region-04"), c = chosenCls || (S().classes[0] || {}).id; if (r && c) r.cls = c; };
  const onLine = (name, x, y) => { const n = G.nearest(reg(name).paths[0], { x, y }); return at(n.point.x, n.point.y); };
  const nodeAt = (name, x, y) => { let best = null; for (const n of reg(name).paths[0].nodes) { const d = Math.hypot(n.x - x, n.y - y); if (!best || d < best.d) best = { n, d }; } return at(best.n.x, best.n.y); };
  function viewOf(x0, y0, x1, y1) {
    const a = area(), b = cv.getBoundingClientRect(), s = Math.min(a.w / (x1 - x0), a.h / (y1 - y0));
    return { s, x: a.x + a.w / 2 - b.left - (x0 + x1) / 2 * s, y: a.y + a.h / 2 - b.top - (y0 + y1) / 2 * s };
  }
  async function viewTo(t, v1, ms) {
    const v0 = Object.assign({}, S().view), a = area(), b = cv.getBoundingClientRect(), px = a.x + a.w / 2 - b.left, py = a.y + a.h / 2 - b.top;
    const c0 = { x: (px - v0.x) / v0.s, y: (py - v0.y) / v0.s }, c1 = { x: (px - v1.x) / v1.s, y: (py - v1.y) / v1.s };
    if (Math.abs(v0.s - v1.s) < 1e-4 && Math.hypot(v0.x - v1.x, v0.y - v1.y) < 1) return;
    await tween(t, ms || 800, (u) => {
      const e = jerk(u), s = v0.s * Math.pow(v1.s / v0.s, e), cx = lerp(c0.x, c1.x, e), cy = lerp(c0.y, c1.y, e);
      S().view = { s, x: px - cx * s, y: py - cy * s }; S().fitted = false; Ed().draw(); showCur();
    });
  }
  const look = (t, x0, y0, x1, y1, ms) => viewTo(t, viewOf(x0, y0, x1, y1), ms);
  const whole = (t, ms) => look(t, 0, 0, S().img.width, S().img.height, ms);
  /* Something the editor does in one jump (a list row zooming to its region) is shown as a glide. */
  async function glide(t, fn, ms) { const v0 = Object.assign({}, S().view); fn(); const v1 = Object.assign({}, S().view); S().view = v0; Ed().draw(); await viewTo(t, v1, ms || 700); }

  /* ---------------- the steps ---------------- */
  const stage = () => box("#stage", 0), K = (s) => `<kbd>${s}</kbd>`;
  const WORK = [1400, 480, 1830, 770];                         // the view steps 3 to 7 share: region-04, close up
  const row = (name) => document.querySelector(`#queue .q-item[data-id="${reg(name).id}"]`);
  const inside = (name) => { const q = Ed().labelPoint(reg(name)); return at(q.x, q.y); };
  const STEPS = [
    { title: "A short tour",
      text: () => `Welcome! Watch this short tour to learn how to correct a segmented image. Click <b>Next</b>.`,
      async play(t) {
        await Promise.all([spot(t, [stage()]), whole(t)]);
        await move(t, at(1640, 600), 1.0); await wait(t, 700); await move(t, at(1420, 800), 0.9); await wait(t, 500); await move(t, at(330, 1100), 1.1);
      } },
    { title: "Six practice images", at: "#caseNav",
      text: () => `Six practice images are loaded. The arrows step through them, and <b>Open</b> on the right lists them all and takes your own images.`,
      async play(t) {
        await Promise.all([spot(t, [union(box("#caseNav"), box("#sessionName")), box("#open")]), whole(t)]);
        const b = $("nextCase").getBoundingClientRect(); await move(t, { x: b.left + b.width / 2, y: b.top + b.height / 2 + 2 }); await wait(t, 900);
        const o = $("open").getBoundingClientRect(); await move(t, { x: o.left + o.width / 2, y: o.top + o.height / 2 + 2 }, 1.2);
      } },
    { title: "Select a region",
      text: () => `Click a region on the image, or its name in the list. Orange nodes appear on its outline: that is the region you are working on. The list starts with the regions the model was least sure about.`,
      async play(t) {
        await Promise.all([spot(t, [union(stage(), box(".side", 0))]), whole(t)]);
        const el = row("region-04");
        if (el) {
          const b = el.getBoundingClientRect(); await move(t, { x: b.left + b.width / 2, y: b.top + b.height / 2 }); await wait(t, 150);
          down = true; ring(); showCur(); await wait(t, 110); down = false;
          const v0 = Object.assign({}, S().view); el.click(); S().view = v0; Ed().draw();     // the list zooms to the region: shown as a glide
        } else await click(t, at(1620, 600), 300);
        await look(t, ...WORK, 900);
        await move(t, at(1700, 760), 0.9);
      } },
    { title: "Extend or trim a region",
      text: () => `Click the pencil, or press ${K("2")}. Start <b>on the outline</b> (an orange dot shows where), draw the new edge, and end back <b>on the same outline</b>. That stretch of the outline is replaced by your line.`,
      async play(t) {
        await Promise.all([spot(t, [union(stage(), box(".rail", 0))]), look(t, ...WORK)]);
        await clickEl(t, "#toolDraw", 500);
        say("Extend: draw the new edge outside the region", 3200);
        await stroke(t, hand([onLine("region-04", 1570, 640)].concat(ats([[1578, 690], [1612, 728], [1662, 738], [1698, 722]]), [onLine("region-04", 1712, 702)]), false, 0.6), 200, 1000);
        say("Trim: draw through the region; the smaller piece is cut off", 3400);
        await stroke(t, hand([onLine("region-04", 1562, 570)].concat(ats([[1566, 592], [1565, 616]]), [onLine("region-04", 1558, 639)]), false, 0.4), 150, 500);
        await move(t, { x: pos.x + 150, y: pos.y + 60 });
      } },
    { title: "Draw a region the model missed",
      text: () => `Still with the pencil: press, draw around the area, and finish where you started. The shape fills in when the loop closes.`,
      async play(t) {
        Ed().setTool("draw");
        await Promise.all([spot(t, [stage()]), look(t, 1180, 860, 1800, 1250)]);
        await stroke(t, hand(ats(GLAND), true), 250, 500);
        await move(t, { x: pos.x - 110, y: pos.y + 90 });
      } },
    { title: "Adjust the outline",
      text: () => `Click the arrow, or press ${K("1")}, and select a region. <b>Drag a node</b> to move that part of the outline, then <b>drag the line</b> between nodes to bend it into shape.`,
      async play(t) {
        Ed().setTool("draw");                                  // as the step before left it
        await Promise.all([spot(t, [union(stage(), box(".rail", 0))]), look(t, ...WORK)]);
        await clickEl(t, "#toolEdit", 500);
        await click(t, at(1640, 600), 700);
        say("Drag a node"); await drag(t, nodeAt("region-04", 1659, 656), at(1668, 716), 1.2, 500);
        await drag(t, nodeAt("region-04", 1605, 651), at(1612, 700), 1.0, 700);
        say("Then drag the line between them to bend it");
        const s = S().view.s, a = onLine("region-04", 1640, 709); await drag(t, a, { x: a.x + 1 * s, y: a.y + 15 * s }, 1.1, 500);
        const b = onLine("region-04", 1594, 668); await drag(t, b, { x: b.x - 24 * s, y: b.y + 12 * s }, 1.0, 300);
        await move(t, { x: pos.x - 70, y: pos.y + 80 });
      } },
    { title: "Say what a region is",
      text: () => `Click the tag, or press ${K("3")}, then click a region and pick its class from the menu, or press its number. A coloured dot marks the region.`,
      async play(t) {
        await Promise.all([spot(t, [union(stage(), box(".rail", 0))]), look(t, ...WORK)]);
        await clickEl(t, "#toolLabel", 500);
        await click(t, inside("region-04"), 700);
        const pick = document.querySelector("#labelPop [data-cls]"); if (pick) chosenCls = pick.dataset.cls;
        await clickEl(t, "#labelPop [data-cls]", 700);
        await move(t, { x: pos.x + 130, y: pos.y + 120 });
      } },
    { title: "Measure",
      text: () => `Click the ruler, or press ${K("4")}. <b>Drag</b> for a straight distance. <b>Click a region</b> for its longest diameter, then <b>another region</b> for the gap between them. <b>Click two points</b> on an outline for the length along it.`,
      async play(t) {
        keepClass(); Ed().refresh();
        await Promise.all([spot(t, [union(stage(), box(".rail", 0))]), look(t, 1290, 470, 1920, 990)]);
        await clickEl(t, "#toolRuler", 400);
        // between gestures the last measurement is simply cleared (no trip away to click empty tissue): the time goes
        // to each result, not to resetting
        const clear = async (ms) => { const s = S(); s.ruler = null; s.selected = null; Ed().refresh(); await wait(t, ms || 120); };
        // a drag across region-04, each end starting just inside it so it can be seen to snap onto the outline
        const r4 = G.bbox(reg("region-04").paths), cy = (r4.y0 + r4.y1) / 2;
        const ea = onLine("region-04", r4.x0, cy), eb = onLine("region-04", r4.x1, cy);
        const ins = (p, q, px) => { const d = Math.hypot(q.x - p.x, q.y - p.y) || 1; return { x: p.x + (q.x - p.x) * px / d, y: p.y + (q.y - p.y) * px / d }; };
        say("Drag: a straight distance, its ends snap to the outline", 2400);
        await drag(t, ins(ea, eb, 7), ins(eb, ea, 7), 1.0, 1300);
        await clear();
        say("Click a region: its longest diameter", 2200);
        await click(t, inside("region-04"), 1900);
        await clear(450);
        say("A region, then another: the gap between them", 2900);
        await click(t, inside("region-04"), 250);
        await click(t, inside("region-02"), 2000);
        await clear();
        say("Two points on an outline: the length along it, both ways round", 3400);
        await click(t, onLine("region-04", 1656, 552), 250);
        await click(t, onLine("region-04", 1720, 714), 2400);
      } },
    { title: "The Measure panel",
      text: () => `With a region selected, the top of the <b>Measure</b> panel gives that region's own numbers: area, perimeter, longest diameter and circularity. Below, a table splits everything by class: each class's area, and its share of the regions and of the whole image.`,
      async play(t) {
        keepClass();
        const s = S(), r = reg("region-04"); s.selected = r.id;
        $("measure").classList.remove("shut"); Ed().refresh();
        $("measure").scrollIntoView({ block: "nearest" }); await wait(t, 60);
        const sel = document.querySelector("#measBody > div"), table = document.querySelector("#measBody .meas-t");
        // the light covers the Measure section edge to edge, heading included: first down to the region's numbers,
        // then it grows down over the class table, so the whole section is lit at the end
        const ms = box("#measure", 0), cut = sel.getBoundingClientRect().bottom + 10;
        await spot(t, [{ x: ms.x, y: ms.y, w: ms.w, h: cut - ms.y }]);
        say("The selected region: its own measurements", 2600);
        const a = sel.getBoundingClientRect();
        await move(t, { x: a.left + a.width * 0.3, y: a.top + a.height * 0.55 }, 0.9); await wait(t, 600);
        await move(t, { x: a.left + a.width * 0.75, y: a.top + a.height * 0.8 }, 0.8); await wait(t, 900);
        await spot(t, [box("#measure", 0)], 520);
        say("Every class: its area, share of the regions, share of the image", 3000);
        const b = table.getBoundingClientRect();
        await move(t, { x: b.left + b.width * 0.25, y: b.top + b.height * 0.4 }, 0.9); await wait(t, 700);
        await move(t, { x: b.left + b.width * 0.85, y: b.top + b.height * 0.55 }, 0.9); await wait(t, 1200);
      } },
    { title: "Save your corrections", at: "left",
      text: () => hosted
        ? `Your work is kept as you go. To take it away, click <b>Export</b>, choose this image or all of them, and tick the file types you want: ImageJ, QuPath or plain masks. They download as one .zip.`
        : `Your work is saved as you go. To get the files, click <b>Export</b>, choose this image or the whole library, the folder to save in, and the file types you want: ImageJ, QuPath or plain masks.`,
      async play(t) {
        await Promise.all([spot(t, [box("#export")]), whole(t)]);
        $("exportModal").classList.add("no-rise");                 // in the tour the dialog appears in place, so the
        await clickEl(t, "#export", 0);                            // spotlight can go straight to where it will be
        for (let i = 0; i < 40 && !($("exportModal").classList.contains("show") && $("exGo")); i++) await wait(t, 30);
        await spot(t, [Object.assign(box("#exportModal .modal", 0), { r: 22 }), box("#export")], 260);
        $("exportModal").classList.remove("no-rise");
        for (const v of ["mask_png", "roiset_zip"]) {            // tick two more file types
          const inp = document.querySelector(`input[name=exFmt][value=${v}]`); if (!inp || inp.checked) continue;
          const b = (inp.closest("label") || inp).getBoundingClientRect(); await move(t, { x: b.left + 16, y: b.top + b.height / 2 }); await wait(t, 160);
          down = true; ring(); showCur(); await wait(t, 110); down = false; showCur(); inp.click(); await wait(t, 550);
        }
        const g = $("exGo").getBoundingClientRect(); await move(t, { x: g.left + g.width / 2, y: g.top + g.height / 2 + 2 });
      } },
    { title: "The rest is in the Tutorial", at: "#tutBtn", last: true,
      text: () => `That is enough to correct an image. The <b>Tutorial</b> button has a short clip for every tool, including splitting, merging, holes and opening your own images. You can replay this tour from there too.`,
      async play(t) {
        await Promise.all([spot(t, [box("#tutBtn")]), whole(t)]);
        const b = $("tutBtn").getBoundingClientRect(); await move(t, { x: b.left + b.width / 2, y: b.top + b.height / 2 + 3 });
      } },
  ];

  /* ---------------- running ---------------- */
  function placeCard(where) {
    const W = window.innerWidth, H = window.innerHeight, st = $("stage").getBoundingClientRect();
    card.style.width = ""; card.dataset.at = "dock";
    const side = Math.min(320, (W - 520) / 2 - 28);              // beside a dialog in the middle of the window, if there is room
    if (where === "left" && side >= 240) { card.dataset.at = "left"; card.style.width = side + "px"; card.style.left = "16px"; card.style.top = Math.max(70, (H - card.offsetHeight) / 2) + "px"; return; }
    if (where && where !== "left") {
      const b = document.querySelector(where).getBoundingClientRect(), w = Math.min(420, W - 32);
      card.dataset.at = "near"; card.style.width = w + "px";
      card.style.left = Math.max(16, Math.min(W - w - 16, b.left + b.width / 2 - w / 2)) + "px"; card.style.top = b.bottom + 18 + "px"; return;
    }
    const w = Math.min(600, st.width - 32); card.style.width = w + "px";
    card.style.left = st.left + (st.width - w) / 2 + "px"; card.style.top = st.bottom - card.offsetHeight - 14 + "px";
  }
  function reset() {                                            // every step starts from the model's own regions
    const s = S(); down = false;
    document.querySelectorAll(".backdrop.show").forEach((m) => m.classList.remove("show"));
    badge.classList.remove("show");
    Object.assign(s, { regions: JSON.parse(base), counter: 0, selected: null, hole: null, draft: null, stroke: null, drag: null, hover: null, ruler: null, ruling: false, pickOp: null, undo: [], redo: [] });
    Ed().setTool("edit"); Ed().refresh();
  }
  async function go(i) {
    if (!active) return;
    if (i >= STEPS.length) return end();
    idx = Math.max(0, i); const t = ++run, st = STEPS[idx];
    reset();
    card.querySelector(".tour-n").textContent = `${idx + 1} of ${STEPS.length}`;
    card.querySelector(".tour-dots").innerHTML = STEPS.map((_, k) => `<i class="${k === idx ? "on" : k < idx ? "seen" : ""}"></i>`).join("");
    card.querySelector("h4").textContent = st.title; card.querySelector(".tour-text").innerHTML = st.text();
    card.querySelector(".tour-back").hidden = idx === 0;
    card.querySelector(".tour-next").textContent = st.last ? "Start practising" : "Next";
    placeCard(st.at); showCur();
    try { await st.play(t); } catch (e) { if (e !== CANCEL) { console.error(e); if (t === run) end(); } }
  }
  async function end() {
    if (!active) return;
    active = false; run++;
    const s = S(); reset();
    root.classList.remove("on"); s.demo = false;
    try {
      if (cameFrom) await Ed().useLibrary(cameFrom.lib, cameFrom.index);       // back to the image that was open
      else if (before) {
        Object.assign(s, { regions: JSON.parse(before.regions), counter: before.counter, undo: before.undo, redo: before.redo, selected: before.selected });
        Ed().setTool(before.tool);
        if (before.fitted) Ed().fitView(); else { s.view = before.view; s.fitted = false; }
        Ed().refresh();
      }
    } catch (e) {}
    cameFrom = before = base = null; holes = [];
  }
  async function start() {
    if (active) return true;
    if (!window.__editor || window.innerWidth < 900 || window.innerHeight < 560) return false;
    mount();
    const s = S(); hosted = document.documentElement.classList.contains("hosted");
    try {
      await Ed().saveNow();
      cameFrom = null;
      if (!(s.lib && s.lib.id === "practice" && s.caseIndex === 0)) {
        const was = s.lib ? { lib: s.lib.id, index: s.caseIndex } : null;
        await Ed().useLibrary("practice", 0); cameFrom = was;
      }
      if (!s.img || !s.meta || s.meta.name !== "practice-01") throw new Error("no practice image");
      const model = Ed().modelRegions();
      if (!["region-03", "region-04"].every((n) => model.some((r) => r.name === n))) throw new Error("not the expected image");
      base = JSON.stringify(model);
    } catch (e) {
      if (cameFrom) Ed().useLibrary(cameFrom.lib, cameFrom.index).catch(() => {});
      cameFrom = null; return false;
    }
    const strip = (r) => { const o = Object.assign({}, r); delete o._p; return o; };
    before = cameFrom ? null : { regions: JSON.stringify(s.regions.map(strip)), counter: s.counter, undo: s.undo, redo: s.redo, selected: s.selected, tool: s.tool, view: Object.assign({}, s.view), fitted: s.fitted };
    document.querySelectorAll(".backdrop.show").forEach((m) => m.classList.remove("show"));
    document.querySelectorAll(".side .sec.shut").forEach((x) => x.classList.remove("shut"));   // the tour points at all three sections
    s.demo = true; active = true; holes = [];
    const b = $("stage").getBoundingClientRect(); pos = { x: b.left + b.width * 0.3, y: b.top + b.height * 0.55 };
    paint([]); root.classList.add("on");
    go(0);
    return true;
  }

  window.Tour = { start, end, get active() { return active; } };
})();
