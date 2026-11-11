/* Segmentation editor: canvas app. Geometry lives in geom.js (window.G). */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const cv = $("cv"), ctx = cv.getContext("2d"), stage = $("stage");
  const HIT = 9;            // screen px: how close counts as "on" a node or a line
  const CLOSE = 14;         // screen px: finishing this near the start closes a shape
  const FIT_TOL = 3;        // image px: how closely fitted curves follow the model's outline
  const BLUE = [10, 80, 235];

  const S = {
    sid: null, meta: null, img: null, heat: null,
    regions: [], selected: null, tool: "edit", draft: null, stroke: null, drag: null,
    view: { s: 1, x: 0, y: 0 }, undo: [], redo: [], counter: 0,
    opacity: 0.4, showModel: false, showHeat: false, space: false, hover: null,
    lib: null, caseIndex: -1, hole: null, pick: null,
  };

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
  const fitRings = (rings) => rings.map((r) => G.fitClosed(pts(r), FIT_TOL)).filter((p) => p.nodes.length >= 1 && p.segs.length >= 1);

  async function openSession(sid) {
    const { meta, state } = await api("/api/editor/session?id=" + encodeURIComponent(sid));
    const [img, score] = await Promise.all([
      loadImage(`/sessions/${sid}/tissue.png`),
      meta.has_prob ? loadImage("/api/editor/score.png?id=" + encodeURIComponent(sid)) : Promise.resolve(null),
    ]);
    Object.assign(S, { sid, meta, img, heat: score ? heatLayer(score) : null, selected: null, draft: null, stroke: null, drag: null, undo: [], redo: [] });
    if (state && state.regions) { S.regions = state.regions; S.counter = state.counter || 0; }
    else {
      S.counter = 0;
      S.regions = meta.regions.map((r) => ({
        id: "m" + r.label, name: r.name, source: "model", label: r.label,
        t: meta.threshold, meanProb: r.mean_prob, edited: false, paths: fitRings(r.rings),
      })).filter((r) => r.paths.length);
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
  function heatLayer(scoreImg) {
    const c = document.createElement("canvas"); c.width = scoreImg.width; c.height = scoreImg.height;
    const x = c.getContext("2d"); x.drawImage(scoreImg, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height), a = d.data;
    for (let i = 0; i < a.length; i += 4) { const p = a[i]; a[i] = BLUE[0]; a[i + 1] = BLUE[1]; a[i + 2] = BLUE[2]; a[i + 3] = Math.round(p * 0.75); }
    x.putImageData(d, 0, 0);
    return c;
  }

  /* ---------------- undo + save ---------------- */
  const strip = (r) => { const o = Object.assign({}, r); delete o._p; return o; };
  const snapshot = () => JSON.stringify({ regions: S.regions.map(strip), draft: S.draft, selected: S.selected, counter: S.counter });
  function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > 120) S.undo.shift(); S.redo = []; }
  function restore(json) { S.hole = null; const o = JSON.parse(json); S.regions = o.regions; S.draft = o.draft; S.selected = o.selected; S.counter = o.counter; S.stroke = null; S.drag = null; }
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
    if (!S.sid) return;
    savePending = true; $("saved").textContent = "Saving…";
    clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 700);
  }
  /* Call after any change to regions. */
  function refresh(dirty) {
    for (const r of S.regions) r._p = null;
    if (S.selected && !region(S.selected)) S.selected = null;
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
    const s = Math.min(40, Math.max(0.05, S.view.s * f)), k = s / S.view.s;
    S.view = { s, x: cx - (cx - S.view.x) * k, y: cy - (cy - S.view.y) * k }; S.fitted = false; draw();
  }
  function focusRegion(r) {
    const bb = G.bbox(r.paths), b = stage.getBoundingClientRect(), w = Math.max(bb.x1 - bb.x0, 40), h = Math.max(bb.y1 - bb.y0, 40);
    const s = Math.min(6, Math.min(b.width / w, b.height / h) * 0.55);
    S.view = { s, x: b.width / 2 - (bb.x0 + bb.x1) / 2 * s, y: b.height / 2 - (bb.y0 + bb.y1) / 2 * s }; S.fitted = false; draw();
  }

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

    for (const r of S.regions) {
      const p = regionPath(r), sel = r.id === S.selected;
      ctx.fillStyle = `rgba(${BLUE},${S.showHeat ? S.opacity * 0.35 : S.opacity})`; ctx.fill(p, "evenodd");
      ctx.lineJoin = "round";
      ctx.setLineDash([]); ctx.lineWidth = (sel ? 4.5 : 3.2) * px; ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.stroke(p);
      ctx.lineWidth = (sel ? 2.4 : 1.6) * px; ctx.strokeStyle = "#12307F"; ctx.stroke(p);
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
    if (sel && S.tool === "edit") for (const path of sel.paths) drawHandles(path, px);
    if (S.draft) drawDraft(px);
    if (S.stroke && S.stroke.pts.length > 1) {
      ctx.beginPath(); S.stroke.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.lineWidth = 3.4 * px; ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.stroke();
      ctx.lineWidth = 1.8 * px; ctx.strokeStyle = S.stroke.mode === "reroute" ? "#C2410C" : "#12307F"; ctx.stroke();
    }
    if (S.tool === "draw" && S.hover && !S.stroke) {      // where a reroute would start
      ctx.beginPath(); ctx.arc(S.hover.x, S.hover.y, 5 * px, 0, 7); ctx.fillStyle = "#C2410C"; ctx.fill();
      ctx.lineWidth = 1.5 * px; ctx.strokeStyle = "#fff"; ctx.stroke();
    }
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
  function hitRegion(p) {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    let found = null;
    for (let i = S.regions.length - 1; i >= 0 && !found; i--) if (ctx.isPointInPath(regionPath(S.regions[i]), p.x, p.y, "evenodd")) found = S.regions[i];
    ctx.restore();
    if (!found) for (const r of S.regions) if (hitLine(r, p)) { found = r; break; }
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
  function hitBorder(p) {                                    // for reroute: any outline near the cursor
    let best = null;
    for (const r of S.regions) { const h = hitLine(r, p); if (h && (!best || h.dist < best.dist || r.id === S.selected)) { best = Object.assign({ r }, h); if (r.id === S.selected) break; } }
    return best;
  }

  /* ---------------- pointer ---------------- */
  let panning = null;
  cv.addEventListener("pointerdown", (e) => {
    if (!S.img) return;
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    const p = toImg(e);
    if (e.button === 1 || S.space) { panning = { x: e.clientX, y: e.clientY, vx: S.view.x, vy: S.view.y }; return; }
    if (e.button !== 0) return;
    if (S.tool === "edit") editDown(p, e); else drawDown(p);
    draw();
  });
  cv.addEventListener("pointermove", (e) => {
    if (!S.img) return;
    const p = toImg(e);
    if (panning) { S.view.x = panning.vx + e.clientX - panning.x; S.view.y = panning.vy + e.clientY - panning.y; S.fitted = false; draw(); return; }
    if (S.drag) { dragMove(p); return; }
    if (S.stroke) { strokeMove(p); return; }
    if (S.tool === "draw") { const h = S.draft ? null : hitBorder(p); S.hover = h ? h.point : null; cv.style.cursor = "crosshair"; draw(); }
    else { const sel = region(S.selected); cv.style.cursor = S.space ? "grab" : sel && (hitNode(sel, p) || hitLine(sel, p)) ? "pointer" : hitRegion(p) ? "move" : "default"; }
  });
  const up = (e) => {
    if (panning) { panning = null; return; }
    if (S.drag) { if (S.drag.moved) { const r = region(S.selected); if (r) r.edited = true; refresh(true); } else if (S.drag.pan === undefined) S.undo.pop(); S.drag = null; return; }
    if (S.stroke) strokeUp(toImg(e));
  };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  cv.addEventListener("wheel", (e) => {
    e.preventDefault(); if (!S.img) return;
    const b = cv.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.012), e.clientX - b.left, e.clientY - b.top);
    else { S.view.x -= e.deltaX; S.view.y -= e.deltaY; S.fitted = false; draw(); }
  }, { passive: false });
  cv.addEventListener("dblclick", (e) => {
    if (S.tool !== "edit") return;
    const r = region(S.selected), p = toImg(e); if (!r) return;
    const n = hitNode(r, p);
    if (n) { pushUndo(); if (G.removeNode(r.paths[n.pi], n.ni)) { r.edited = true; refresh(true); } else { S.undo.pop(); toast("A shape needs at least two nodes"); } return; }
    const l = hitLine(r, p);
    if (l) { pushUndo(); G.insertNode(r.paths[l.pi], l.seg, l.t); r.edited = true; refresh(true); }
  });

  /* Edit tool: nodes move, lines bend, empty space pans. */
  function editDown(p, e) {
    const sel = region(S.selected);
    if (sel) {
      const n = hitNode(sel, p);
      if (n) { pushUndo(); S.drag = { kind: "node", pi: n.pi, ni: n.ni, last: p, moved: false }; return; }
      const l = hitLine(sel, p);
      if (l) { pushUndo(); S.drag = { kind: "bend", pi: l.pi, seg: l.seg, t: l.t, last: p, moved: false }; return; }
    }
    const r = hitRegion(p);
    if (r) {
      if (r.id !== S.selected || S.hole) { S.selected = r.id; S.hole = null; refresh(); }
      pushUndo(); S.drag = { kind: "move", last: p, moved: false }; return;
    }
    const h = hitHole(p);                                      // clicking inside a hole selects just the hole
    if (h) {
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
    if (d.kind === "node") G.moveNode(r.paths[d.pi], d.ni, delta);
    else if (d.kind === "bend") G.bendSeg(r.paths[d.pi], d.seg, d.t, delta);
    else for (const path of (d.kind === "movepath" ? [r.paths[d.pi]] : r.paths)) {   // move the whole region (or one hole)
      path.nodes = path.nodes.map((n) => G.add(n, delta));
      path.segs = path.segs.map((sg) => ({ c1: G.add(sg.c1, delta), c2: G.add(sg.c2, delta) }));
    }
    d.last = p; d.moved = true; r._p = null; draw();
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
  function setTool(t) { S.tool = t; S.hover = null; $("toolEdit").classList.toggle("on", t === "edit"); $("toolDraw").classList.toggle("on", t === "draw"); cv.style.cursor = t === "draw" ? "crosshair" : "default"; renderHint(); draw(); }

  /* Grow / shrink: re-cut one region from the model's probability map at a different cut-off. */
  let sliderSeq = 0, sliderArmed = false;
  async function slide(t) {
    const r = region(S.selected); if (!r || r.label == null) return;
    if (!sliderArmed) { pushUndo(); sliderArmed = true; }
    const seq = ++sliderSeq;
    $("sliderVal").textContent = sliderText(t);
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

  async function doExport() {
    if (!S.sid) return;
    const regions = S.regions.map((r) => ({
      name: r.name, rings: r.paths.map((p) => G.flatten(p, 1).map((q) => [+q.x.toFixed(2), +q.y.toFixed(2)])),
    }));
    $("exportBody").innerHTML = '<p class="note">Exporting…</p>'; $("exportModal").classList.add("show");
    try {
      const j = await api("/api/editor/export", { id: S.sid, regions });
      const f = j.files, row = (k, label, kind) => f[k] ? `<a href="${f[k]}" download><span>${label}</span><span>${kind}</span></a>` : "";
      $("exportBody").innerHTML = `
        <p class="note" style="margin:0 0 12px">${j.regions} region${j.regions === 1 ? "" : "s"} exported.
        The ImageJ file was read back and matches the mask at IoU <b class="mono">${j.imagej_iou.toFixed(4)}</b>
        (its outlines are thinned to editable polygons, so not pixel-identical).</p>
        <div class="files">
          ${row("mask_png", "Mask (black and white)", "PNG")}
          ${row("overlay_png", "Shaded image", "PNG")}
          ${row("imagej_tif", "ImageJ image with editable regions", "TIF")}
          ${row("roiset_zip", "ImageJ ROI set", "ZIP")}
          ${row("qupath_geojson", "QuPath annotations", "GEOJSON")}
        </div>
        <p class="note">Also saved in <span class="mono">${j.dir}</span></p>`;
    } catch (e) { $("exportBody").innerHTML = `<p class="err">${e.message}</p>`; }
  }

  /* ---------------- panel ---------------- */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function renderPanel() {
    const q = order();
    $("progress").textContent = S.regions.length ? String(S.regions.length) : "";
    $("confHead").textContent = S.regions.some((r) => r.meanProb != null) ? "Model confidence" : "";
    $("queue").innerHTML = q.length ? q.map((r) => {
      const c = r.meanProb, cls = c == null ? "" : c < 0.7 ? "low" : c < 0.85 ? "mid" : "";
      return `<button class="q-item ${r.id === S.selected ? "on" : ""}" data-id="${r.id}">
        <span class="q-name">${esc(r.name)}</span>
        ${r.source === "drawn" ? '<span class="tag">drawn</span>' : r.edited ? '<span class="tag">edited</span>' : ""}
        <span class="conf ${cls}">${c == null ? "" : Math.round(c * 100) + "%"}</span></button>`;
    }).join("") : `<p class="note" style="padding:6px 8px">${S.sid ? "No regions on this image. Use the Draw tool to add one." : "Nothing open."}</p>`;
    $("queue").querySelectorAll(".q-item").forEach((b) => (b.onclick = () => { const r = region(b.dataset.id); S.selected = r.id; S.hole = null; focusRegion(r); refresh(); }));

    const r = region(S.selected), d = $("detail");
    if (!r) { d.innerHTML = S.sid && S.regions.length ? `<p class="note" style="margin:0">Select a region, or press <kbd>N</kbd> to start with the one the model was least sure about.</p>` : ""; return; }
    if (selHole() != null) {
      d.innerHTML = `<div class="d-name">Hole in ${esc(r.name)}</div><div class="d-sub">${r.paths[selHole()].nodes.length} nodes · drag inside it to move it</div>
        <button class="btn danger d-del" id="delRegion">Delete hole <kbd>Delete</kbd></button>`;
      $("delRegion").onclick = deleteSelected; return;
    }
    const nodes = r.paths.reduce((a, p) => a + p.nodes.length, 0);
    const conf = r.meanProb == null ? (r.source === "drawn" ? "Drawn by hand" : "No model confidence for this input")
      : `Model confidence ${Math.round(r.meanProb * 100)}%`;
    let slider = "";
    if (r.label != null) {
      slider = `<div class="slider-h"><span>Grow / shrink</span><b id="sliderVal">${sliderText(r.t)}</b></div>
        <input type="range" id="slider" min="0.05" max="0.95" step="0.01" value="${r.t}">
        <div class="slider-ends"><span>Grow</span><button class="link" id="sliderReset">Reset</button><span>Shrink</span></div>
        <p class="note">${S.meta.has_prob ? "Moves this region's edge along the model's own probability map: it shifts most where the model was unsure."
          : "No probability map for this input, so the edge moves evenly in or out."}
          ${r.edited ? " Moving it redraws the outline and replaces your manual edits (undo brings them back)." : ""}</p>`;
    } else slider = `<p class="note">Drawn by hand, so there is no model outline to grow or shrink.</p>`;
    d.innerHTML = `<div class="d-name">${esc(r.name)}</div><div class="d-sub">${conf} · ${nodes} node${nodes === 1 ? "" : "s"}</div>
      ${r.meanProb == null ? "" : `<div class="bar"><i style="width:${Math.round(r.meanProb * 100)}%"></i></div>`}
      ${slider}
      <button class="btn danger d-del" id="delRegion">Delete region <kbd>Delete</kbd></button>
      <div class="nav"><button class="btn" id="navPrev">Previous region</button><button class="btn" id="navNext">Next <kbd>N</kbd></button></div>`;
    $("delRegion").onclick = deleteSelected;
    $("navPrev").onclick = () => step(-1); $("navNext").onclick = () => step(1);
    const sl = $("slider");
    if (sl) {
      sl.oninput = () => slide(+sl.value);
      sl.onchange = () => { sliderArmed = false; setTimeout(() => refresh(true), 250); };
      $("sliderReset").onclick = () => { sliderArmed = false; slide(S.meta.threshold).then(() => { sliderArmed = false; refresh(true); }); };
    }
  }
  function renderHint() {
    const k = (s) => `<kbd>${s}</kbd>`;
    let h = "";
    if (!S.sid) h = "Open an image to begin.";
    else if (S.tool === "edit" && selHole() != null) h = `Hole selected · ${k("Delete")} removes just this hole · drag inside it to move it · drag its nodes or line to reshape it`;
    else if (S.tool === "edit") h = region(S.selected)
      ? `Drag a node to move it · drag the line to bend it · drag inside to move the whole region · double-click the line to add a node, a node to remove it · ${k("Delete")} removes the region`
      : `Click a region to select it, or inside a hole to select the hole · drag empty space to pan · pinch or ${k("⌘")}-scroll to zoom`;
    else if (S.draft) h = `Press the open end (orange) to continue · finish on the first node to close · ${k("Delete")} removes the last node · ${k("Enter")} closes · ${k("Esc")} cancels`;
    else h = "Press, drag, release to draw a new region. Draw inside a region to cut a hole. Start and end on an outline to reroute that stretch. Drag back along your line to un-draw.";
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
    $("prevCase").title = S.lib ? `Previous image in ${S.lib.name} ( [ )` : ""; $("nextCase").title = S.lib ? `Next image in ${S.lib.name} ( ] )` : "";
  }
  /* Make a library the current one and open one of its images. */
  async function useLibrary(id, index) {
    const lib = await api("/api/editor/library?id=" + encodeURIComponent(id));
    if (index == null) index = +(store.get("seg-editor-idx-" + id) || 0);
    S.lib = lib; store.set("seg-editor-lib", id);
    await openCase(Math.min(Math.max(index, 0), lib.cases.length - 1));
  }
  let opening = false;
  async function openCase(i) {
    if (!S.lib || opening || i < 0 || i >= S.lib.cases.length) return;
    opening = true;
    try {
      await saveNow();                                          // the image being left is saved first
      $("sessionName").textContent = "Opening " + S.lib.cases[i].name + "…";
      const j = await api("/api/editor/library/open", { id: S.lib.id, index: i });
      S.caseIndex = i; store.set("seg-editor-idx-" + S.lib.id, i);
      await openSession(j.id); renderNav();
    } catch (e) { toast(e.message); if (S.meta) $("sessionName").textContent = S.meta.name; }
    opening = false;
  }

  async function showOpen() {
    $("openModal").classList.add("show"); $("importErr").textContent = ""; $("libErr").textContent = "";
    S.pick = null; $("preview").hidden = true;
    await renderLibraries();
  }
  /* First click on an image selects it and shows a preview; clicking it again (or Enter) opens it. */
  function pickCase(i) {
    if (!S.lib || i < 0 || i >= S.lib.cases.length) return;
    if (i === S.pick) return openPicked();
    S.pick = i;
    $("libList").querySelectorAll("[data-case]").forEach((b) => { const on = +b.dataset.case === i; b.classList.toggle("sel", on); if (on) b.scrollIntoView({ block: "nearest" }); });
    const pv = $("preview"), m = document.querySelector("#openModal .modal").getBoundingClientRect();
    $("previewImg").src = `/api/editor/library/preview?id=${encodeURIComponent(S.lib.id)}&index=${i}&t=${Date.now()}`;
    $("previewName").textContent = S.lib.cases[i].name;
    pv.hidden = false;
    pv.style.left = Math.min(m.right + 16, window.innerWidth - 312) + "px";      // beside the dialog, with a gap
    pv.style.top = Math.max(12, Math.min(m.top + 96, window.innerHeight - 370)) + "px";
  }
  async function openPicked() {
    const i = S.pick; if (i == null) return;
    $("openModal").classList.remove("show"); S.pick = null; $("preview").hidden = true;
    await openCase(i);
  }
  async function renderLibraries() {
    let j; try { j = await api("/api/editor/libraries"); } catch (e) { $("libErr").textContent = e.message; return; }
    const cur = S.lib && S.lib.id;
    $("libList").innerHTML = j.libraries.length ? j.libraries.map((l) => `
      <div class="li ${l.id === cur ? "current" : ""}" data-lib="${esc(l.id)}">
        <span class="q-name" data-name>${esc(l.name)}</span>
        <span class="meta">${l.count} image${l.count === 1 ? "" : "s"}${l.edited ? ` · ${l.edited} edited` : ""}</span>
        ${l.id === cur ? '<span class="tag cur">Working on this</span>' : '<button class="btn" data-act="use">Work on this</button>'}
        <button class="btn" data-act="rename">Rename</button>
        <button class="btn danger" data-act="delete">Delete</button>
      </div>${l.id === cur ? `<div class="cases">${S.lib.cases.map((c, i) => `<button class="${i === S.caseIndex ? "on" : ""} ${i === S.pick ? "sel" : ""}" data-case="${i}"><span class="q-name">${esc(c.name)}</span>${c.edited ? '<span class="tag">edited</span>' : ""}</button>`).join("")}</div>` : ""}`).join("")
      : '<p class="note">No libraries yet. Import a folder of images below.</p>';
    $("libList").querySelectorAll("[data-case]").forEach((b) => (b.onclick = () => pickCase(+b.dataset.case)));
    if (S.pick == null) $("preview").hidden = true;
    $("libList").querySelectorAll("[data-act]").forEach((b) => (b.onclick = async () => {
      const row = b.closest("[data-lib]"), id = row.dataset.lib, act = b.dataset.act;
      try {
        if (act === "use") { $("libErr").textContent = "Opening…"; await useLibrary(id); $("openModal").classList.remove("show"); }
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
  async function importLibrary(files, zip, name) {
    const err = $("libErr");
    files = (files || []).filter((x) => !x.path.split("/").some((part) => part.startsWith(".")));
    if (!files.length && !zip) { err.textContent = "Nothing to import in that."; return; }
    try {
      const { id } = await api("/api/editor/library/begin", { name: name || "Library" });
      const put = async (path, file) => {
        const r = await fetch(`/api/editor/library/put?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`, { method: "POST", body: file });
        if (!r.ok) throw new Error("Upload failed: " + path);
      };
      if (zip) { err.textContent = "Uploading…"; await put("__library__.zip", zip); }
      else { let n = 0; for (const x of files) { err.textContent = `Uploading ${++n} of ${files.length}…`; await put(x.path, x.file); } }
      err.textContent = "Recognising files…";
      const j = await api("/api/editor/library/finish", { id });
      await useLibrary(id, 0);
      err.textContent = j.skipped.length ? `Imported ${j.cases} images. Skipped: ${j.skipped.join(", ")}.` : "";
      if (j.skipped.length) renderLibraries(); else $("openModal").classList.remove("show");
    } catch (e) { err.textContent = e.message; }
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
  function wireLibraryDrop() {
    const drop = $("libDrop"), dir = $("f_lib_dir"), zip = $("f_lib_zip");
    drop.onclick = (e) => { if (e.target.id !== "libZip") dir.click(); };
    drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); dir.click(); } };
    $("libZip").onclick = (e) => { e.stopPropagation(); zip.click(); };
    dir.onchange = () => { const s = stripTop([...dir.files].map((f) => ({ path: f.webkitRelativePath || f.name, file: f }))); dir.value = ""; importLibrary(s.files, null, s.name); };
    zip.onchange = () => { const f = zip.files[0]; zip.value = ""; if (f) importLibrary(null, f, f.name.replace(/\.zip$/i, "")); };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = async (e) => {
      e.preventDefault(); drop.classList.remove("over");
      const items = [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
      const lone = e.dataTransfer.files.length === 1 ? e.dataTransfer.files[0] : null;
      if (lone && /\.zip$/i.test(lone.name) && items.length === 1 && items[0].isFile) return importLibrary(null, lone, lone.name.replace(/\.zip$/i, ""));
      $("libErr").textContent = "Reading folder…";
      const out = []; try { for (const en of items) await readEntry(en, out); } catch (err) { $("libErr").textContent = "Could not read that folder."; return; }
      const s = stripTop(out); importLibrary(s.files, null, s.name);
    };
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
      const spec = { model: { image: "f_model_image", model: "f_model_out" }, screenshot: { overlay: "f_shot_overlay" }, imagej: { imagej: "f_ij_image", rois: "f_ij_rois" } }[route];
      const files = {};
      for (const [role, id] of Object.entries(spec)) { const t = await upload(id); if (t) files[role] = t; }
      const main = $(route === "model" ? "f_model_out" : route === "screenshot" ? "f_shot_overlay" : "f_ij_image").files[0];
      if (!main) throw new Error("Choose a file first.");
      if (route === "imagej" && !files.rois) throw new Error("Add the outlines file too. An ImageJ .tif with its outlines inside goes in Image file.");
      if (route === "model" && !files.image) throw new Error("Add the original image too.");
      const j = await api("/api/editor/import", { route, files, name: main.name.replace(/\.[^.]+$/, ""), threshold: +$("f_model_thr").value || 0.5 });
      await useLibrary(j.library, j.index);
      $("openModal").classList.remove("show"); err.textContent = "";
    } catch (e) { err.textContent = e.message; }
  }

  /* ---------------- wiring ---------------- */
  $("prevCase").onclick = () => openCase(S.caseIndex - 1); $("nextCase").onclick = () => openCase(S.caseIndex + 1);
  wireLibraryDrop();
  $("open").onclick = showOpen; $("openEmpty").onclick = showOpen; $("export").onclick = doExport;
  $("undo").onclick = undo; $("redo").onclick = redo;
  $("zoomIn").onclick = () => zoomAt(1.25); $("zoomOut").onclick = () => zoomAt(0.8); $("fit").onclick = fitView;
  $("toolEdit").onclick = () => setTool("edit"); $("toolDraw").onclick = () => setTool("draw");
  $("opacity").oninput = (e) => { S.opacity = +e.target.value; draw(); };
  $("showModel").onchange = (e) => { S.showModel = e.target.checked; draw(); };
  $("showHeat").onchange = (e) => { S.showHeat = e.target.checked; draw(); };
  $("keysBtn").onclick = () => $("keysModal").classList.add("show");
  document.querySelectorAll("#openTabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  document.querySelectorAll("[data-import]").forEach((b) => (b.onclick = () => doImport(b.dataset.import)));
  document.querySelectorAll(".backdrop").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) m.classList.remove("show"); }));
  $("theme").onclick = () => {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches, cur = document.documentElement.dataset.theme || (dark ? "dark" : "light");
    const nxt = cur === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = nxt;
    try { localStorage.setItem("seg-editor-theme", nxt); } catch (e) {} draw();
  };
  try { const t = localStorage.getItem("seg-editor-theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}

  window.addEventListener("keydown", (e) => {
    if (e.target && e.target.matches && e.target.matches("input[type=number], input[type=text], textarea")) return;
    if (e.key === "[") { openCase(S.caseIndex - 1); return; } if (e.key === "]") { openCase(S.caseIndex + 1); return; }
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if ($("openModal").classList.contains("show") && S.pick != null && ["Enter", "ArrowDown", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "Enter") openPicked(); else pickCase(Math.min(S.lib.cases.length - 1, Math.max(0, S.pick + (e.key === "ArrowDown" ? 1 : -1))));
      return;
    }
    if (document.querySelector(".backdrop.show")) { if (e.key === "Escape") document.querySelectorAll(".backdrop.show").forEach((m) => m.classList.remove("show")); return; }
    if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod) return;
    if (e.key === " ") { S.space = true; cv.style.cursor = "grab"; e.preventDefault(); return; }
    if (k === "v") setTool("edit"); else if (k === "p") setTool("draw");
    else if (k === "n") step(e.shiftKey ? -1 : 1);
    else if (k === "m") { S.showModel = !S.showModel; $("showModel").checked = S.showModel; draw(); }
    else if (k === "h" && S.meta && S.meta.has_prob) { S.showHeat = !S.showHeat; $("showHeat").checked = S.showHeat; draw(); }
    else if (k === "+" || k === "=") zoomAt(1.25); else if (k === "-") zoomAt(0.8); else if (k === "0") fitView();
    else if (k === "?") $("keysModal").classList.add("show");
    else if (e.key === "Enter" && S.draft) finishDraft(false);
    else if (e.key === "Escape") { if (S.stroke) S.stroke = null; else if (S.draft) { pushUndo(); S.draft = null; } else S.selected = null; refresh(); }
    else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      if (S.draft) { pushUndo(); const d = S.draft; if (d.segs.length) { d.segs.pop(); d.nodes.pop(); } else S.draft = null; refresh(); }
      else deleteSelected();
    }
  });
  window.addEventListener("keyup", (e) => { if (e.key === " ") { S.space = false; cv.style.cursor = S.tool === "draw" ? "crosshair" : "default"; } });
  new ResizeObserver(resize).observe(stage);

  resize(); renderPanel(); renderHint();
  const q = new URLSearchParams(location.search), wantLib = q.get("lib") || store.get("seg-editor-lib");
  if (wantLib) window.__ready = useLibrary(wantLib, q.has("i") ? +q.get("i") : null).catch(() => closeImage());
  renderNav();
  window.__editor = { S, pickCase, selHole, openSession, openCase, useLibrary, refresh, slide, doExport, setTool, step, undo, region, inside };   // for selftest.js
  if (new URLSearchParams(location.search).has("selftest")) { const sc = document.createElement("script"); sc.src = "/viewer/editor/selftest.js"; document.body.appendChild(sc); }
})();
