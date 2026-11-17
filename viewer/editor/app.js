/* Segmentation editor: canvas app. Geometry lives in geom.js (window.G). */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const cv = $("cv"), ctx = cv.getContext("2d"), stage = $("stage");
  ["wheel", "pointerdown"].forEach((ev) => stage.addEventListener(ev, () => stopViewAnim(), { capture: true, passive: true }));
  const HIT = 9;            // screen px: how close counts as "on" a node or a line
  const CLOSE = 14;         // screen px: finishing this near the start closes a shape
  const FIT_TOL = 3;        // image px: how closely fitted curves follow the model's outline
  const BLUE = [10, 80, 235];
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const MOD = MAC ? "⌘" : "Ctrl";                           // the key that goes with Z and with scroll-to-zoom
  window.MODKEY = MOD;

  const S = {
    sid: null, meta: null, img: null, heat: null,
    regions: [], selected: null, tool: "edit", draft: null, stroke: null, drag: null,
    view: { s: 1, x: 0, y: 0 }, undo: [], redo: [], counter: 0,
    opacity: 0.4, showModel: false, showHeat: false, space: false, hover: null,
    lib: null, caseIndex: -1, hole: null, pick: null,
    classes: [], labelFor: null, peek: false, ruler: null, ruling: false, pickOp: null,
  };
  /* Classes: what a region is. Kept per library; a region stores the class id in r.cls. */
  const PALETTE = [[214, 69, 65], [38, 150, 100], [205, 140, 20], [20, 150, 170], [95, 100, 120], [140, 80, 200], [220, 90, 160], [150, 100, 60], [90, 120, 40]];
  const DEFAULT_CLASSES = [
    { id: "tumour", name: "Tumour", color: PALETTE[0] }, { id: "stroma", name: "Stroma", color: PALETTE[1] },
    { id: "necrosis", name: "Necrosis", color: PALETTE[2] }, { id: "normal", name: "Normal", color: PALETTE[3] },
    { id: "exclude", name: "Exclude", color: PALETTE[4], exclude: true },
  ];
  const classOf = (r) => (r.cls && S.classes.find((c) => c.id === r.cls)) || null;

  /* ---------------- server ---------------- */
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? undefined
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ error: "Server error" }));
    if (!r.ok || j.error) throw new Error(j.error || "Request failed");
    return j;
  }
  const loadImage = (src) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("Could not load " + src)); i.src = src; });

  /* ---------------- session ---------------- */
  const pts = (ring) => ring.map(([x, y]) => ({ x, y }));
  const fitTol = () => (S.meta && S.meta.fit_tol) || FIT_TOL;   // tiled model output: a quarter of a tile
  const fitRings = (rings) => rings.map((r) => (S.meta && S.meta.fit === "smooth" ? G.fitSmoothClosed(pts(r), fitTol(), 2, { w: S.meta.width, h: S.meta.height }) : G.fitClosed(pts(r), fitTol())))
    .filter((p) => p.nodes.length >= 1 && p.segs.length >= 1);   // smooth: as few nodes as the tolerance allows

  async function openSession(sid) {
    const { meta, state } = await api("/api/editor/session?id=" + encodeURIComponent(sid));
    const img = await loadImage("/api/editor/tissue.jpg?id=" + encodeURIComponent(sid));
    Object.assign(S, { sid, meta, img, heat: null, selected: null, draft: null, stroke: null, drag: null, undo: [], redo: [] });
    if (meta.has_prob) {                                        // the heatmap starts hidden: it loads after the image is shown
      loadImage("/api/editor/score.png?id=" + encodeURIComponent(sid)).then((score) => { if (S.sid === sid) { S.heat = heatLayer(score); if (S.showHeat) draw(); } }).catch(() => {});
    }
    if (state && state.regions) { S.regions = state.regions; S.counter = state.counter || 0; }
    else {
      S.counter = 0;
      S.regions = modelRegions();
    }
    $("sessionName").textContent = meta.name;
    $("empty").style.display = "none";
    $("export").disabled = false;
    $("heatRow").style.opacity = meta.has_prob ? 1 : 0.45;
    $("showHeat").disabled = !meta.has_prob;
    if (!meta.has_prob) { S.showHeat = false; $("showHeat").checked = false; }
    $("saved").textContent = state ? "Saved" : "";
    fitView(); refresh();
  }
  /* The regions exactly as the model gave them. */
  const modelRegions = () => S.meta.regions.map((r) => ({
    id: "m" + r.label, name: r.name, source: "model", label: r.label,
    t: S.meta.threshold, meanProb: r.mean_prob, edited: false, paths: fitRings(r.rings),
  })).filter((r) => r.paths.length);
  function heatLayer(scoreImg) {
    const c = document.createElement("canvas"); c.width = scoreImg.width; c.height = scoreImg.height;
    const x = c.getContext("2d"); x.drawImage(scoreImg, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height), a = d.data;
    for (let i = 0; i < a.length; i += 4) { const p = a[i]; a[i] = BLUE[0]; a[i + 1] = BLUE[1]; a[i + 2] = BLUE[2]; a[i + 3] = Math.round(p * 0.75); }
    x.putImageData(d, 0, 0);
    return c;
  }

  /* ---------------- undo + save ---------------- */
  const strip = (r) => { const o = Object.assign({}, r); delete o._p; delete o._m; delete o._c; return o; };
  const snapshot = () => JSON.stringify({ regions: S.regions.map(strip), draft: S.draft, selected: S.selected, counter: S.counter });
  function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > 120) S.undo.shift(); S.redo = []; }
  function restore(json) { closeLabel(); S.ruler = null; S.hole = null; const o = JSON.parse(json); S.regions = o.regions; S.draft = o.draft; S.selected = o.selected; S.counter = o.counter; S.stroke = null; S.drag = null; }
  function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); refresh(true); }
  function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); refresh(true); }
  let saveTimer = null, savePending = false;
  async function saveNow() {
    clearTimeout(saveTimer);
    if (!S.sid || !savePending) return;
    savePending = false;
    try { await api("/api/editor/save", { id: S.sid, state: { regions: S.regions.map(strip), counter: S.counter } }); $("saved").textContent = "Saved"; }
    catch (e) { $("saved").textContent = "Not saved"; }
  }
  function scheduleSave() {
    if (!S.sid || S.demo) return;                               // the tour works on a copy: nothing it does is saved
    savePending = true; $("saved").textContent = "Saving…";
    clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 700);
  }
  /* Call after any change to regions. */
  function refresh(dirty) {
    for (const r of S.regions) { r._p = null; r._m = null; r._c = null; }
    if (S.selected && !region(S.selected)) S.selected = null;
    renderBar();
    if (dirty) scheduleSave();
    renderPanel(); renderHint(); draw();
    $("undo").disabled = !S.undo.length; $("redo").disabled = !S.redo.length;
  }
  const region = (id) => S.regions.find((r) => r.id === id);

  /* ---------------- view ---------------- */
  const toImg = (e) => { const b = cv.getBoundingClientRect(); return { x: (e.clientX - b.left - S.view.x) / S.view.s, y: (e.clientY - b.top - S.view.y) / S.view.s }; };
  function resize() {
    const d = window.devicePixelRatio || 1, b = stage.getBoundingClientRect();
    cv.width = Math.round(b.width * d); cv.height = Math.round(b.height * d); if (S.fitted) fitView(); else draw();
  }
  function fitView() {
    if (!S.img) return;
    const b = stage.getBoundingClientRect(), s = Math.min((b.width - 40) / S.img.width, (b.height - 40) / S.img.height);
    S.view = { s, x: (b.width - S.img.width * s) / 2, y: (b.height - S.img.height * s) / 2 }; S.fitted = true; draw();
  }
  function zoomAt(f, cx, cy) {
    const b = stage.getBoundingClientRect(); if (cx === undefined) { cx = b.width / 2; cy = b.height / 2; }
    closeLabel();
    const s = Math.min(40, Math.max(0.05, S.view.s * f)), k = s / S.view.s;
    S.view = { s, x: cx - (cx - S.view.x) * k, y: cy - (cy - S.view.y) * k }; S.fitted = false; draw();
  }
  /* Going to a region: a quick eased zoom and pan, so the eye follows where it went. Scrolling or dragging
     stops it at once. */
  let viewAnim = 0;
  function focusRegion(r) {
    const bb = G.bbox(r.paths), b = stage.getBoundingClientRect(), w = Math.max(bb.x1 - bb.x0, 40), h = Math.max(bb.y1 - bb.y0, 40);
    const s1 = Math.min(6, Math.min(b.width / w, b.height / h) * 0.55), c1 = { x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2 };
    const v0 = S.view, s0 = v0.s, c0 = { x: (b.width / 2 - v0.x) / s0, y: (b.height / 2 - v0.y) / s0 };
    const at = (t) => { const s = s0 * Math.pow(s1 / s0, t), cx = c0.x + (c1.x - c0.x) * t, cy = c0.y + (c1.y - c0.y) * t; return { s, x: b.width / 2 - cx * s, y: b.height / 2 - cy * s }; };
    S.fitted = false;
    const id = ++viewAnim, ms = 320, t0 = performance.now();
    if (REDUCE || !S.img) { S.view = at(1); draw(); return; }
    const tick = (now) => {
      if (id !== viewAnim) return;
      const t = Math.min(1, (now - t0) / ms), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      S.view = at(e); draw();
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  const stopViewAnim = () => { viewAnim++; };

  /* ---------------- drawing ---------------- */
  function tracePath(p2, path) {
    if (!path.nodes.length) return;
    p2.moveTo(path.nodes[0].x, path.nodes[0].y);
    for (let i = 0; i < path.segs.length; i++) { const b = G.cubic(path, i); p2.bezierCurveTo(b[1].x, b[1].y, b[2].x, b[2].y, b[3].x, b[3].y); }
    if (path.closed) p2.closePath();
  }
  function regionPath(r) { if (!r._p) { r._p = new Path2D(); r.paths.forEach((p) => tracePath(r._p, p)); } return r._p; }
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function draw() {
    const d = window.devicePixelRatio || 1, v = S.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
    $("zoomLabel").textContent = S.img ? Math.round(v.s * 100) + "%" : "–";
    if (!S.img) return;
    ctx.setTransform(d * v.s, 0, 0, d * v.s, d * v.x, d * v.y);
    ctx.imageSmoothingEnabled = v.s < 3;
    ctx.drawImage(S.img, 0, 0);
    if (S.showHeat && S.heat) ctx.drawImage(S.heat, 0, 0);
    const px = 1 / v.s;

    for (const r of S.peek ? [] : S.regions) {              // holding X hides the regions to show the bare tissue
      const p = regionPath(r), sel = r.id === S.selected, c = classOf(r);
      ctx.fillStyle = `rgba(${BLUE},${S.showHeat ? S.opacity * 0.35 : S.opacity})`; ctx.fill(p, "evenodd");
      ctx.lineJoin = "round";
      ctx.setLineDash([]); ctx.lineWidth = (sel ? 4.5 : 3.2) * px; ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.stroke(p);
      if (c && c.exclude) ctx.setLineDash([7 * px, 5 * px]);   // left out of measurements: dashed outline
      ctx.lineWidth = (sel ? 2.4 : 1.6) * px; ctx.strokeStyle = "#12307F"; ctx.stroke(p);
      ctx.setLineDash([]);
    }
    for (const r of S.peek ? [] : S.regions) {              // class dot and "unsure" mark, drawn over every fill
      const c = classOf(r); if (!c && !r.unsure) continue;
      const q = labelPoint(r);
      if (c) {
        ctx.beginPath(); ctx.arc(q.x, q.y, 7.5 * px, 0, 7); ctx.fillStyle = `rgb(${c.color})`; ctx.fill();
        ctx.lineWidth = 2.2 * px; ctx.strokeStyle = "#fff"; ctx.stroke();
        ctx.beginPath(); ctx.arc(q.x, q.y, 8.8 * px, 0, 7); ctx.lineWidth = 0.8 * px; ctx.strokeStyle = "rgba(18,20,43,.55)"; ctx.stroke();
      }
      if (r.unsure) {
        const ux = c ? q.x + 19 * px : q.x;
        ctx.beginPath(); ctx.arc(ux, q.y, 8 * px, 0, 7); ctx.fillStyle = "#fff"; ctx.fill();
        ctx.lineWidth = 1.2 * px; ctx.strokeStyle = "#12142B"; ctx.stroke();
        ctx.fillStyle = "#12142B"; ctx.font = `600 ${11 * px}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("?", ux, q.y + 0.5 * px);
      }
    }
    if (S.showModel && S.meta) {
      ctx.setLineDash([5 * px, 4 * px]); ctx.lineWidth = 1.4 * px;
      for (const mr of S.meta.regions) for (const ring of mr.rings) {
        ctx.beginPath(); ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
        ctx.strokeStyle = "rgba(0,0,0,.8)"; ctx.lineDashOffset = 0; ctx.stroke();
        ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineDashOffset = 4.5 * px; ctx.stroke();
      }
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }
    const sel = region(S.selected);
    if (sel && selHole() != null) {                            // the selected hole stands out
      const hp = new Path2D(); tracePath(hp, sel.paths[selHole()]);
      ctx.lineWidth = 3 * px; ctx.strokeStyle = "#C2410C"; ctx.stroke(hp);
    }
    if (sel && S.tool === "edit" && !S.peek) for (const path of sel.paths) drawHandles(path, px);
    if (S.draft) drawDraft(px);
    if (S.stroke && S.stroke.pts.length > 1) {
      ctx.beginPath(); S.stroke.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.lineWidth = 3.4 * px; ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.stroke();
      ctx.lineWidth = 1.8 * px; ctx.strokeStyle = S.stroke.mode === "reroute" ? "#C2410C" : "#12307F"; ctx.stroke();
    }
    if (S.ruler) drawRuler(px);
    if (S.tool === "draw" && S.hover && !S.stroke) {      // where a reroute would start
      ctx.beginPath(); ctx.arc(S.hover.x, S.hover.y, 5 * px, 0, 7); ctx.fillStyle = "#C2410C"; ctx.fill();
      ctx.lineWidth = 1.5 * px; ctx.strokeStyle = "#fff"; ctx.stroke();
    }
  }
  /* ---------------- ruler ---------------- */
  const polyLen = (pts) => { let L = 0; for (let i = 1; i < pts.length; i++) L += G.dist(pts[i - 1], pts[i]); return L; };
  const thin = (pts, max) => { const k = Math.max(1, Math.ceil(pts.length / max)); return pts.filter((_, i) => i % k === 0); };
  /* A click with the ruler. On an outline: a pin; a second pin on the same outline measures the outline between
     them, both ways round. Inside a region: its longest diameter; then inside another region: the gap between them. */
  const pick = (r) => { S.selected = r ? r.id : null; S.hole = null; refresh(); };   // the Measure panel follows the ruler
  function rulerClick(p, prev) {
    const h = hitBorder(p), r = hitRegion(p, true);
    if (h && !(r && h.dist * S.view.s > 5)) {
      if (prev && prev.kind === "pin") {
        const hit = sharedPath(prev, p);                       // any outline that runs through both points
        if (hit) { S.ruler = arcBetween(hit.r.paths[hit.pi], hit.a, hit.b); pick(hit.r); return; }
        S.ruler = { kind: "line", a: prev.point, b: h.point }; pick(region(prev.rid)); return;
      }
      S.ruler = { kind: "pin", rid: h.r.id, pi: h.pi, seg: h.seg, t: h.t, point: h.point }; pick(h.r); return;
    }
    if (!r) { S.ruler = null; pick(null); return; }
    if (prev && prev.kind === "region" && prev.rid !== r.id && region(prev.rid)) { S.ruler = gapBetween(region(prev.rid), r); pick(null); }
    else { S.ruler = longestAcross(r); pick(r); }
  }
  /* Neighbouring pieces share parts of their outlines, so the two points may have been picked on different regions:
     look for one outline that passes through both, preferring the region of the first point. */
  function sharedPath(prev, q2) {
    let best = null;
    for (const r of S.regions) r.paths.forEach((path, pi) => {
      const a = G.nearest(path, prev.point), b = G.nearest(path, q2);
      if (!a || !b || a.dist > 0.6 || b.dist * S.view.s > HIT) return;
      const score = b.dist - (r.id === prev.rid ? 1e6 : 0);
      if (!best || score < best.score) best = { r, pi, score, a: { seg: a.seg, t: a.t, point: a.point }, b: { seg: b.seg, t: b.t, point: b.point } };
    });
    return best;
  }
  function arcBetween(path, a, b) {
    const fl = G.flatten(path, 1.5), u = (q) => q.seg + q.t, ua = u(a), ub = u(b);
    const fwd = (from, to) => (from < to ? fl.filter((q) => u(q) > from && u(q) < to) : fl.filter((q) => u(q) > from).concat(fl.filter((q) => u(q) < to)));
    const pts1 = [a.point].concat(fwd(ua, ub), [b.point]), pts2 = [b.point].concat(fwd(ub, ua), [a.point]);
    return { kind: "arc", a: a.point, b: b.point, pts1, pts2, len1: polyLen(pts1), len2: polyLen(pts2) };
  }
  function longestAcross(r) {
    const pts = thin([].concat(...r.paths.map((q) => G.flatten(q, 3))), 320); let best = { d: -1 };
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) { const d = G.dist(pts[i], pts[j]); if (d > best.d) best = { d, a: pts[i], b: pts[j] }; }
    return { kind: "region", rid: r.id, a: best.a, b: best.b };
  }
  function gapBetween(ra, rb) {
    const A = thin([].concat(...ra.paths.map((q) => G.flatten(q, 2))), 600), B = thin([].concat(...rb.paths.map((q) => G.flatten(q, 2))), 600);
    const over = A.find((q) => inside(rb, q)) || B.find((q) => inside(ra, q));
    let best = { d: Infinity };
    if (over) best = { d: 0, a: over, b: over };
    else for (const q of A) for (const w of B) { const d = G.dist(q, w); if (d < best.d) best = { d, a: q, b: w }; }
    return { kind: "gap", ra: ra.id, rb: rb.id, a: best.a, b: best.b };
  }
  function drawRuler(px) {
    const R = S.ruler, DARK = "#12142B", ORANGE = "#D9480F", TEAL = "#0B7285";
    const line = (pts, col, w, dash) => {
      ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.setLineDash([]); ctx.lineJoin = "round"; ctx.lineWidth = (w + 2) * px; ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.stroke();
      if (dash) ctx.setLineDash([6 * px, 4 * px]);
      ctx.lineWidth = w * px; ctx.strokeStyle = col; ctx.stroke(); ctx.setLineDash([]);
    };
    const dot = (q, col) => { ctx.beginPath(); ctx.arc(q.x, q.y, 4.5 * px, 0, 7); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1.6 * px; ctx.strokeStyle = "#fff"; ctx.stroke(); };
    const tag = (text, q, col) => {
      ctx.font = `600 ${12 * px}px sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      const w = ctx.measureText(text).width + 12 * px, x = q.x + 9 * px, y = q.y - 13 * px;
      ctx.fillStyle = col; ctx.beginPath(); ctx.rect(x, y - 10 * px, w, 20 * px); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.fillText(text, x + 6 * px, y + 0.5 * px);
    };
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const glow = (id) => { const r = region(id); if (!r) return; ctx.setLineDash([]); ctx.lineWidth = 3.2 * px; ctx.strokeStyle = DARK; ctx.stroke(regionPath(r)); };
    if (R.kind === "pin") dot(R.point, ORANGE);
    else if (R.kind === "arc") {
      line(R.pts1, ORANGE, 3); line(R.pts2, TEAL, 3); dot(R.a, DARK); dot(R.b, DARK);
      tag(fmtLen(R.len1), R.pts1[Math.floor(R.pts1.length / 2)], ORANGE); tag(fmtLen(R.len2), R.pts2[Math.floor(R.pts2.length / 2)], TEAL);
    } else if (R.kind === "region") { glow(R.rid); line([R.a, R.b], DARK, 1.8, true); dot(R.a, DARK); dot(R.b, DARK); tag("Longest " + fmtLen(G.dist(R.a, R.b)), mid(R.a, R.b), DARK); }
    else if (R.kind === "gap") { glow(R.ra); glow(R.rb); line([R.a, R.b], ORANGE, 2.2); dot(R.a, ORANGE); dot(R.b, ORANGE); tag("Gap " + fmtLen(G.dist(R.a, R.b)), mid(R.a, R.b), ORANGE); }
    else { line([R.a, R.b], DARK, 1.8); dot(R.a, DARK); dot(R.b, DARK); if (G.dist(R.a, R.b) * S.view.s > 3) tag(fmtLen(G.dist(R.a, R.b)), R.b, DARK); }
  }

  /* Where a region's class dot goes: a point inside it, as far from its outline as a coarse search finds. */
  function labelPoint(r) {
    if (r._c) return r._c;
    const fl = r.paths.map((p) => G.flatten(p, 6)), all = [].concat(...fl), stepN = Math.max(1, Math.ceil(all.length / 150)), N = 14;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, best = null;
    for (const q of all) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const q = { x: x0 + (i + 0.5) / N * (x1 - x0), y: y0 + (j + 0.5) / N * (y1 - y0) };
      let ins = false; for (const f of fl) if (f.length > 2 && G.inPoly(q, f)) ins = !ins;
      if (!ins) continue;
      let d = Infinity; for (let k = 0; k < all.length; k += stepN) d = Math.min(d, G.dist(q, all[k]));
      if (!best || d > best.d) best = { x: q.x, y: q.y, d };
    }
    return (r._c = best || { x: all[0].x, y: all[0].y });
  }
  function drawHandles(path, px) {                             // nodes only: the line itself is the bend handle
    for (const n of path.nodes) {
      ctx.beginPath(); ctx.arc(n.x, n.y, 5 * px, 0, 7); ctx.fillStyle = "#F0A63A"; ctx.fill();
      ctx.lineWidth = 1.4 * px; ctx.strokeStyle = "#6B3F06"; ctx.stroke();
    }
  }
  function drawDraft(px) {
    const d = S.draft, p = new Path2D(); tracePath(p, d);
    ctx.lineWidth = 3.4 * px; ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.stroke(p);
    ctx.lineWidth = 1.8 * px; ctx.strokeStyle = "#12307F"; ctx.stroke(p);
    d.nodes.forEach((n, i) => {
      const first = i === 0, last = i === d.nodes.length - 1;
      ctx.beginPath(); ctx.arc(n.x, n.y, (first || last ? 6 : 4) * px, 0, 7);
      ctx.fillStyle = last ? "#F0A63A" : "#fff"; ctx.fill();
      ctx.lineWidth = (first ? 2.4 : 1.4) * px; ctx.strokeStyle = first ? "#12307F" : "#6B3F06"; ctx.stroke();
    });
  }

  /* ---------------- hit testing ---------------- */
  function hitNode(r, p) {
    let best = null;
    r.paths.forEach((path, pi) => path.nodes.forEach((n, ni) => {
      const d = G.dist(n, p) * S.view.s; if (d <= HIT && (!best || d < best.d)) best = { pi, ni, d };
    }));
    return best;
  }
  function hitLine(r, p) {
    let best = null;
    r.paths.forEach((path, pi) => { const n = G.nearest(path, p); if (n && n.dist * S.view.s <= HIT && (!best || n.dist < best.dist)) best = Object.assign({ pi }, n); });
    return best;
  }
  function hitRegion(p, fillOnly) {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    let found = null;
    for (let i = S.regions.length - 1; i >= 0 && !found; i--) if (ctx.isPointInPath(regionPath(S.regions[i]), p.x, p.y, "evenodd")) found = S.regions[i];
    ctx.restore();
    if (!found && !fillOnly) for (const r of S.regions) if (hitLine(r, p)) { found = r; break; }
    return found;
  }
  function inside(r, p) {                                    // is the point in the shaded part of region r?
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    const hit = ctx.isPointInPath(regionPath(r), p.x, p.y, "evenodd");
    ctx.restore(); return hit;
  }
  const selHole = () => (S.hole && S.hole.rid === S.selected && region(S.selected) && region(S.selected).paths[S.hole.pi]) ? S.hole.pi : null;
  function hitHole(p) {                                      // an unshaded gap enclosed by a region
    let best = null;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const r of S.regions) {
      if (ctx.isPointInPath(regionPath(r), p.x, p.y, "evenodd")) continue;
      r.paths.forEach((path, pi) => {
        const one = new Path2D(); tracePath(one, path);
        if (ctx.isPointInPath(one, p.x, p.y)) { const a = G.pathArea(path); if (!best || a < best.a) best = { r, pi, a }; }
      });
    }
    ctx.restore(); return best;
  }
  const snapPt = (p) => { const h = hitBorder(p); return h ? h.point : p; };   // the ruler's ends stick to an outline
  function hitBorder(p) {                                    // for reroute: any outline near the cursor
    let best = null;
    for (const r of S.regions) { const h = hitLine(r, p); if (h && (!best || h.dist < best.dist || r.id === S.selected)) { best = Object.assign({ r }, h); if (r.id === S.selected) break; } }
    return best;
  }

  /* ---------------- shared boundaries ----------------
     Pieces made by slicing share nodes and curves. An edit to a shared node or curve is made in every region
     that has it, so neighbours keep meeting edge to edge. */
  const SAME = 0.05;                                           // image px: closer than this is the same point
  const same = (a, b) => Math.abs(a.x - b.x) < SAME && Math.abs(a.y - b.y) < SAME;
  function twinNodes(r, pi, ni) {
    const n = r.paths[pi].nodes[ni], out = [];
    for (const r2 of S.regions) r2.paths.forEach((path, pi2) => path.nodes.forEach((m, ni2) => {
      if ((r2 !== r || pi2 !== pi || ni2 !== ni) && same(n, m)) out.push({ r: r2, pi: pi2, ni: ni2 });
    }));
    return out;
  }
  function twinSegs(r, pi, seg) {
    const c = G.cubic(r.paths[pi], seg), out = [];
    for (const r2 of S.regions) {
      if (r2 === r) continue;
      r2.paths.forEach((path, pi2) => { for (let i = 0; i < path.segs.length; i++) {
        const d = G.cubic(path, i);
        if (same(c[0], d[0]) && same(c[1], d[1]) && same(c[2], d[2]) && same(c[3], d[3])) out.push({ r: r2, pi: pi2, seg: i, rev: false });
        else if (same(c[0], d[3]) && same(c[1], d[2]) && same(c[2], d[1]) && same(c[3], d[0])) out.push({ r: r2, pi: pi2, seg: i, rev: true });
      } });
    }
    return out;
  }

  /* ---------------- pointer ---------------- */
  let panning = null;
  cv.addEventListener("pointerdown", (e) => {
    if (!S.img) return;
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    const p = toImg(e);
    if (e.button === 1 || S.space) { closeLabel(); panning = { x: e.clientX, y: e.clientY, vx: S.view.x, vy: S.view.y }; return; }
    if (e.button !== 0) return;
    if (S.tool === "label") labelDown(p, e);
    else { closeLabel(); if (S.tool === "edit") editDown(p, e); else if (S.tool === "ruler") { const q = snapPt(p); S.rulerPrev = S.ruler; S.rulerDown = { x: e.clientX, y: e.clientY }; S.ruler = { kind: "line", a: q, b: q }; S.ruling = true; } else drawDown(p); }
    draw();
  });
  cv.addEventListener("pointermove", (e) => {
    if (!S.img) return;
    const p = toImg(e);
    if (panning) { S.view.x = panning.vx + e.clientX - panning.x; S.view.y = panning.vy + e.clientY - panning.y; S.fitted = false; draw(); return; }
    if (S.ruling) { S.ruler.b = snapPt(p); draw(); return; }
    if (S.drag) { dragMove(p); return; }
    if (S.stroke) { strokeMove(p); return; }
    if (S.tool === "draw") { const h = S.draft ? null : hitBorder(p); S.hover = h ? h.point : null; cv.style.cursor = "crosshair"; draw(); }
    else if (S.tool === "label") cv.style.cursor = S.space ? "grab" : hitRegion(p) ? "pointer" : "default";
    else if (S.tool === "ruler") cv.style.cursor = S.space ? "grab" : "crosshair";
    else { const sel = region(S.selected); cv.style.cursor = S.space ? "grab" : sel && (hitNode(sel, p) || hitLine(sel, p)) ? "pointer" : hitRegion(p) ? "move" : "default"; }
  });
  const up = (e) => {
    if (panning) { panning = null; return; }
    if (S.ruling) {                                            // a drag is a straight distance; a press without a drag is a click
      S.ruling = false;
      if (Math.hypot(e.clientX - S.rulerDown.x, e.clientY - S.rulerDown.y) < 4) rulerClick(toImg(e), S.rulerPrev);
      else { const h0 = hitBorder(S.ruler.a); if (h0 && G.dist(h0.point, S.ruler.a) < 0.01) pick(h0.r); }   // a line that starts on a region's outline
      draw(); return;
    }
    if (S.drag) { if (S.drag.moved) { const r = region(S.selected); if (r) r.edited = true; refresh(true); } else if (S.drag.pan === undefined) S.undo.pop(); S.drag = null; return; }
    if (S.stroke) strokeUp(toImg(e));
  };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  cv.addEventListener("wheel", (e) => {
    e.preventDefault(); if (!S.img) return;
    closeLabel();
    const b = cv.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.012), e.clientX - b.left, e.clientY - b.top);
    else { S.view.x -= e.deltaX; S.view.y -= e.deltaY; S.fitted = false; draw(); }
  }, { passive: false });
  cv.addEventListener("dblclick", (e) => {
    if (S.tool !== "edit") return;
    const r = region(S.selected), p = toImg(e); if (!r) return;
    const n = hitNode(r, p);
    if (n && twinNodes(r, n.pi, n.ni).length) { toast("This node is shared with a neighbouring region, so it stays"); return; }
    if (n) { pushUndo(); if (G.removeNode(r.paths[n.pi], n.ni)) { r.edited = true; refresh(true); } else { S.undo.pop(); toast("A shape needs at least two nodes"); } return; }
    const l = hitLine(r, p);
    if (l) {                                                   // a new node on a shared curve goes into the neighbour too
      const tw = twinSegs(r, l.pi, l.seg);
      pushUndo(); const k = G.insertNode(r.paths[l.pi], l.seg, l.t), q = r.paths[l.pi].nodes[k];
      for (const w of tw) { const path = w.r.paths[w.pi], k2 = G.insertNode(path, w.seg, w.rev ? 1 - l.t : l.t); path.nodes[k2] = { x: q.x, y: q.y }; }
      r.edited = true; refresh(true);
    }
  });

  /* Edit tool: nodes move, lines bend, empty space pans. */
  function editDown(p, e) {
    if (S.pickOp) {                                            // merge or subtract: this click picks the other region
      const po = S.pickOp, a = region(po.rid), b = hitRegion(p);
      S.pickOp = null; renderHint(); renderBar();
      if (a && b && b !== a) serverShape(po.op, a, b); else toast("Cancelled");
      return;
    }
    const sel = region(S.selected);
    if (sel) {
      const n = hitNode(sel, p);
      if (n) { pushUndo(); S.drag = { kind: "node", pi: n.pi, ni: n.ni, last: p, moved: false, twins: twinNodes(sel, n.pi, n.ni) }; return; }
      const l = hitLine(sel, p);
      if (l) { pushUndo(); S.drag = { kind: "bend", pi: l.pi, seg: l.seg, t: l.t, last: p, moved: false, twins: twinSegs(sel, l.pi, l.seg) }; return; }
    }
    const h = hitHole(p);                                      // inside a hole counts as the hole, even right next to its edge
    const r = hitRegion(p, true) || (h ? null : hitRegion(p));
    if (r) {
      if (r.id !== S.selected || S.hole) { S.selected = r.id; S.hole = null; refresh(); }
      pushUndo(); S.drag = { kind: "move", last: p, moved: false }; return;
    }
    if (h) {                                                   // clicking inside a hole selects just the hole
      S.selected = h.r.id; S.hole = { rid: h.r.id, pi: h.pi }; refresh();
      pushUndo(); S.drag = { kind: "movepath", pi: h.pi, last: p, moved: false }; return;
    }
    S.hole = null;
    if (S.selected) { S.selected = null; refresh(); }
    panning = { x: e.clientX, y: e.clientY, vx: S.view.x, vy: S.view.y };
  }
  function dragMove(p) {
    const r = region(S.selected), d = S.drag; if (!r) return;
    const delta = G.sub(p, d.last); if (!delta.x && !delta.y) return;
    if (d.kind === "node") { G.moveNode(r.paths[d.pi], d.ni, delta); for (const w of d.twins) G.moveNode(w.r.paths[w.pi], w.ni, delta); }
    else if (d.kind === "bend") { G.bendSeg(r.paths[d.pi], d.seg, d.t, delta); for (const w of d.twins) G.bendSeg(w.r.paths[w.pi], w.seg, w.rev ? 1 - d.t : d.t, delta); }
    else for (const path of (d.kind === "movepath" ? [r.paths[d.pi]] : r.paths)) {   // move the whole region (or one hole)
      path.nodes = path.nodes.map((n) => G.add(n, delta));
      path.segs = path.segs.map((sg) => ({ c1: G.add(sg.c1, delta), c2: G.add(sg.c2, delta) }));
    }
    for (const w of d.twins || []) { w.r._p = null; w.r._c = null; w.r.edited = true; }
    d.last = p; d.moved = true; r._p = null; r._c = null; draw();
  }

  /* Draw tool: one tool for new regions, continuing a line, and rerouting an outline. */
  function drawDown(p) {
    const s = S.view.s;
    if (S.draft) {
      const end = S.draft.nodes[S.draft.nodes.length - 1];
      if (G.dist(end, p) * s <= CLOSE) { S.stroke = { mode: "continue", pts: [end] }; return; }
      toast("Press the open end to continue, Enter to close, Esc to cancel"); return;
    }
    const b = hitBorder(p);
    if (b) { S.stroke = { mode: "reroute", pts: [b.point], rid: b.r.id, pi: b.pi }; S.selected = b.r.id; S.hover = null; renderPanel(); return; }
    S.stroke = { mode: "new", pts: [p] };
  }
  function strokeMove(p) {
    const a = S.stroke.pts, step = 3 / S.view.s;
    // retrace: moving back along your own line un-draws it
    while (a.length >= 2 && G.dist(p, a[a.length - 2]) < G.dist(a[a.length - 1], a[a.length - 2])) a.pop();
    if (G.dist(p, a[a.length - 1]) >= step) a.push(p);
    draw();
  }
  function strokeUp(p) {
    const st = S.stroke, s = S.view.s, tol = Math.min(6, Math.max(0.75, 2.5 / s));
    S.stroke = null;
    if (st.mode === "reroute") {
      const r = region(st.rid), path = r && r.paths[st.pi];
      const end = path && G.nearest(path, st.pts[st.pts.length - 1]);
      if (st.pts.length < 3) { draw(); return; }
      if (!end || end.dist * s > CLOSE) { toast("End the stroke on the same outline to reroute it"); draw(); return; }
      pushUndo();
      const np = G.reroute(path, st.pts, tol);
      if (!np) { S.undo.pop(); draw(); return; }
      r.paths[st.pi] = np; r.edited = true; refresh(true); return;
    }
    if (st.mode === "new" && st.pts.length >= 2 && trySlice(st.pts)) return;
    pushUndo();
    if (st.pts.length < 2) {                                   // a press with no drag: just the start point
      if (st.mode === "new") { S.draft = { closed: false, nodes: [st.pts[0]], segs: [] }; refresh(); } else { S.undo.pop(); draw(); }
      return;
    }
    S.draft = G.appendCubics(S.draft, G.fitCurve(st.pts, tol * tol));
    const d = S.draft, n = d.nodes.length;
    if (n >= 2 && d.segs.length >= 2 && G.dist(d.nodes[n - 1], d.nodes[0]) * s <= CLOSE) finishDraft(true);
    else refresh();
  }
  /* Slice: a stroke that starts outside a region, goes right across it and ends outside splits it in two. */
  function trySlice(line) {
    const a = line[0], b = line[line.length - 1];
    if (G.dist(a, b) * S.view.s <= CLOSE) return false;         // that is a closed loop: a new region
    const cuts = []; let why = "";
    for (const r of S.regions) {
      if (inside(r, a) || inside(r, b)) continue;             // the line must go right through: in one side, out the other
      const oi = r.paths.reduce((bi, p, i) => (G.pathArea(p) > G.pathArea(r.paths[bi]) ? i : bi), 0);
      const res = G.slice(r.paths[oi], line, Math.min(6, Math.max(0.75, 2.5 / S.view.s)));
      if (res === "miss") continue;
      if (res === "many") { why = why || "To split a region, cross its outline once on the way in and once on the way out"; continue; }
      if (res === "small") { why = why || "That would leave a piece too small to be a region"; continue; }
      const holes = r.paths.filter((_, i) => i !== oi);
      if (holes.some((h) => G.crossings(G.flatten(h, 2), line).length)) { why = why || "The cut goes through a hole. Delete the hole first, or cut beside it"; continue; }
      cuts.push({ r, res, holes });
    }
    if (!cuts.length) { if (why) { toast(why); draw(); return true; } return false; }
    pushUndo();
    let first = null, done = 0;
    const tolS = Math.min(6, Math.max(0.75, 2.5 / S.view.s));
    for (const { r, holes } of cuts) {
      const oi = r.paths.reduce((bi, p, i) => (G.pathArea(p) > G.pathArea(r.paths[bi]) ? i : bi), 0);
      const res = G.slice(r.paths[oi], line, tolS);             // again, now that earlier cuts may have added a node here
      if (typeof res === "string") continue;
      const parts = res.paths.map((path, k) => Object.assign(strip(r), {
        id: r.id + "-" + (++S.counter), name: r.name + "ab"[k], label: null, t: null, edited: true, split: true,
        paths: [path].concat(holes.filter((h) => G.inPoly(h.nodes[0], G.flatten(path, 3)))),
      }));
      S.regions.splice(S.regions.indexOf(r), 1, ...parts);
      for (const pt of res.ends) for (const r2 of S.regions) {  // neighbours that share this outline get the same node
        if (parts.includes(r2)) continue;
        for (const path of r2.paths) {
          const n = G.nearest(path, pt);
          if (n && n.dist < SAME && !path.nodes.some((m) => same(m, pt))) { const k = G.insertNode(path, n.seg, n.t); path.nodes[k] = { x: pt.x, y: pt.y }; }
        }
      }
      first = first || parts[0]; done++;
    }
    if (!first) { S.undo.pop(); draw(); return true; }
    S.selected = first.id; S.hole = null; refresh(true);
    toast(done === 1 ? "Split " + cuts[0].r.name + " in two" : "Split " + done + " regions");
    return true;
  }
  function finishDraft(snap) {
    const d = S.draft; if (!d) return;
    if (snap) d.nodes.pop(); else { if (d.nodes.length < 3) { toast("Draw a bit more before closing"); return; } pushUndo(); G.closeDraft(d, false); }
    d.closed = true; S.draft = null;
    if (G.pathArea(d) < 30) { toast("Too small to be a region"); refresh(); return; }
    const probe = G.flatten(d, 6), host = S.regions.find((x) => probe.every((q) => inside(x, q)));
    if (host) { host.paths.push(d); host.edited = true; S.selected = host.id; refresh(true); toast("Cut a hole in " + host.name); return; }
    S.counter++;
    const r = { id: "d" + S.counter, name: "drawn-" + String(S.counter).padStart(2, "0"), source: "drawn", label: null, t: null, meanProb: null, edited: true, paths: [d] };
    S.regions.push(r); S.selected = r.id; refresh(true);
  }

  /* ---------------- actions ---------------- */
  const order = () => S.regions.slice().sort((a, b) => (a.meanProb == null ? 2 : a.meanProb) - (b.meanProb == null ? 2 : b.meanProb) || a.name.localeCompare(b.name));
  function step(dir) {
    const q = order(); if (!q.length) return;
    const i = q.findIndex((r) => r.id === S.selected), r = q[(i + dir + q.length) % q.length];
    S.selected = r.id; S.hole = null; focusRegion(r); refresh();
  }
  function deleteSelected() {
    const r = region(S.selected); if (!r) return;
    pushUndo();
    if (selHole() != null && r.paths.length > 1) { r.paths.splice(selHole(), 1); r.edited = true; S.hole = null; }   // just the hole
    else { S.regions = S.regions.filter((x) => x !== r); S.selected = null; S.hole = null; }
    refresh(true);
  }
  function setTool(t) { closeLabel(); S.tool = t; S.hover = null; $("toolEdit").classList.toggle("on", t === "edit"); $("toolDraw").classList.toggle("on", t === "draw"); $("toolLabel").classList.toggle("on", t === "label"); $("toolRuler").classList.toggle("on", t === "ruler"); S.pickOp = null; if (t !== "ruler") S.ruler = null; cv.style.cursor = t === "draw" || t === "ruler" ? "crosshair" : "default"; renderHint(); draw(); }

  /* ---------------- label ---------------- */
  function setClass(r, id) {                                  // choosing the class it already has takes the class off
    if (!id && !r.cls) return;
    pushUndo(); if (id && r.cls !== id) r.cls = id; else delete r.cls;
    refresh(true); if (S.labelFor === r.id) renderLabel(r);
  }
  function toggleUnsure(r) {
    pushUndo(); if (r.unsure) delete r.unsure; else r.unsure = true;
    refresh(true); if (S.labelFor === r.id) renderLabel(r);
  }
  function labelDown(p, e) {                                   // Label tool: click a region for its menu
    const r = hitRegion(p);
    if (r) { S.selected = r.id; S.hole = null; refresh(); openLabel(r, e); return; }
    closeLabel();
    if (S.selected) { S.selected = null; refresh(); }
    panning = { x: e.clientX, y: e.clientY, vx: S.view.x, vy: S.view.y };
  }
  function renderLabel(r) {
    const pop = $("labelPop");
    pop.innerHTML = `<div class="pop-h">${esc(r.name)}</div>` + S.classes.map((c, i) =>
      `<button class="pop-row ${r.cls === c.id ? "on" : ""}" data-cls="${esc(c.id)}" type="button"><span class="sw" style="background:rgb(${c.color})"></span><span class="pn">${esc(c.name)}</span>${i < 9 ? `<kbd>${i + 1}</kbd>` : ""}</button>`).join("") +
      `<div class="pop-sep"></div>
      <button class="pop-row ${r.unsure ? "on" : ""}" id="popUnsure" type="button"><span class="sw q"></span><span class="pn">Unsure</span><kbd>U</kbd></button>
      <input type="text" id="popNote" placeholder="Add a note" maxlength="200" aria-label="Note" value="${esc(r.note || "")}">
      <button class="link pop-edit" id="popEdit" type="button">Edit classes</button>`;
    const note = $("popNote"); let armed = false;
    note.oninput = () => { if (!armed) { pushUndo(); armed = true; } if (note.value.trim()) r.note = note.value; else delete r.note; scheduleSave(); };
    note.onchange = () => refresh(true);
    note.onkeydown = (e) => { if (e.key === "Enter" || e.key === "Escape") { note.blur(); closeLabel(); } };
  }
  /* Open the menu beside the click (or beside the region when there was no click). */
  function openLabel(r, e) {
    const pop = $("labelPop"); S.labelFor = r.id; renderLabel(r);
    const b = stage.getBoundingClientRect(), W = pop.offsetWidth, H = pop.offsetHeight, v = S.view;
    let x, y;
    if (e) { x = e.clientX - b.left + 18; y = e.clientY - b.top - H / 2; if (x + W > b.width - 8) x = e.clientX - b.left - W - 18; }
    else { const bb = G.bbox(r.paths); x = bb.x1 * v.s + v.x + 14; y = (bb.y0 + bb.y1) / 2 * v.s + v.y - H / 2; if (x + W > b.width - 8) x = bb.x0 * v.s + v.x - W - 14; }
    pop.style.left = Math.max(8, Math.min(b.width - W - 8, x)) + "px"; pop.style.top = Math.max(8, Math.min(b.height - H - 8, y)) + "px";
    pop.classList.add("open");
  }
  function closeLabel() { if (!S.labelFor) return; S.labelFor = null; $("labelPop").classList.remove("open"); }

  /* The class list of the current library. */
  let draftClasses = [];
  function showClasses() {
    if (!S.lib) return;
    draftClasses = S.classes.map((c) => Object.assign({}, c)); renderClasses();
    $("classErr").textContent = ""; $("classModal").classList.add("show");
  }
  function renderClasses() {
    $("classRows").innerHTML = draftClasses.map((c, i) => `<div class="cls-row" data-i="${i}"><span class="sw" style="background:rgb(${c.color})"></span><kbd>${i + 1}</kbd>
      <input type="text" maxlength="24" value="${esc(c.name)}" placeholder="Class name" aria-label="Class name">
      <label class="check"><input type="checkbox" ${c.exclude ? "checked" : ""}> Leave out of measurements</label>
      <button class="icon-btn" data-rm type="button" title="Remove this class"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join("")
      || `<p class="note" style="margin:0">No classes. Add one below.</p>`;
    $("classAdd").disabled = draftClasses.length >= 9;
  }
  async function saveClasses() {
    try {
      const j = await api("/api/editor/library/classes", { id: S.lib.id, classes: draftClasses.filter((c) => c.name.trim()) });
      S.classes = j.classes; S.lib.classes = j.classes;
      let lost = false;
      for (const r of S.regions) if (r.cls && !classOf(r)) { delete r.cls; lost = true; }
      $("classModal").classList.remove("show"); refresh(lost);
    } catch (e) { $("classErr").textContent = e.message; }
  }

  /* ---------------- measure ---------------- */
  const um = () => (S.lib && S.lib.pixel_um) || null;          // µm per pixel, when the library has one
  const fmt = (v) => (v >= 1000 ? Math.round(v).toLocaleString("en") : String(+v.toPrecision(3)));
  const fmtLen = (px) => { const u = um(); if (!u) return fmt(px) + " px"; const v = px * u; return v >= 1000 ? fmt(v / 1000) + " mm" : fmt(v) + " µm"; };
  /* ref: the largest area in the same table, so that every row uses the same unit. */
  const fmtArea = (px2, ref) => { const u = um(); if (!u) return fmt(px2) + " px²"; const v = px2 * u * u; return (ref == null ? px2 : ref) * u * u >= 1e4 ? fmt(v / 1e6) + " mm²" : fmt(v) + " µm²"; };
  /* Area (holes taken out), outer perimeter, circularity and longest diameter of a region, in image pixels. */
  function measures(r) {
    if (r._m) return r._m;
    const fl = r.paths.map((p) => G.flatten(p, 2));
    const depth = fl.map((f, i) => fl.reduce((d, g, j) => d + (j !== i && g.length > 2 && G.inPoly(f[0], g) ? 1 : 0), 0));
    let area = 0, perim = 0, outer = [];
    fl.forEach((f, i) => {
      const a = Math.abs(G.polyArea(f)); area += depth[i] % 2 ? -a : a;
      if (depth[i] === 0) { for (let k = 0; k < f.length; k++) perim += G.dist(f[k], f[(k + 1) % f.length]); outer = outer.concat(f); }
    });
    const stepN = Math.max(1, Math.ceil(outer.length / 240)), s = outer.filter((_, i) => i % stepN === 0);
    let feret = 0;
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) { const d = G.dist(s[i], s[j]); if (d > feret) feret = d; }
    return (r._m = { area, perim, circ: perim ? 4 * Math.PI * area / (perim * perim) : 0, feret });
  }
  function renderMeasure() {
    const el = $("measBody");
    if (!S.sid || !S.img) { el.innerHTML = `<p class="note" style="margin:0">Nothing open.</p>`; return; }
    const groups = new Map(); let measured = 0, excluded = 0;
    for (const r of S.regions) {
      const c = classOf(r), a = measures(r).area;
      if (c && c.exclude) { excluded += a; continue; }
      measured += a; const k = c ? c.id : ""; groups.set(k, (groups.get(k) || 0) + a);
    }
    const rows = S.classes.filter((c) => groups.has(c.id)).map((c) => [c, groups.get(c.id)]);
    if (groups.has("")) rows.push([null, groups.get("")]);
    const sel = region(S.selected), m = sel && measures(sel), top = Math.max(measured, excluded), img = S.img.width * S.img.height;
    const val = (t) => { const i = t.lastIndexOf(" "); return i < 0 ? t : `${t.slice(0, i)} <small>${t.slice(i + 1)}</small>`; };
    const num = (t) => t.slice(0, t.lastIndexOf(" ")), unitOf = (a) => { const t = fmtArea(a, top); return t.slice(t.lastIndexOf(" ") + 1); };
    const tile = (name, t) => `<div class="stat"><span>${name}</span><b>${val(t)}</b></div>`;
    const pc = (a, b) => { const v = b ? 100 * a / b : 0; return (v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1)) + "%"; };
    el.innerHTML = `
      ${sel ? `<div><div class="meas-cap"><span>Selected</span><b>${esc(sel.name)}</b></div><div class="stat-grid">
        ${tile("Area", fmtArea(m.area))}${tile("Perimeter", fmtLen(m.perim))}${tile("Longest", fmtLen(m.feret))}${tile("Circularity", m.circ.toFixed(2))}</div></div>` : ""}
      ${S.regions.length ? `<table class="meas-t"><colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"></colgroup>
        <thead><tr><th>Class</th><th>Area <small>${unitOf(top)}</small></th><th title="Share of all the regions">Regions</th><th title="Share of the whole image">Image</th></tr></thead><tbody>
        ${rows.map(([c, a]) => `<tr><td><span class="cl"><span class="sw ${c ? "" : "none"}" ${c ? `style="background:rgb(${c.color})"` : ""}></span><span class="cn">${c ? esc(c.name) : "No class"}</span></span></td><td>${num(fmtArea(a, top))}</td><td>${pc(a, measured)}</td><td>${pc(a, img)}</td></tr>`).join("")}
        ${excluded ? `<tr class="ex"><td><span class="cl"><span class="sw q"></span><span class="cn">Left out</span></span></td><td>${num(fmtArea(excluded, top))}</td><td>–</td><td>–</td></tr>` : ""}
        <tr class="tot"><td>Total</td><td>${num(fmtArea(measured, top))}</td><td>100%</td><td>${pc(measured, img)}</td></tr></tbody></table>` : `<p class="note">No regions to measure.</p>`}
      <div class="meas-foot"><label class="px-box" title="The size of one pixel, in micrometres. With it set, measurements are in µm and mm."><input type="number" id="pxUm" min="0" step="any" placeholder="Pixel size" aria-label="Pixel size" value="${um() || ""}"><span>µm/px</span></label>
        <button class="btn" id="measCsv" type="button" title="One table of every region in this library">Download CSV</button></div>`;
    $("pxUm").onchange = async (e) => {
      try { const j = await api("/api/editor/library/scale", { id: S.lib.id, um: parseFloat(e.target.value) || 0 }); S.lib.pixel_um = j.pixel_um; renderMeasure(); renderBar(); draw(); }
      catch (err) { toast(err.message); }
    };
    $("measCsv").onclick = async () => {
      try {
        await saveNow();
        const j = await api("/api/editor/library/measurements?id=" + encodeURIComponent(S.lib.id));
        const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([j.csv], { type: "text/csv" })); a.download = j.name;
        document.body.appendChild(a); a.click(); a.remove(); toast(`${j.rows} regions written to ${j.name}`);
      } catch (err) { toast(err.message); }
    };
  }

  /* ---------------- reshape ---------------- */
  function renderBar() {
    const bar = $("shapeBar"), r = region(S.selected), show = !!(S.tool === "edit" && r && selHole() == null && !S.draft && !S.demo);
    bar.classList.toggle("open", show); stage.classList.toggle("has-bar", show);
    $("sbUnit").textContent = um() ? "µm" : "px";
    bar.querySelectorAll("[data-op]").forEach((b) => b.classList.toggle("on", !!S.pickOp && S.pickOp.op === b.dataset.op));
    const can = !!(show && r.label != null), sl = $("slider");   // the slider re-cuts a region from the model's output
    sl.disabled = !can; $("sliderReset").disabled = !can; $("sbInfo").hidden = can;
    if (can && !sliderArmed) sl.value = r.t;
    $("sbSlideRow").title = !can ? "Drawn, split and merged regions have no model outline to re-cut. Use Grow and Shrink."
      : (S.meta.has_prob ? "Re-cuts the region from the probability map: the edge moves most where the model was unsure."
        : "Moves the edge evenly in or out (this image has no probability map).") + " It replaces changes made to this region by hand.";
  }
  const ringsOf = (r) => r.paths.map((p) => G.flatten(p, 1).map((q) => [+q.x.toFixed(2), +q.y.toFixed(2)]));
  async function shapeOp(op) {
    const r = region(S.selected); if (!r) return;
    if (op === "merge" || op === "subtract") {
      if (S.pickOp && S.pickOp.op === op) { S.pickOp = null; renderHint(); renderBar(); return; }
      S.pickOp = { op, rid: r.id }; renderHint(); renderBar(); return;
    }
    if (op === "fill") {
      const fl = r.paths.map((p) => G.flatten(p, 3)), keep = r.paths.filter((_, i) => !fl.some((g, j) => j !== i && G.inPoly(fl[i][0], g)));
      if (keep.length === r.paths.length) { toast("This region has no holes"); return; }
      pushUndo(); r.paths = keep; r.edited = true; refresh(true); return;
    }
    if (op === "smooth") {
      pushUndo();
      r.paths = r.paths.map((p) => G.fitClosed(G.flatten(p, 2).map((q) => ({ x: q.x, y: q.y })), 6)).filter((p) => p.nodes.length >= 1 && p.segs.length >= 1);
      r.edited = true; refresh(true); return;
    }
    const v = parseFloat($("sbDist").value);
    if (!(v > 0)) { toast("Type a distance first"); return; }
    await serverShape(op === "band" ? "band" : "offset", r, null, (op === "shrink" ? -v : v) / (um() || 1));
  }
  /* Merge, subtract, even grow or shrink, and band are worked out on the server from pixel masks. */
  async function serverShape(op, r, other, dist) {
    try {
      const j = await api("/api/editor/reshape", { id: S.sid, op, a: ringsOf(r), b: other ? ringsOf(other) : null, dist: dist || 0 });
      let paths = j.rings.map((ring) => G.fitClosed(pts(ring), 0.35)).filter((q) => q.nodes.length >= 1 && q.segs.length >= 1);
      if (!paths.length) throw new Error("Nothing would be left");
      if (op === "band") {                                     // the band's inner edge is the region's own outline
        const fl = r.paths.map((q) => G.flatten(q, 3));
        paths = paths.concat(JSON.parse(JSON.stringify(r.paths.filter((_, i) => !fl.some((g, k) => k !== i && G.inPoly(fl[i][0], g))))));
      }
      pushUndo();
      if (op === "band") {
        S.counter++;
        const nr = { id: "d" + S.counter, name: r.name + "-band", source: "drawn", label: null, t: null, meanProb: null, edited: true, paths };
        S.regions.push(nr); S.selected = nr.id;
      } else { r.paths = paths; r.edited = true; if (op === "merge") S.regions = S.regions.filter((x) => x !== other); }
      S.hole = null; refresh(true);
    } catch (e) { toast(e.message); }
  }

  /* Grow / shrink: re-cut one region from the model's probability map at a different cut-off. */
  let sliderSeq = 0, sliderArmed = false;
  async function slide(t) {
    const r = region(S.selected); if (!r || r.label == null) return;
    if (!sliderArmed) { pushUndo(); sliderArmed = true; }
    const seq = ++sliderSeq;
    try {
      const j = await api(`/api/editor/rethreshold?id=${encodeURIComponent(S.sid)}&label=${r.label}&t=${t}`);
      if (seq !== sliderSeq) return;
      const paths = fitRings(j.rings);
      if (!paths.length) { toast("Nothing left at this setting"); return; }
      r.paths = paths; r.t = t; r.edited = false; r._p = null; draw();
    } catch (e) { toast(e.message); }
  }
  const sliderText = (t) => S.meta.has_prob ? "cut-off " + (+t).toFixed(2)
    : (() => { const px = Math.round((S.meta.threshold - t) * 80); return (px > 0 ? "+" : "") + px + " px"; })();

  /* ---------------- panel ---------------- */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function renderPanel() {
    renderMeasure();
    const q = order();
    $("progress").textContent = S.regions.length ? String(S.regions.length) : "";
    $("confHead").textContent = S.regions.some((r) => r.meanProb != null) ? "Model confidence" : "";
    $("confHead").hidden = !$("confHead").textContent;
    $("queue").innerHTML = q.length ? q.map((r) => {
      const c = r.meanProb, cls = c == null ? "" : c < 0.7 ? "low" : c < 0.85 ? "mid" : "";
      return `<button class="q-item ${r.id === S.selected ? "on" : ""}" data-id="${r.id}">
        <span class="q-dot" ${classOf(r) ? `style="background:rgb(${classOf(r).color})" title="${esc(classOf(r).name)}"` : ""}></span><span class="q-name">${esc(r.name)}</span>
        ${r.unsure ? '<span class="tag">unsure</span>' : ""}${r.source === "drawn" ? '<span class="tag">drawn</span>' : r.edited ? '<span class="tag">edited</span>' : ""}
        <span class="conf ${cls}">${c == null ? "" : Math.round(c * 100) + "%"}</span></button>`;
    }).join("") : `<p class="note" style="padding:6px 8px">${S.sid ? "No regions on this image. Use the Draw tool to add one." : "Nothing open."}</p>`;
    $("queue").querySelectorAll(".q-item").forEach((b) => (b.onclick = () => { const r = region(b.dataset.id); S.selected = r.id; S.hole = null; focusRegion(r); refresh(); }));

    $("delRegion").disabled = !region(S.selected);
    $("navPrev").disabled = $("navNext").disabled = !S.regions.length;
  }
  function renderHint() {
    const k = (s) => `<kbd>${s}</kbd>`;
    let h = "";
    if (!S.sid) h = "Open an image to begin.";
    else if (S.tool === "edit" && selHole() != null) h = `Hole selected · ${k("Del")} removes just this hole · drag inside it to move it · drag its nodes or line to reshape it`;
    else if (S.tool === "edit") h = region(S.selected)
      ? `Drag a node to move it · drag the line to bend it · drag inside to move the whole region · double-click the line to add a node, a node to remove it · ${k("Del")} removes the region`
      : `Click a region to select it · drag empty space to pan · pinch or ${k(MOD)}-scroll to zoom`;
    else if (S.pickOp) h = `${S.pickOp.op === "merge" ? "Click the region to join with this one" : "Click the region to cut away from this one"} · ${k("Esc")} cancels`;
    else if (S.tool === "ruler") h = `Drag for a straight distance · click two points on one outline for the length along it, both ways round · click a region for its longest diameter, then another region for the gap between them · ${k("Esc")} clears`;
    else if (S.tool === "label") h = `Click a region for its class menu · with the menu open, ${k("1")}–${k("9")} pick the class · ${k("U")} marks the selected region unsure · hold ${k("X")} to hide the regions`;
    else if (S.draft) h = `Press the open end (orange) to continue · finish on the first node to close · ${k("Del")} removes the last node · ${k("Enter")} closes · ${k("Esc")} cancels`;
    else h = "Press, drag, release to draw a new region. Draw inside a region to cut a hole. Start and end on an outline to reroute that stretch. Draw right across a region to split it. Drag back along your line to un-draw.";
    $("hint").innerHTML = h;
  }
  let toastTimer = null;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600); }

  /* ---------------- libraries ---------------- */
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
  function renderNav() {
    const n = S.lib ? S.lib.cases.length : 0;
    $("caseNav").hidden = !S.lib;
    $("casePos").textContent = n ? `${S.caseIndex + 1} / ${n}` : "–";
    $("prevCase").disabled = S.caseIndex <= 0; $("nextCase").disabled = S.caseIndex >= n - 1;
    const cur = S.lib && S.lib.cases[S.caseIndex];
    $("doneBtn").hidden = !cur; $("doneBtn").classList.toggle("on", !!(cur && cur.done));
    $("doneBtn").title = cur && cur.done ? "Marked as done. Click to take the mark off (D)" : "Mark this image as done (D)";
    $("prevCase").title = S.lib ? `Previous image in ${S.lib.name} (←)` : ""; $("nextCase").title = S.lib ? `Next image in ${S.lib.name} (→)` : "";
  }
  /* Make a library the current one and open one of its images. */
  async function useLibrary(id, index) {
    const lib = await api("/api/editor/library?id=" + encodeURIComponent(id));
    if (index == null) index = +(store.get("seg-editor-idx-" + id) || 0);
    S.lib = lib; S.classes = lib.classes || DEFAULT_CLASSES; store.set("seg-editor-lib", id);
    await openCase(Math.min(Math.max(index, 0), lib.cases.length - 1));
  }
  /* Done mark: a finished image. Marking one done moves on to the next unfinished image. */
  async function toggleDone() {
    const c = S.lib && S.lib.cases[S.caseIndex]; if (!c) return;
    try {
      await saveNow();
      const j = await api("/api/editor/library/done", { id: S.lib.id, index: S.caseIndex, done: !c.done });
      c.done = j.done; renderNav();
    } catch (e) { toast(e.message); }
  }
  /* Export: choose what (this image or a whole library) and where, then confirm. */
  const FORMATS = [["corrected_mask_tif", "Corrected mask (TIF)"], ["corrected_mask_full_tif", "Corrected mask, original size (TIF)"], ["imagej_tif", "ImageJ image with regions (TIF)"],
    ["mask_png", "Mask (PNG)"], ["overlay_png", "Shaded image (PNG)"],
    ["roiset_zip", "ImageJ ROI set (ZIP)"], ["qupath_geojson", "QuPath annotations (GeoJSON)"]];
  const FMT_KEY = "seg-editor-export-formats";                    // each person's last choice, in their browser
  const lastFormats = () => {
    try { const v = JSON.parse(store.get(FMT_KEY) || "null"); if (Array.isArray(v) && v.some((k) => FORMATS.some(([f]) => f === k))) return v; } catch (e) {}
    return ["corrected_mask_tif"];
  };
  const tilde = (p, home) => (home && p.startsWith(home) ? "~" + p.slice(home.length) : p);
  async function showExport(scope, libId, libName) {
    const lib = libId ? { id: libId, name: libName } : S.lib ? { id: S.lib.id, name: S.lib.name, n: S.lib.cases.length } : null;
    scope = scope || (S.sid ? "image" : "library");
    $("openModal").classList.remove("show");
    let st; try { st = await api("/api/editor/settings"); } catch (e) { toast(e.message); return; }
    let dest = st.export_dir;
    const fmts = lastFormats();                                 // the corrected mask unless this person chose others last time
    $("exportBody").innerHTML = `
      <div class="opts">
        <label class="opt"><input type="radio" name="exScope" value="image" ${scope === "image" ? "checked" : ""} ${S.sid ? "" : "disabled"}>
          <span><b>This image</b><span>${S.sid ? esc(S.meta.name) : "No image open"}</span></span></label>
        <label class="opt"><input type="radio" name="exScope" value="library" ${scope === "library" ? "checked" : ""} ${lib ? "" : "disabled"}>
          <span><b>Whole library</b><span>${lib ? esc(lib.name) + (lib.n ? ` · ${lib.n} images` : "") : "No library open"}</span></span></label>
      </div>
      ${st.hosted ? '<p class="note" style="margin-top:14px">The files are packed into one .zip, which downloads to your computer.</p>' : ""}
      <div class="dest" ${st.hosted ? "hidden" : ""}><span>Save in</span><input type="text" class="path" id="exDest" value="${esc(tilde(dest, st.home))}" title="The folder to save in. Choose it, or type a path." spellcheck="false"><button class="btn" id="exChoose">Choose…</button></div>
      <div class="fmt-h">Files to write</div>
      <div class="fmts">${FORMATS.filter(([k]) => k !== "corrected_mask_full_tif" || (S.meta && S.meta.original)).map(([k, label]) => `<label class="check" ${k === "corrected_mask_full_tif" ? `title="At the size of ${esc(S.meta.original.file)}"` : ""}><input type="checkbox" name="exFmt" value="${k}" ${fmts.includes(k) ? "checked" : ""}> ${k === "corrected_mask_full_tif" ? `Corrected mask, ${S.meta.original.width} × ${S.meta.original.height} (TIF)` : label}</label>`).join("")}</div>
      <div class="err" id="exErr"></div>
      <div class="actions"><button class="btn" id="exCancel">Cancel</button><button class="btn primary" id="exGo">Export</button></div>`;
    $("exportModal").classList.add("show");
    $("exCancel").onclick = () => $("exportModal").classList.remove("show");
    $("exChoose").onclick = async () => {
      $("exErr").textContent = "Choose a folder in the window that opens…";
      try { const j = await api("/api/editor/choose-folder", {}); if (j.export_dir) { dest = j.export_dir; $("exDest").value = tilde(dest, st.home); } $("exErr").textContent = ""; }
      catch (e) { $("exErr").textContent = e.message; $("exDest").focus(); }
    };
    $("exGo").onclick = () => {
      const chosen = [...document.querySelectorAll("input[name=exFmt]:checked")].map((x) => x.value);
      if (!chosen.length) { $("exErr").textContent = "Tick at least one file type."; return; }
      store.set(FMT_KEY, JSON.stringify(chosen));
      const typed = $("exDest").value.trim();                   // "~" stands for the home folder
      if (typed) dest = typed === "~" || /^~[\\/]/.test(typed) ? st.home + typed.slice(1) : typed;
      runExport(document.querySelector("input[name=exScope]:checked").value, lib, dest, chosen);
    };
  }
  async function runExport(scope, lib, dest, formats) {
    const body = $("exportBody"), job = "j" + Date.now() + Math.random().toString(36).slice(2, 7);
    body.innerHTML = `<p class="note" style="margin:0">Exporting ${scope === "library" ? esc(lib.name) : esc(S.meta.name)}…</p>
      <div class="prog"><i id="exBar"></i></div><div class="prog-t"><span id="exCount"></span><span id="exPct">0%</span></div>
      <div class="actions"><button class="btn" id="exStop">Cancel export</button></div>`;
    let stopping = false;
    $("exStop").onclick = () => {                                // the server stops at its next step and deletes what it wrote
      stopping = true; $("exStop").disabled = true; $("exStop").textContent = "Cancelling…";
      api("/api/editor/cancel", { job }).catch(() => {});
    };
    /* The bar eases toward each report from the server, then keeps creeping slowly toward the next step while it
       waits, so it never stands still; it only shows 100% when the export is really done. */
    let shown = 0, target = 0, ceiling = 4, total = 1, doneN = 0, finished = false;
    const paint = () => {
      if (!$("exBar")) return;
      $("exBar").style.width = shown.toFixed(1) + "%"; $("exPct").textContent = Math.floor(shown) + "%";
      $("exCount").textContent = total > 1 ? (finished ? `${total} of ${total} images` : `Image ${Math.min(total, Math.floor(doneN) + 1)} of ${total}`) : "";
    };
    const setBar = (done, tot) => {
      total = tot || 1; doneN = done;
      if (finished) { target = ceiling = 100; return; }
      target = Math.max(target, Math.min(97, 100 * done / total));
      ceiling = Math.max(ceiling, Math.min(97, target + Math.max(4, 25 / total)));
    };
    const anim = setInterval(() => {
      if (shown < target) shown = Math.min(target, shown + Math.max(0.8, (target - shown) * 0.25));
      else if (shown < ceiling) shown = Math.min(ceiling, shown + Math.max(0.03, (ceiling - shown) * 0.012));
      paint();
    }, 50);
    const poll = setInterval(async () => { try { const p = await api("/api/editor/progress?job=" + job); setBar(p.done, p.total); } catch (e) {} }, 250);
    try {
      await saveNow();
      let j, summary;
      const iouText = (v, lead) => (v == null ? "" : ` ${lead} IoU <b class="mono">${v.toFixed(4)}</b>.`);
      if (scope === "library") {
        j = await api("/api/editor/library/export", { id: lib.id, dest, formats, job });
        summary = `${j.images} image${j.images === 1 ? "" : "s"} exported from ${esc(lib.name)}: ${j.edited} edited, ${j.done} marked done.` + iouText(j.min_iou, "Lowest ImageJ read-back match:");
      } else {
        const regions = S.regions.map((r) => ({ name: r.name, rings: r.paths.map((p) => G.flatten(p, 1).map((q) => [+q.x.toFixed(2), +q.y.toFixed(2)])) }));
        j = await api("/api/editor/export", { id: S.sid, regions, dest, formats, job });
        summary = `${j.regions} region${j.regions === 1 ? "" : "s"} exported from ${esc(S.meta.name)}.` + iouText(j.imagej_iou, "The ImageJ file was read back and matches the mask at");
      }
      clearInterval(poll); finished = true; setBar(total, total);
      await new Promise((r) => setTimeout(r, 450));               // let the bar be seen reaching full
      clearInterval(anim);
      if (j.download) {                                         // hosted: the export comes back as a .zip
        const url = "/api/editor/download?name=" + encodeURIComponent(j.download);
        body.innerHTML = `<p class="note" style="margin:0 0 12px">${summary}</p>
          <div class="dest" style="margin-top:0"><span>Downloaded as</span><span class="path">${esc(j.download)}</span><a class="btn" id="exAgain" href="${url}" download>Download again</a></div>
          <div class="actions"><button class="btn primary" id="exDone">Done</button></div>`;
        $("exDone").onclick = () => $("exportModal").classList.remove("show");
        if (!window.__noDownload) $("exAgain").click();
        return j;
      }
      body.innerHTML = `<p class="note" style="margin:0 0 12px">${summary}</p>
        <div class="dest" style="margin-top:0"><span>Saved in</span><span class="path" title="${esc(j.dir)}">${esc(j.dir)}</span><button class="btn" id="exReveal">${MAC ? "Show in Finder" : "Show folder"}</button></div>
        <div class="actions"><button class="btn primary" id="exDone">Done</button></div>`;
      $("exReveal").onclick = () => api("/api/editor/reveal", { path: j.dir }).catch((e) => toast(e.message));
      $("exDone").onclick = () => $("exportModal").classList.remove("show");
      return j;
    } catch (e) {
      clearInterval(poll); clearInterval(anim);
      if (stopping) { showExport(scope, lib && lib.id, lib && lib.name); toast("Export cancelled"); return; }
      body.innerHTML = `<p class="err">${esc(e.message)}</p><div class="actions"><button class="btn" id="exBack">Back</button></div>`;
      $("exBack").onclick = () => showExport(scope, lib && lib.id, lib && lib.name);
    }
  }
  let opening = false;
  async function openCase(i) {
    if (!S.lib || opening || i < 0 || i >= S.lib.cases.length) return;
    opening = true;
    try {
      await saveNow();                                          // the image being left is saved first
      $("sessionName").textContent = "Opening " + S.lib.cases[i].name + "…";
      if (S.img) cv.classList.add("switching");                 // the old image dims while the next one loads
      const j = await api("/api/editor/library/open", { id: S.lib.id, index: i });
      S.caseIndex = i; store.set("seg-editor-idx-" + S.lib.id, i);
      await openSession(j.id); renderNav();
    } catch (e) { toast(e.message); if (S.meta) $("sessionName").textContent = S.meta.name; }
    cv.classList.remove("switching");
    opening = false;
  }

  /* Anything that opens or closes changes height smoothly (respecting reduced motion). */
  const REDUCE = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function animateHeight(el, from, to, ms = 260, fade = true) {
    return new Promise((done) => {
      if (REDUCE || !el) return done();
      Object.assign(el.style, { overflow: "hidden", height: from + "px", opacity: fade ? (from < to ? "0" : "1") : "", transition: "none" });
      void el.offsetHeight;
      Object.assign(el.style, { transition: `height ${ms}ms cubic-bezier(.2,.7,.2,1)` + (fade ? `, opacity ${Math.round(ms * 0.8)}ms ease` : ""), height: to + "px", opacity: fade ? (from < to ? "1" : "0") : "" });
      setTimeout(() => { Object.assign(el.style, { overflow: "", height: "", opacity: "", transition: "" }); done(); }, ms + 30);
    });
  }
  const expand = (el) => animateHeight(el, 0, el.scrollHeight);
  /* A dialog whose contents change (tabs, export progress, a library's images) glides to its new height. */
  function smoothResize(modal, body) {
    let last = modal.getBoundingClientRect().height, busy = false, shownAt = 0;
    new ResizeObserver(() => { if (!busy) last = modal.getBoundingClientRect().height; }).observe(modal);
    const bd = modal.closest(".backdrop");                         // only changes while it is open glide; opening does not
    new MutationObserver(() => { if (bd.classList.contains("show")) { if (!shownAt) shownAt = performance.now(); } else shownAt = 0; })
      .observe(bd, { attributes: true, attributeFilter: ["class"] });
    new MutationObserver(() => {
      if (busy) return;
      const to = modal.getBoundingClientRect().height;
      if (Math.abs(to - last) < 3 || !bd.classList.contains("show") || !shownAt || performance.now() - shownAt < 120) { last = to; return; }
      busy = true; const from = last; last = to;
      animateHeight(modal, from, to, 240, false).then(() => { busy = false; last = modal.getBoundingClientRect().height; });
    }).observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  }
  /* "Choose the files by hand" and other folding sections open and close smoothly. */
  function wireDetails(d) {
    const sum = d.querySelector("summary");
    sum.addEventListener("click", async (e) => {
      e.preventDefault();
      const shut = sum.getBoundingClientRect().height + parseFloat(getComputedStyle(sum).marginBottom || 0);
      if (!d.open) { d.open = true; await animateHeight(d, shut, d.scrollHeight, 280, false); }
      else { await animateHeight(d, d.getBoundingClientRect().height, sum.getBoundingClientRect().height, 240, false); d.open = false; }
    });
  }
  const collapse = (el) => animateHeight(el, el.getBoundingClientRect().height, 0);

  async function showOpen() {
    $("openModal").classList.add("show"); $("importErr").textContent = ""; $("libErr").textContent = "";
    S.pick = null; S.pickLib = null; $("preview").hidden = true;
    if (S.lib) { try { await saveNow(); S.lib = await api("/api/editor/library?id=" + encodeURIComponent(S.lib.id)); } catch (e) {} }
    S.libCases = S.lib ? { [S.lib.id]: S.lib.cases } : {};
    S.libOpen = S.lib && !S.libShut ? S.lib.id : null;
    await renderLibraries();
  }
  /* First click on an image (in any library) selects it and shows a preview; clicking it again, double-clicking,
     or Enter opens it, switching to its library if that is another one. */
  const casesOf = (lid) => (S.libCases && S.libCases[lid]) || (S.lib && S.lib.id === lid ? S.lib.cases : null);
  function pickCase(i, lid) {
    lid = lid || (S.lib && S.lib.id);
    const cases = casesOf(lid);
    if (!cases || i < 0 || i >= cases.length) return;
    if (i === S.pick && lid === S.pickLib) return openPicked();
    S.pick = i; S.pickLib = lid;
    $("libList").querySelectorAll("[data-case]").forEach((b) => { const on = +b.dataset.case === i && b.dataset.lid === lid; b.classList.toggle("sel", on); if (on) b.scrollIntoView({ block: "nearest" }); });
    const pv = $("preview"), m = document.querySelector("#openModal .modal").getBoundingClientRect();
    const src = `/api/editor/library/preview?id=${encodeURIComponent(lid)}&index=${i}&t=${Date.now()}`, im = $("previewImg");
    im.dataset.want = src;
    if (pv.hidden || REDUCE) im.src = src;
    else {                                                      // the next image fades in on top of the last one
      const top = $("previewNext");
      top.classList.remove("in"); top.src = src;
      top.decode().catch(() => {}).then(() => {
        if (im.dataset.want !== src) return;
        requestAnimationFrame(() => top.classList.add("in"));
        setTimeout(() => { if (im.dataset.want !== src) return; im.src = src; im.decode().catch(() => {}).then(() => top.classList.remove("in")); }, 300);
      });
    }
    $("previewName").textContent = cases[i].name;
    pv.hidden = false;
    pv.style.left = Math.min(m.right + 16, window.innerWidth - 312) + "px";      // beside the dialog, with a gap
    pv.style.top = Math.max(12, Math.min(m.top + 96, window.innerHeight - 370)) + "px";
  }
  async function openPicked() {
    const i = S.pick, lid = S.pickLib; if (i == null) return;
    S.pick = null; $("preview").hidden = true;
    if (!S.lib || lid !== S.lib.id) {                          // an image of another library: switch to it
      $("libErr").textContent = "Opening…";
      try { S.libShut = false; await useLibrary(lid, i); $("openModal").classList.remove("show"); $("libErr").textContent = ""; }
      catch (e) { $("libErr").textContent = e.message; }
      return;
    }
    $("openModal").classList.remove("show");
    await openCase(i);
  }
  async function toggleLib(id) {                                // show or hide a library's images, without opening it
    S.pick = null; $("preview").hidden = true;
    const old = $("libList").querySelector(".cases");
    if (old) { await collapse(old); old.style.display = "none"; }   // stays closed while the list is redrawn
    S.libOpen = S.libOpen === id ? null : id;
    if (S.lib && id === S.lib.id) S.libShut = S.libOpen !== id;
    if (S.libOpen && !casesOf(S.libOpen)) {
      try { S.libCases[S.libOpen] = (await api("/api/editor/library?id=" + encodeURIComponent(S.libOpen))).cases; } catch (e) { $("libErr").textContent = e.message; S.libOpen = null; }
    }
    await renderLibraries();
    const now = $("libList").querySelector(".cases");
    if (now) await expand(now);
  }
  async function renderLibraries() {
    let j; try { j = await api("/api/editor/libraries"); } catch (e) { $("libErr").textContent = e.message; return; }
    const cur = S.lib && S.lib.id;
    const shown = j.libraries.filter((l) => !l.hidden), hidden = j.libraries.filter((l) => l.hidden);
    $("libList").innerHTML = (shown.length ? shown.map((l) => `
      <div class="li ${l.id === cur ? "current" : ""} ${l.id === S.libOpen ? "open" : "shut"}" data-lib="${esc(l.id)}" title="Click to show or hide its images">
        <svg class="chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg><span class="q-name" data-name>${esc(l.name)}</span>
        <span class="meta">${l.count} image${l.count === 1 ? "" : "s"}${l.done ? ` · ${l.done} done` : ""}${l.edited ? ` · ${l.edited} edited` : ""}</span>
        ${l.id === cur ? '<span class="tag cur">Current</span>' : ""}
        <button class="btn" data-act="rename">Rename</button>
        ${l.id === "practice" ? `<button class="btn" data-act="${l.hidden ? "show" : "hide"}" title="The practice images stay for the tour; hiding them only takes them off this list">${l.hidden ? "Show" : "Hide"}</button>` : '<button class="btn danger" data-act="delete">Delete</button>'}
      </div>${l.id === S.libOpen && casesOf(l.id) ? `<div class="cases">${casesOf(l.id).map((c, i) => `<button class="${l.id === cur && i === S.caseIndex ? "on" : ""} ${l.id === S.pickLib && i === S.pick ? "sel" : ""}" data-case="${i}" data-lid="${esc(l.id)}"><span class="q-name">${esc(c.name)}</span>${c.done ? '<span class="tag done">done</span>' : c.edited ? '<span class="tag">edited</span>' : ""}</button>`).join("")}</div>` : ""}`).join("")
      : '<p class="note">No libraries yet. Import a folder of images below.</p>')
      + (hidden.length ? `<p class="note lib-hidden">${hidden.map((l) => `<button class="link" data-show="${esc(l.id)}" type="button">Show ${esc(l.name.toLowerCase())}</button>`).join(" · ")}</p>` : "");
    $("libList").querySelectorAll("[data-show]").forEach((b) => (b.onclick = async () => { try { await api("/api/editor/library/hide", { id: b.dataset.show, hidden: false }); renderLibraries(); } catch (e) { $("libErr").textContent = e.message; } }));
    $("libList").querySelectorAll("[data-case]").forEach((b) => {
      b.onclick = () => pickCase(+b.dataset.case, b.dataset.lid);
      b.ondblclick = () => { if (S.pick !== +b.dataset.case || S.pickLib !== b.dataset.lid) { S.pick = +b.dataset.case; S.pickLib = b.dataset.lid; } openPicked(); };
    });
    if (S.pick == null) $("preview").hidden = true;
    $("libList").querySelectorAll(".li").forEach((row) => (row.onclick = (e) => { if (e.target.closest("button, input")) return; toggleLib(row.dataset.lib); }));
    $("libList").querySelectorAll("[data-act]").forEach((b) => (b.onclick = async () => {
      const row = b.closest("[data-lib]"), id = row.dataset.lib, act = b.dataset.act;
      try {
        if (act === "hide" || act === "show") { await api("/api/editor/library/hide", { id, hidden: act === "hide" }); if (act === "hide" && S.libOpen === id) S.libOpen = null; renderLibraries(); }
        else if (act === "use") { $("libErr").textContent = "Opening…"; S.libShut = false; await useLibrary(id); $("openModal").classList.remove("show"); }
        else if (act === "rename") {
          const span = row.querySelector("[data-name]"), inp = document.createElement("input");
          inp.type = "text"; inp.value = span.textContent; inp.style.flex = "1"; span.replaceWith(inp); inp.focus(); inp.select();
          b.textContent = "Save";
          const done = async () => { await api("/api/editor/library/rename", { id, name: inp.value }); if (S.lib && S.lib.id === id) { S.lib.name = inp.value.trim() || S.lib.name; renderNav(); } renderLibraries(); };
          b.onclick = done; inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") done(); if (e.key === "Escape") renderLibraries(); };
        } else if (act === "delete") {
          if (b.dataset.sure) {
            await api("/api/editor/library/delete", { id });
            if (S.lib && S.lib.id === id) closeImage();
            renderLibraries();
          } else { b.dataset.sure = "1"; b.textContent = "Delete for good?"; setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = "Delete"; } }, 4000); }
        }
      } catch (e) { $("libErr").textContent = e.message; }
    }));
  }
  function closeImage() {
    clearTimeout(saveTimer); savePending = false;
    Object.assign(S, { sid: null, meta: null, img: null, heat: null, regions: [], selected: null, draft: null, lib: null, caseIndex: -1, undo: [], redo: [] });
    $("sessionName").textContent = "No image open"; $("empty").style.display = ""; $("export").disabled = true; $("saved").textContent = "";
    store.set("seg-editor-lib", ""); renderNav(); refresh();
  }
  /* files: [{path, file}] from a folder, or zip: a File. */
  /* Uploads: a bar for the bytes sent (all files together), then a moving bar while the server reads them.
     The same box then grows smoothly into what was found. */
  let upCtl = null;                                              // the upload under way: {cancelled, xhr}
  const CANCELLED = "Upload cancelled.";
  const checkCancel = () => { if (upCtl && upCtl.cancelled) throw new Error(CANCELLED); };
  function xhrPut(url, file, onProgress) {
    return new Promise((ok, bad) => {
      const x = new XMLHttpRequest();
      if (upCtl) upCtl.xhr = x;
      x.onabort = () => bad(new Error(CANCELLED));
      x.open("POST", url);
      x.upload.onprogress = (e) => onProgress(e.loaded);
      x.onload = () => (x.status < 300 ? ok() : bad(new Error((() => { try { return JSON.parse(x.responseText).error; } catch (e) { return ""; } })() || "Upload failed: " + file.name)));
      x.onerror = () => bad(new Error("Upload failed: " + file.name));
      x.send(file);
    });
  }
  async function putAll(urlFor, list, bar) {
    const total = list.reduce((a, x) => a + x.file.size, 0) || 1;
    let done = 0;
    for (const x of list) {
      checkCancel();
      await xhrPut(urlFor(x.path) + (x.head ? "&head=" + x.head : ""), x.file, (l) => bar && bar.set((done + l) / total));
      done += x.file.size; if (bar) bar.set(done / total);
    }
  }
  /* Upload in two passes. A big image file first goes up as its first 2 MB: the server reads its size and any ImageJ
     outlines from that, and works out which files are the image and the model's output. Only the files chosen are
     then sent in full (for a model's output folder with a large original, ~20 MB instead of ~160 MB). */
  const HEAD_BYTES = 2 * 1024 * 1024, HEAD_OVER = 4 * 1024 * 1024;
  const firstPass = (list) => list.map((x) => (x.file.size > HEAD_OVER && /\.(tiff?|png|jpe?g)$/i.test(x.path)
    ? { path: x.path, file: x.file.slice(0, HEAD_BYTES), head: x.file.size } : x));
  async function sendInFull(needs, files, urlFor, bar) {
    const byPath = new Map(files.map((x) => [x.path, x.file]));
    const list = needs.map((n) => ({ path: n.path, file: byPath.get(n.path) })).filter((x) => x.file);
    if (list.length) await putAll(urlFor, list, bar);
  }
  function grower(boxId, innerId) {                            // a box whose height follows its contents, animated
    const box = $(boxId), inner = $(innerId);
    const fit = (from) => {
      const to = inner.getBoundingClientRect().height + 2;
      box.style.height = from + "px"; void box.offsetHeight; box.style.height = to + "px";
      const end = () => { box.style.height = ""; box.removeEventListener("transitionend", end); };
      box.addEventListener("transitionend", end); setTimeout(end, 500);
    };
    return {
      show(html, wire) {
        const fresh = box.hidden, from = fresh ? 0 : box.getBoundingClientRect().height;
        const swap = () => { inner.innerHTML = html; if (wire) wire(); box.hidden = false; fit(from); requestAnimationFrame(() => inner.classList.remove("fading")); };
        if (fresh) { inner.classList.add("fading"); swap(); } else { inner.classList.add("fading"); setTimeout(swap, 170); }
      },
      hide() {
        if (box.hidden) return;
        box.style.height = box.getBoundingClientRect().height + "px"; void box.offsetHeight; box.style.height = "0px";
        inner.classList.add("fading");
        setTimeout(() => { box.hidden = true; box.style.height = ""; inner.innerHTML = ""; }, 330);
      },
    };
  }
  const barHtml = (key, name) => `<div class="up"><div class="up-top"><b>${esc(name)}</b><span class="up-r"><span id="${key}Pct">Uploading 0%</span><button class="up-x" id="${key}Stop" type="button">Cancel</button></span></div><div class="up-bar" id="${key}Bar"><i></i></div></div>`;
  /* Cancel stops the file being sent at once (the request is aborted); the page then waits for anything the
     server is already doing and deletes what was sent. */
  const startUpload = (key) => {
    const ctl = upCtl = { cancelled: false, xhr: null };
    $(key + "Stop").onclick = () => {
      ctl.cancelled = true; if (ctl.xhr) ctl.xhr.abort();
      $(key + "Stop").disabled = true; $(key + "Pct").textContent = "Cancelling…";
    };
    return ctl;
  };
  /* One bar for the whole upload, however many steps it takes: each step fills its own stretch of the bar
     (span), waits creep slowly forward (wait), and the bar never goes back. */
  const barOf = (key) => {
    let shown = 0, lo = 0, hi = 1, timer = null;
    const stop = () => { clearInterval(timer); timer = null; };
    const paint = (f) => {
      shown = Math.max(shown, Math.min(1, f)); const i = $(key + "Bar"); if (!i) return;
      i.firstChild.style.width = (100 * shown).toFixed(1) + "%"; $(key + "Pct").textContent = `Uploading ${Math.floor(100 * shown)}%`;
    };
    return {
      span(a, b) { stop(); lo = Math.max(a, shown); hi = Math.max(b, lo); },
      set(f) { stop(); paint(lo + f * (hi - lo)); },
      wait(to) { stop(); timer = setInterval(() => paint(shown + (to - shown) * 0.04), 100); },
      done() { stop(); paint(1); },
    };
  };
  /* A guess at what the second pass will send, so the first pass gets a fair share of the bar: for each folder,
     the smallest big TIFF (the model's image; the original is larger and is never sent in full). */
  const restGuess = (files) => {
    const by = new Map();
    for (const x of files) {
      if (!(x.file.size > HEAD_OVER && /\.(tiff?|png|jpe?g)$/i.test(x.path))) continue;
      const dir = x.path.split("/").slice(0, -1).join("/"), tif = /\.tiff?$/i.test(x.path), c = by.get(dir);
      if (!c || (tif && !c.tif) || (tif === c.tif && x.file.size < c.size)) by.set(dir, { size: x.file.size, tif });
    }
    return [...by.values()].reduce((a, v) => a + v.size, 0);
  };
  // Send the files: heads first, the server reads them, then the chosen files in full. One bar throughout.
  async function sendFiles(bar, first, files, url, scan, rescan) {
    const P = first.reduce((a, x) => a + x.file.size, 0), E = first.some((x) => x.head) ? restGuess(files) : 0;
    const a = 0.92 * P / (P + E || 1);
    bar.span(0, a); await putAll(url, first, bar);
    bar.wait(a + 0.04 * (1 - a));
    let j = await scan(); checkCancel();
    for (let round = 0; round < 2 && j.needs && j.needs.length; round++) {   // the chosen big files, now in full
      bar.span(0, round ? 0.985 : 0.96); await sendInFull(j.needs, files, url, bar);
      bar.wait(0.995); j = await rescan(); checkCancel();
    }
    bar.done();
    return j;
  }
  const choiceRows = (opts, chosen, ids) => {
    const base = (f) => f.split("/").pop();                        // the file's own name; the folder is shown above
    const row = (label, id, items, cur) => `<label class="pk-row"><span>${label}</span>${items.length > 1
      ? `<select id="${id}">${items.map((f) => `<option value="${esc(f)}" ${f === cur ? "selected" : ""}>${esc(base(f))}</option>`).join("")}</select>`
      : `<span class="fixed">${esc(cur ? base(cur) : "–")}</span>`}</label>`;
    return row("Outlines from", ids[0], opts.outlines.map((o) => o.file), chosen.outlines) + row("Image", ids[1], opts.image, chosen.image);
  };
  const dropFiles = (files) => (files || []).filter((x) => !x.path.split("/").some((part) => part.startsWith(".")));

  /* A library: upload, then a panel over the dialog lists every image with the files it is made from, any of
     which can be changed, and Accept. */
  const libBox = grower("libProg", "libProgIn");
  async function importLibrary(files, zip, name) {
    const err = $("libErr"); err.textContent = "";
    files = dropFiles(files);
    if (!files.length && !zip) { err.textContent = "Nothing to import in that."; return; }
    libBox.show(barHtml("lib", name || "Library"));
    const bar = barOf("lib"), ctl = startUpload("lib");
    let id = null;
    try {
      id = (await api("/api/editor/library/begin", { name: name || "Library" })).id; checkCancel();
      const url = (p) => `/api/editor/library/put?id=${encodeURIComponent(id)}&path=${encodeURIComponent(p)}`;
      const j = await sendFiles(bar, zip ? [{ path: "__library__.zip", file: zip }] : firstPass(files), files, url,
        () => api("/api/editor/library/finish", { id }), () => api("/api/editor/library/rescan", { id }));
      libBox.hide();
      await showReview(id, j.skipped, (needs) => sendInFull(needs, files, url, null));
    } catch (e) {
      libBox.hide();
      if (ctl.cancelled) { if (id) api("/api/editor/library/delete", { id }).catch(() => {}); return; }
      err.textContent = e.message;
    }
  }
  async function showReview(id, skipped, send) {
    const lib = await api("/api/editor/library?id=" + encodeURIComponent(id));
    const accept = async () => {                                  // stays up, saying so, until the first image is open
      const btns = [...document.querySelectorAll("#libReview [data-accept]")];
      btns.forEach((b) => { b.disabled = true; b.textContent = "Opening…"; });
      try {
        S.libShut = false; await useLibrary(id, 0);
        $("openModal").classList.remove("show");
        const rv = $("libReview"); rv.classList.add("closing");
        setTimeout(() => { rv.hidden = true; rv.classList.remove("closing"); }, 220);
      } catch (e) { $("revErr").textContent = e.message; }
      btns.forEach((b) => { b.disabled = false; b.textContent = "Accept"; });
    };
    if (!lib.cases.some((c) => c.choosable)) { try { S.libShut = false; await useLibrary(id, 0); $("openModal").classList.remove("show"); } catch (e) { $("libErr").textContent = e.message; } return; }
    $("revTitle").textContent = lib.name;
    const item = (c, i) => `<div class="pk-head"><span>Folder name:</span><b>${esc(c.name)}</b></div>` +
      (c.choosable ? choiceRows(c.options, c.chosen, [`rvOut${i}`, `rvImg${i}`]) : `<span class="note" style="margin:0">Files paired by name</span>`);
    $("revList").innerHTML = lib.cases.map((c, i) => `<div class="rev-item" data-i="${i}">${item(c, i)}</div>`).join("");
    $("revErr").textContent = skipped && skipped.length ? `Skipped: ${skipped.join(", ")}` : "";
    const wire = (el, i) => {
      for (const [sel, key] of [[`#rvOut${i}`, "outlines"], [`#rvImg${i}`, "image"]]) {
        const s = el.querySelector(sel); if (!s) continue;
        s.onchange = async () => {
          el.classList.add("busy");
          try {
            const body = { id, index: i, [key]: s.value };
            if (key === "image") { const o = el.querySelector(`#rvOut${i}`); if (o) body.outlines = o.value; }
            let c = await api("/api/editor/library/choose", body);
            if (c.needs && c.needs.length && send) {              // a file sent only in part so far: send it in full
              $("revErr").textContent = `Uploading ${c.needs.map((n) => n.path.split("/").pop()).join(", ")}…`;
              await send(c.needs);
              c = await api("/api/editor/library/choose", body);
            }
            el.innerHTML = item(c, i); wire(el, i); $("revErr").textContent = "";
          } catch (e) { $("revErr").textContent = e.message; }
          el.classList.remove("busy");
        };
      }
    };
    $("revList").querySelectorAll(".rev-item").forEach((el) => wire(el, +el.dataset.i));
    document.querySelectorAll("#libReview [data-accept]").forEach((b) => (b.onclick = accept));
    $("libReview").hidden = false;
  }
  const stripTop = (list) => {                                 // drop the shared top folder from every path
    const tops = new Set(list.map((x) => x.path.split("/")[0]));
    const one = tops.size === 1 && list.every((x) => x.path.includes("/"));
    return { name: one ? [...tops][0] : "Library", files: one ? list.map((x) => ({ path: x.path.split("/").slice(1).join("/"), file: x.file })) : list };
  };
  async function readEntry(entry, out) {                       // a dropped folder, walked recursively
    if (entry.isFile) { const file = await new Promise((ok, bad) => entry.file(ok, bad)); out.push({ path: entry.fullPath.replace(/^\//, ""), file }); return; }
    const reader = entry.createReader();
    for (;;) { const batch = await new Promise((ok, bad) => reader.readEntries(ok, bad)); if (!batch.length) break; for (const e of batch) await readEntry(e, out); }
  }
  function wireDrop(dropId, dirId, onFolder, onZip, errId) {
    const drop = $(dropId), dir = $(dirId);
    drop.onclick = (e) => { if (!e.target.closest("button")) dir.click(); };
    drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); dir.click(); } };
    dir.onchange = () => { const l = [...dir.files].map((f) => ({ path: f.webkitRelativePath || f.name, file: f })); dir.value = ""; onFolder(l); };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = async (e) => {
      e.preventDefault(); drop.classList.remove("over");
      const items = [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
      const lone = e.dataTransfer.files.length === 1 ? e.dataTransfer.files[0] : null;
      if (lone && /\.zip$/i.test(lone.name) && items.length === 1 && items[0].isFile) return onZip(lone);
      const out = []; try { for (const en of items) await readEntry(en, out); } catch (err) { $(errId).textContent = "Could not read that folder."; return; }
      onFolder(out);
    };
  }
  function wireLibraryDrop() {
    wireDrop("libDrop", "f_lib_dir", (l) => { const s = stripTop(l); importLibrary(s.files, null, s.name); },
      (z) => importLibrary(null, z, z.name.replace(/\.zip$/i, "")), "libErr");
    const zip = $("f_lib_zip");
    $("libZip").onclick = (e) => { e.stopPropagation(); zip.click(); };
    zip.onchange = () => { const f = zip.files[0]; zip.value = ""; if (f) importLibrary(null, f, f.name.replace(/\.zip$/i, "")); };
  }

  /* Single image: one image's folder (or a .zip of it). The server works out which file is the image and which
     holds the model's output, by what is in them; the choice is shown and can be changed. */
  let oneId = null, oneSend = null;
  const oneBox = grower("onePick", "onePickIn");
  async function uploadOne(files, zip) {
    const err = $("importErr"); err.textContent = "";
    files = dropFiles(files);
    if (!files.length && !zip) { err.textContent = "Nothing to open in that."; return; }
    const name = zip ? zip.name.replace(/\.zip$/i, "") : files[0].path.includes("/") ? files[0].path.split("/")[0] : files[0].path;
    oneBox.show(barHtml("one", name));
    const bar = barOf("one"), ctl = startUpload("one");
    try {
      oneId = (await api("/api/editor/bundle/begin", {})).id; checkCancel();
      const id = oneId, url = (p) => `/api/editor/bundle/put?id=${encodeURIComponent(id)}&path=${encodeURIComponent(p)}`;
      oneSend = (needs, b) => sendInFull(needs, zip ? [] : files, url, b);
      const scan = () => api("/api/editor/bundle/scan", { id });
      showPicks(await sendFiles(bar, zip ? [{ path: zip.name, file: zip }] : firstPass(files), zip ? [] : files, url, scan, scan));
    } catch (e) {
      oneBox.hide();
      if (ctl.cancelled) { if (oneId) api("/api/editor/bundle/discard", { id: oneId }).catch(() => {}); oneId = null; return; }
      oneId = null; err.textContent = e.message;
    }
  }
  function showPicks(b) {
    const choice = () => ({ id: oneId, outlines: $("pkOut") ? $("pkOut").value : b.chosen.outlines, image: $("pkImg") ? $("pkImg").value : b.chosen.image });
    oneBox.show(`<div class="pk-head"><span>Folder name:</span><b>${esc(b.name)}</b><button class="btn" id="pkRemove">Remove</button></div>
      ${choiceRows(b.options, b.chosen, ["pkOut", "pkImg"])}
      <div class="actions"><button class="btn primary" id="pkOpen">Open</button></div>`, () => {
      const rescan = async (body) => {
        try {
          $("importErr").textContent = "";
          let nb = await api("/api/editor/bundle/scan", body);
          if (nb.needs && nb.needs.length && oneSend) {           // a file sent only in part so far: send it in full
            $("importErr").textContent = `Uploading ${nb.needs.map((n) => n.path.split("/").pop()).join(", ")}…`;
            await oneSend(nb.needs, null);
            nb = await api("/api/editor/bundle/scan", body);
            $("importErr").textContent = "";
          }
          showPicks(nb);
        } catch (e) { $("importErr").textContent = e.message; }
      };
      if ($("pkOut")) $("pkOut").onchange = () => rescan({ id: oneId, outlines: $("pkOut").value });
      if ($("pkImg")) $("pkImg").onchange = () => rescan(choice());
      $("pkRemove").onclick = () => { oneId = null; oneBox.hide(); $("importErr").textContent = ""; };
      $("pkOpen").onclick = async () => {
        $("pkOpen").disabled = true; $("pkOpen").textContent = "Opening…";
        try {
          const j = await api("/api/editor/bundle/open", choice());
          oneId = null; oneBox.hide();
          await useLibrary(j.library, j.index);
          $("openModal").classList.remove("show"); $("importErr").textContent = "";
        } catch (e) { $("importErr").textContent = e.message; if ($("pkOpen")) { $("pkOpen").disabled = false; $("pkOpen").textContent = "Open"; } }
      };
    });
  }
  function wireOneDrop() {
    wireDrop("oneDrop", "f_one_dir", (l) => uploadOne(l), (z) => uploadOne(null, z), "importErr");
  }
  function setTab(name) {
    document.querySelectorAll("#openTabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    document.querySelectorAll("#openModal [data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== name));
    if (name !== "libs") { S.pick = null; $("preview").hidden = true; }
  }
  async function upload(input) {
    const f = $(input).files[0]; if (!f) return null;
    const r = await fetch("/api/editor/upload?name=" + encodeURIComponent(f.name), { method: "POST", body: f });
    if (!r.ok) throw new Error("Upload failed: " + f.name);
    return (await r.json()).token;
  }
  /* One-off import: lands in the "Single imports" library. */
  async function doImport(route) {
    const err = $("importErr"); err.textContent = "Uploading…";
    try {
      const card = route;                                       // "tif" is the ImageJ route with one file
      if (card === "tif") route = "imagej";
      const spec = { model: { image: "f_model_image", model: "f_model_out" }, screenshot: { overlay: "f_shot_overlay", image: "f_shot_image" },
        imagej: { imagej: "f_ij_image", rois: "f_ij_rois" }, tif: { imagej: "f_tif" } }[card];
      const files = {};
      for (const [role, id] of Object.entries(spec)) { const t = await upload(id); if (t) files[role] = t; }
      const main = $({ model: "f_model_out", screenshot: "f_shot_overlay", imagej: "f_ij_image", tif: "f_tif" }[card]).files[0];
      if (!main) throw new Error("Choose a file first.");
      if (card === "imagej" && !files.rois) throw new Error("Add the outlines file too. An ImageJ .tif with its outlines inside goes in ImageJ file.");
      if (card === "screenshot" && !files.image) throw new Error("Add the original image too. The shading is found by comparing the two.");
      if (card === "model" && !files.image) throw new Error("Add the original image too.");
      const j = await api("/api/editor/import", { route, files, name: main.name.replace(/\.[^.]+$/, ""), threshold: +$("f_model_thr").value || 0.5 });
      await useLibrary(j.library, j.index);
      $("openModal").classList.remove("show"); err.textContent = "";
    } catch (e) { err.textContent = e.message; }
  }

  /* ---------------- wiring ---------------- */
  $("prevCase").onclick = () => openCase(S.caseIndex - 1); $("nextCase").onclick = () => openCase(S.caseIndex + 1);
  wireLibraryDrop(); wireOneDrop(); $("doneBtn").onclick = toggleDone;
  document.querySelectorAll("details.more").forEach(wireDetails);
  smoothResize(document.querySelector("#openModal .modal"), document.querySelector("#openModal .modal"));
  smoothResize(document.querySelector("#exportModal .modal"), $("exportBody"));
  $("open").onclick = showOpen; $("openEmpty").onclick = showOpen; $("export").onclick = () => showExport();
  $("undo").onclick = undo; $("redo").onclick = redo;
  $("zoomIn").onclick = () => zoomAt(1.25); $("zoomOut").onclick = () => zoomAt(0.8); $("fit").onclick = fitView;
  /* Rename in place: a text box laid exactly over the name. (The row is a button, and the click before a
     double-click redraws the list, so the box sits over the fresh row, not inside it.) */
  function renameRegion(id) {
    const r = region(id), q = $("queue"), row = q.querySelector(`.q-item[data-id="${CSS.escape(id)}"]`), span = row && row.querySelector(".q-name");
    if (!r || !span || q.querySelector(".q-rename")) return;
    const qb = q.getBoundingClientRect(), b = span.getBoundingClientRect(), rb = row.getBoundingClientRect();
    const inp = document.createElement("input");
    inp.type = "text"; inp.className = "q-rename" + (row.classList.contains("on") ? " on" : ""); inp.value = r.name; inp.maxLength = 40; inp.spellcheck = false; inp.setAttribute("aria-label", "Region name");
    Object.assign(inp.style, { left: b.left - qb.left + "px", top: rb.top - qb.top + q.scrollTop + "px", width: rb.right - b.left - 12 + "px", height: rb.height + "px" });
    span.style.visibility = "hidden"; q.appendChild(inp); inp.focus(); inp.select();
    let over = false;
    const finish = (keep) => {
      if (over) return; over = true;
      const v = inp.value.replace(/\s+/g, " ").trim(); inp.remove();
      if (keep && v && v !== r.name) { pushUndo(); r.name = v; refresh(true); } else renderPanel();
    };
    inp.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter") finish(true); else if (ev.key === "Escape") finish(false); };
    inp.onblur = () => finish(true);
    inp.onpointerdown = inp.onclick = inp.ondblclick = (ev) => ev.stopPropagation();
  }
  $("queue").addEventListener("dblclick", (e) => {
    const item = e.target.closest(".q-item"); if (!item || e.target.closest(".q-rename")) return;
    const id = item.dataset.id; setTimeout(() => renameRegion(id), 0);       // after the click's redraw
  });
  $("delRegion").onclick = deleteSelected; $("navPrev").onclick = () => step(-1); $("navNext").onclick = () => step(1);
  $("toolEdit").onclick = () => setTool("edit"); $("toolDraw").onclick = () => setTool("draw"); $("toolLabel").onclick = () => setTool("label"); $("toolRuler").onclick = () => setTool("ruler");
  $("sbInfo").onclick = () => toast("The slider re-cuts a region from the model's output. This region was drawn, split or merged, so use Grow and Shrink.");
  $("slider").oninput = (e) => slide(+e.target.value);
  $("slider").onchange = () => { sliderArmed = false; setTimeout(() => refresh(true), 250); };
  $("sliderReset").onclick = () => { sliderArmed = false; slide(S.meta.threshold).then(() => { sliderArmed = false; refresh(true); }); };
  $("shapeBar").addEventListener("click", (e) => { const b = e.target.closest("[data-op]"); if (b) shapeOp(b.dataset.op); });
  document.querySelectorAll(".side [data-fold]").forEach((b) => {   // Display, Regions and Measure fold away
    const sec = b.closest(".sec"), key = "seg-editor-fold-" + b.dataset.fold;
    if (store.get(key) === "shut") sec.classList.add("shut");
    const body = sec.querySelector(":scope > .sec-b");
    b.onclick = async () => {
      if (sec.classList.contains("shut")) { sec.classList.remove("shut", "folding"); store.set(key, "open"); await expand(body); }
      else { sec.classList.add("shut", "folding"); store.set(key, "shut"); await collapse(body); if (sec.classList.contains("shut")) sec.classList.remove("folding"); }
    };
  });
  $("labelPop").addEventListener("click", (e) => {
    const r = region(S.labelFor); if (!r) return;
    const row = e.target.closest("[data-cls]");
    if (row) { setClass(r, row.dataset.cls); closeLabel(); }
    else if (e.target.closest("#popUnsure")) toggleUnsure(r);
    else if (e.target.closest("#popEdit")) { closeLabel(); showClasses(); }
  });
  $("classRows").addEventListener("input", (e) => {
    const row = e.target.closest(".cls-row"); if (!row) return;
    const c = draftClasses[+row.dataset.i];
    if (e.target.type === "checkbox") c.exclude = e.target.checked; else c.name = e.target.value;
  });
  $("classRows").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]"); if (!rm) return;
    draftClasses.splice(+rm.closest(".cls-row").dataset.i, 1); renderClasses();
  });
  $("classAdd").onclick = () => {
    const free = PALETTE.find((p) => !draftClasses.some((c) => String(c.color) === String(p))) || PALETTE[draftClasses.length % PALETTE.length];
    draftClasses.push({ id: "c" + Date.now().toString(36), name: "", color: free }); renderClasses();
    const inputs = $("classRows").querySelectorAll("input[type=text]"); inputs[inputs.length - 1].focus();
  };
  $("classSave").onclick = saveClasses;
  $("opacity").oninput = (e) => { S.opacity = +e.target.value; draw(); };
  $("showModel").onchange = (e) => { S.showModel = e.target.checked; draw(); };
  $("showHeat").onchange = (e) => { S.showHeat = e.target.checked; draw(); };
  $("keysBtn").onclick = () => $("keysModal").classList.add("show");
  if (!MAC) document.querySelectorAll("[data-mod]").forEach((e) => { e.textContent = { "⌘Z": "Ctrl+Z", "⇧⌘Z": "Ctrl+Shift+Z", "⌘": "Ctrl" }[e.textContent] || e.textContent; });
  $("undo").title = `Undo (${MOD}${MAC ? "" : "+"}Z)`; $("redo").title = MAC ? "Redo (⇧⌘Z)" : "Redo (Ctrl+Shift+Z or Ctrl+Y)";
  $("tutBtn").onclick = () => window.Tutorial.open(); $("tutEmpty").onclick = () => window.Tutorial.open();
  const tour = () => window.Tour.start().then((ok) => { if (!ok) window.Tutorial.open(); });   // no practice image, or a small window: the panel instead
  $("tourBtn").onclick = () => { $("tutModal").classList.remove("show"); window.Tutorial.pause(); tour(); };
  document.querySelectorAll("#openTabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  document.querySelectorAll("[data-import]").forEach((b) => (b.onclick = () => doImport(b.dataset.import)));
  /* each "by hand" Open needs its files first */
  const NEEDS = { model: ["f_model_image", "f_model_out"], tif: ["f_tif"], screenshot: ["f_shot_overlay", "f_shot_image"], imagej: ["f_ij_image", "f_ij_rois"] };
  const readyCheck = () => Object.entries(NEEDS).forEach(([k, ids]) => { const b = document.querySelector(`[data-import="${k}"]`); if (b) b.disabled = !ids.every((id) => $(id).files.length); });
  Object.values(NEEDS).flat().forEach((id) => $(id).addEventListener("change", readyCheck)); readyCheck();
  document.querySelectorAll(".backdrop").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) { m.classList.remove("show"); window.Tutorial.pause(); } }));
  $("theme").onclick = () => {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches, cur = document.documentElement.dataset.theme || (dark ? "dark" : "light");
    const nxt = cur === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = nxt;
    try { localStorage.setItem("seg-editor-theme", nxt); } catch (e) {} draw();
  };
  document.documentElement.dataset.theme = "light";         // starts light whatever the computer is set to; the moon button switches
  try { const t = localStorage.getItem("seg-editor-theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}

  window.addEventListener("keydown", (e) => {
    if (e.target && e.target.matches && e.target.matches("input[type=number], input[type=text], textarea")) return;
    if (e.target && e.target.isContentEditable) return;
    if (e.key === "[") { openCase(S.caseIndex - 1); return; } if (e.key === "]") { openCase(S.caseIndex + 1); return; }
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if ($("openModal").classList.contains("show") && S.pick != null && ["Enter", "ArrowDown", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "Enter") openPicked(); else pickCase(Math.min(casesOf(S.pickLib).length - 1, Math.max(0, S.pick + (e.key === "ArrowDown" ? 1 : -1))), S.pickLib);
      return;
    }
    if (document.querySelector(".backdrop.show")) { if (e.key === "Escape") { document.querySelectorAll(".backdrop.show").forEach((m) => m.classList.remove("show")); window.Tutorial.pause(); } return; }
    if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === "y") { e.preventDefault(); redo(); return; }
    if (mod) return;
    if (e.key === " ") { S.space = true; cv.style.cursor = "grab"; e.preventDefault(); return; }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !(e.target && e.target.matches && e.target.matches("input, select"))) { e.preventDefault(); openCase(S.caseIndex + (e.key === "ArrowRight" ? 1 : -1)); return; }
    if (/^[1-9]$/.test(e.key)) {                                // with the label menu open: the class. Otherwise 1 to 4: the tool
      if (S.labelFor) { const r = region(S.labelFor), c = S.classes[+e.key - 1]; if (r && c) { setClass(r, c.id); closeLabel(); } return; }
      const t = ["edit", "draw", "label", "ruler"][+e.key - 1]; if (t) setTool(t);
      return;
    }
    if (k === "u" && region(S.selected)) { toggleUnsure(region(S.selected)); return; }
    if (k === "x") { if (!S.peek) { S.peek = true; draw(); } return; }
    if (k === "v") setTool("edit"); else if (k === "p") setTool("draw"); else if (k === "l") setTool("label"); else if (k === "r") setTool("ruler");
    else if (k === "n") step(e.shiftKey ? -1 : 1);
    else if (k === "d") toggleDone();
    else if (k === "m") { S.showModel = !S.showModel; $("showModel").checked = S.showModel; draw(); }
    else if (k === "h" && S.meta && S.meta.has_prob) { S.showHeat = !S.showHeat; $("showHeat").checked = S.showHeat; draw(); }
    else if (k === "+" || k === "=") zoomAt(1.25); else if (k === "-") zoomAt(0.8); else if (k === "0") fitView();
    else if (k === "?") $("keysModal").classList.add("show");
    else if (e.key === "Enter" && S.draft) finishDraft(false);
    else if (e.key === "Escape") { if (S.labelFor) closeLabel(); else if (S.pickOp) S.pickOp = null; else if (S.ruler) S.ruler = null; else if (S.stroke) S.stroke = null; else if (S.draft) { pushUndo(); S.draft = null; } else S.selected = null; refresh(); }
    else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      if (S.draft) { pushUndo(); const d = S.draft; if (d.segs.length) { d.segs.pop(); d.nodes.pop(); } else S.draft = null; refresh(); }
      else deleteSelected();
    }
  });
  window.addEventListener("keyup", (e) => { if (e.key.toLowerCase() === "x" && S.peek) { S.peek = false; draw(); } if (e.key === " ") { S.space = false; cv.style.cursor = S.tool === "draw" ? "crosshair" : "default"; } });
  new ResizeObserver(resize).observe(stage);

  resize(); renderPanel(); renderHint();
  // The practice images open by themselves the first time; after that, whatever was open last.
  const q = new URLSearchParams(location.search), wantLib = q.get("lib") ?? store.get("seg-editor-lib") ?? "practice";
  if (wantLib) window.__ready = useLibrary(wantLib, q.has("i") ? +q.get("i") : null).catch(() => closeImage());
  renderNav();
  api("/api/editor/settings").then((st) => { S.hosted = !!st.hosted; document.documentElement.classList.toggle("hosted", S.hosted); }).catch(() => {})
    .then(() => window.__ready)
    .then(() => {                                               // a first visit starts with the tour
      if (store.get("seg-editor-welcomed") || q.has("selftest")) return;
      store.set("seg-editor-welcomed", "1"); tour();
    });
  window.__editor = { S, draw, fitView, saveNow, modelRegions, toggleDone, showExport, runExport, pickCase, uploadOne, importLibrary, selHole, openSession, openCase, useLibrary, refresh, slide, setTool, step, undo, region, inside, setClass, openLabel, showClasses, shapeOp, serverShape, measures, renderBar, labelPoint };   // for selftest.js
  if (new URLSearchParams(location.search).has("selftest")) { const sc = document.createElement("script"); sc.src = "/viewer/editor/selftest.js"; document.body.appendChild(sc); }
})();
