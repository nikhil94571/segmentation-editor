/* Self-test: drives the real page with synthetic pointer events. Open /editor?session=<id>&selftest=1 ;
   results land in <pre id="selftest">. Used from headless Chrome (no clicking available there). */
(async function () {
  const E = window.__editor, S = E.S, cv = document.getElementById("cv"), out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await window.__ready; await wait(300);
  const scr = (p) => { const b = cv.getBoundingClientRect(); return { x: b.left + S.view.x + p.x * S.view.s, y: b.top + S.view.y + p.y * S.view.s }; };
  const ev = (type, p, extra) => cv.dispatchEvent(new PointerEvent(type, Object.assign({ clientX: scr(p).x, clientY: scr(p).y, button: 0, pointerId: 1, bubbles: true }, extra || {})));
  const dbl = (p) => cv.dispatchEvent(new MouseEvent("dblclick", { clientX: scr(p).x, clientY: scr(p).y, bubbles: true }));
  const stroke = (pts) => { ev("pointerdown", pts[0]); for (const p of pts.slice(1)) ev("pointermove", p); ev("pointerup", pts[pts.length - 1]); };
  const area = (r) => r.paths.reduce((a, p, i) => a + (i ? -1 : 1) * G.pathArea(p), 0);
  const key = (k, o) => document.body.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true }, o || {})));
  try {
    out.regions_loaded = S.regions.length;
    out.nodes_per_region = S.regions.map((r) => r.paths.reduce((a, p) => a + p.nodes.length, 0));
    // queue: N selects the least confident region
    key("n"); const r = E.region(S.selected);
    out.queue_first_is_least_confident = r.meanProb === Math.min(...S.regions.map((x) => x.meanProb));
    const path = r.paths[0];
    // 1. drag a node
    const n0 = Object.assign({}, path.nodes[0]);
    ev("pointerdown", n0); ev("pointermove", { x: n0.x + 20, y: n0.y + 10 }); ev("pointerup", { x: n0.x + 20, y: n0.y + 10 });
    out.node_drag = [+(path.nodes[0].x - n0.x).toFixed(1), +(path.nodes[0].y - n0.y).toFixed(1)];
    // 2. bend a line by dragging its middle
    const m0 = G.bez(G.cubic(path, 1), 0.5);
    ev("pointerdown", m0); ev("pointermove", { x: m0.x + 15, y: m0.y - 15 }); ev("pointerup", { x: m0.x + 15, y: m0.y - 15 });
    const m1 = G.bez(G.cubic(path, 1), 0.5);
    out.bend_moved_midpoint = [+(m1.x - m0.x).toFixed(1), +(m1.y - m0.y).toFixed(1)];
    out.nodes_unchanged_by_bend = path.nodes.length;
    // 3. double-click line adds a node, double-click node removes it
    const before = path.nodes.length; dbl(G.bez(G.cubic(path, 2), 0.3)); out.dblclick_adds_node = path.nodes.length - before;
    dbl(path.nodes[3]); out.dblclick_removes_node = path.nodes.length - before;
    out.edited_flag = r.edited;
    // 4. undo restores
    const u = S.undo.length; E.undo(); out.undo_steps = [u, S.undo.length];
    // 5. grow / shrink slider
    const a0 = area(E.region(S.selected));
    await E.slide(0.25); await wait(400); const aG = area(E.region(S.selected));
    await E.slide(0.58); await wait(400); const aS = area(E.region(S.selected));
    await E.slide(S.meta.threshold); await wait(400);
    out.slider_area = { start: Math.round(a0), grow_0_25: Math.round(aG), shrink_0_58: Math.round(aS) };
    // 6. draw a new region (circle) with the Draw tool, in the top-left corner
    E.setTool("draw");
    const circ = []; for (let i = 0; i <= 64; i++) { const t = i / 64 * 2 * Math.PI; circ.push({ x: 160 + 90 * Math.cos(t), y: 160 + 90 * Math.sin(t) }); }
    const nb = S.regions.length; stroke(circ);
    const drawn = S.regions[S.regions.length - 1];
    out.draw_new_region = { added: S.regions.length - nb, nodes: drawn.paths[0].nodes.length, area: Math.round(area(drawn)), expected: Math.round(Math.PI * 8100), status: drawn.status };
    // 7. retrace: draw right 200 px, come back 150 px along the same line -> the stroke un-draws
    ev("pointerdown", { x: 600, y: 60 });
    for (let x = 600; x <= 800; x += 4) ev("pointermove", { x, y: 60 });
    const longest = S.stroke.pts.length;
    for (let x = 800; x >= 650; x -= 4) ev("pointermove", { x, y: 60 });
    out.retrace = { points_at_full_length: longest, after_dragging_back: S.stroke.pts.length, tip_x: Math.round(S.stroke.pts[S.stroke.pts.length - 1].x) };
    ev("pointerup", { x: 650, y: 60 });
    // 8. draft: open line, Backspace removes last node, press open end to continue, Esc cancels
    out.draft_open_nodes = S.draft ? S.draft.nodes.length : 0;
    const end = S.draft.nodes[S.draft.nodes.length - 1];
    stroke([end, { x: end.x + 40, y: 100 }, { x: end.x + 80, y: 160 }, { x: end.x + 60, y: 220 }]);
    out.draft_after_continue = S.draft.nodes.length;
    key("Backspace"); out.draft_after_backspace = S.draft.nodes.length;
    key("Escape"); out.draft_after_escape = S.draft;
    // 9. reroute: bump the drawn circle outward on its right side, then bite into its left side
    const c = drawn.paths[0], aC = area(drawn), bump = [], bite = [];
    for (let i = -8; i <= 8; i++) { const t = i / 8 * 0.5, rr = 90 + 60 * Math.cos(i / 8 * Math.PI / 2); bump.push({ x: 160 + rr * Math.cos(t), y: 160 + rr * Math.sin(t) }); }
    stroke(bump); const aBump = area(E.region(drawn.id));
    for (let i = -8; i <= 8; i++) { const t = Math.PI + i / 8 * 0.5, rr = 90 - 50 * Math.cos(i / 8 * Math.PI / 2); bite.push({ x: 160 + rr * Math.cos(t), y: 160 + rr * Math.sin(t) }); }
    stroke(bite); const aBite = area(E.region(drawn.id));
    out.reroute_area = { circle: Math.round(aC), after_outward_bump: Math.round(aBump), after_inward_bite: Math.round(aBite) };
    // 10. draw inside a region -> cuts a hole (area drops, region count unchanged)
    const host = S.regions.find((x) => x.source === "model" && x.paths.length === 1) || S.regions[0];
    const bb = G.bbox([host.paths[0]]), fl = G.flatten(host.paths[0], 4);
    let c0 = null;                                             // a point well inside the region
    for (let y = bb.y0; y < bb.y1 && !c0; y += 6) for (let x = bb.x0; x < bb.x1 && !c0; x += 6) {
      const ring = []; for (let i = 0; i < 12; i++) ring.push({ x: x + 16 * Math.cos(i / 12 * 6.283), y: y + 16 * Math.sin(i / 12 * 6.283) });
      if (ring.every((q) => E.inside(host, q))) c0 = { x, y };
    }
    const hole = []; for (let i = 0; i <= 40; i++) { const t = i / 40 * 2 * Math.PI; hole.push({ x: c0.x + 11 * Math.cos(t), y: c0.y + 11 * Math.sin(t) }); }
    const aH = area(host), nR = S.regions.length, nP = host.paths.length;
    const zoomSave = Object.assign({}, S.view); S.view = { s: 6, x: 400 - c0.x * 6, y: 300 - c0.y * 6 };   // zoom in so the small loop is drawable
    stroke(hole); S.view = zoomSave;
    const h2 = E.region(host.id);
    out.hole_cut = { regions_added: S.regions.length - nR, paths_added: h2.paths.length - nP, centre_now_unshaded: !E.inside(h2, c0), expected_hole_area: Math.round(Math.PI * 121) };
    // 10b. clicking inside the hole selects just the hole; Delete removes the hole, not the region
    E.setTool("edit"); S.selected = null; E.refresh();
    S.view = { s: 6, x: 400 - c0.x * 6, y: 300 - c0.y * 6 };
    ev("pointerdown", c0); ev("pointerup", c0);
    const picked = { hole_selected: E.selHole() != null, region_selected: S.selected === host.id, panel: document.getElementById("hint").textContent.slice(0, 13) };
    key("Delete"); S.view = zoomSave;
    const h3 = E.region(host.id);
    out.hole_select_delete = Object.assign(picked, { region_still_there: !!h3, paths_back_to: [nP, h3 ? h3.paths.length : -1], centre_shaded_again: !!h3 && E.inside(h3, c0) });
    // 11. Edit tool: drag inside a region moves all of it; a click without dragging changes nothing
    E.setTool("edit");
    const mv = E.region(drawn.id), bbm = G.bbox(mv.paths), inside0 = { x: 150, y: 215 }, u0 = S.undo.length;
    ev("pointerdown", inside0); ev("pointerup", inside0); out.click_without_drag_adds_undo = S.undo.length - u0;
    ev("pointerdown", inside0); ev("pointermove", { x: 190, y: 245 }); ev("pointerup", { x: 190, y: 245 });
    const bb2 = G.bbox(E.region(drawn.id).paths);
    out.move_region = { selected: S.selected === drawn.id, dx: Math.round(bb2.x0 - bbm.x0), dy: Math.round(bb2.y0 - bbm.y0), size_kept: Math.abs((bb2.x1 - bb2.x0) - (bbm.x1 - bbm.x0)) < 0.01 };
    // 12. delete a region
    const nD = S.regions.length; S.selected = S.regions[0].id; E.refresh(); key("Delete"); out.delete_removed = nD - S.regions.length;
    // 12b. slice: a line drawn right across a region splits it in two
    E.setTool("draw");
    const tgt = E.region(drawn.id), bbS = G.bbox(tgt.paths), cyS = (bbS.y0 + bbS.y1) / 2, nS = S.regions.length, aT = area(tgt), line = [];
    for (let x = bbS.x0 - 45; x <= bbS.x1 + 45; x += 9) line.push({ x, y: cyS });
    stroke(line);
    const parts = S.regions.filter((x) => x.name === tgt.name + "a" || x.name === tgt.name + "b");
    out.slice = { regions_added: S.regions.length - nS, pieces: parts.length, areas: parts.map((x) => Math.round(area(x))), whole: Math.round(aT), draft_left: !!S.draft };
    if (parts.length === 2) {                                   // the two pieces share the very same curve along the cut
      const key2 = (q) => q.x.toFixed(3) + "," + q.y.toFixed(3), setA = new Set(parts[0].paths[0].nodes.map(key2));
      out.slice.shared_nodes = parts[1].paths[0].nodes.filter((q) => setA.has(key2(q))).length;
      out.slice.area_lost_or_doubled = Math.round(Math.abs(area(parts[0]) + area(parts[1]) - aT));
    }
    E.undo(); out.slice.undo_restores = S.regions.length === nS && !!E.region(drawn.id);
    stroke(line);
    // 12b2. one line right through both pieces splits both; a line that starts inside one piece only splits the other
    const cxS = (bbS.x0 + bbS.x1) / 2, vert = [], half = [], n2 = S.regions.length;
    for (let y = bbS.y0 - 45; y <= bbS.y1 + 45; y += 9) vert.push({ x: cxS, y });
    stroke(vert); out.slice_through_two = { regions_added: S.regions.length - n2 };
    {                                                          // the four pieces meet at one shared node; moving it moves all four
      const four = S.regions.filter((x) => x.name.startsWith(tgt.name) && x.name.length === tgt.name.length + 2), sumBefore = four.reduce((t, x) => t + area(x), 0);
      const count = new Map(); for (const x of four) for (const q of x.paths[0].nodes) { const k = q.x.toFixed(2) + "," + q.y.toFixed(2); count.set(k, (count.get(k) || 0) + 1); }
      const hub = [...count.entries()].sort((u, v) => v[1] - u[1])[0], hp = { x: +hub[0].split(",")[0], y: +hub[0].split(",")[1] };
      E.setTool("edit"); S.selected = four[0].id; E.refresh();
      const zs = Object.assign({}, S.view); S.view = { s: 3, x: 500 - hp.x * 3, y: 350 - hp.y * 3 };
      ev("pointerdown", hp); ev("pointermove", { x: hp.x + 12, y: hp.y + 7 }); ev("pointerup", { x: hp.x + 12, y: hp.y + 7 });
      const moved = four.filter((x) => x.paths[0].nodes.some((q) => Math.abs(q.x - hp.x - 12) < 0.01 && Math.abs(q.y - hp.y - 7) < 0.01)).length;
      out.shared_node = { pieces: four.length, regions_at_the_node: hub[1], moved_together: moved, area_change: Math.round(Math.abs(four.reduce((t, x) => t + area(x), 0) - sumBefore)) };
      // bending a shared curve bends it in both regions: the total area stays the same
      const A0 = four[0], seg = A0.paths[0].segs.findIndex((_, i) => { const c = G.cubic(A0.paths[0], i); return four.some((x) => x !== A0 && x.paths[0].segs.some((__, j) => { const d = G.cubic(x.paths[0], j); return Math.abs(c[0].x - d[3].x) < 0.05 && Math.abs(c[0].y - d[3].y) < 0.05 && Math.abs(c[3].x - d[0].x) < 0.05 && Math.abs(c[3].y - d[0].y) < 0.05; })); });
      const mp = G.bez(G.cubic(A0.paths[0], seg), 0.5), sum1 = four.reduce((t, x) => t + area(x), 0), aA = area(A0);
      S.view = { s: 3, x: 500 - mp.x * 3, y: 350 - mp.y * 3 };
      ev("pointerdown", mp); ev("pointermove", { x: mp.x + 9, y: mp.y + 9 }); ev("pointerup", { x: mp.x + 9, y: mp.y + 9 });
      out.shared_bend = { own_area_changed: Math.round(Math.abs(area(A0) - aA)) > 0, total_area_change: Math.round(Math.abs(four.reduce((t, x) => t + area(x), 0) - sum1)) };
      S.view = zs; E.undo(); E.undo(); E.setTool("draw");
    }
    E.undo();
    for (let y = cyS - (cyS - bbS.y0) / 2; y <= bbS.y1 + 45; y += 9) half.push({ x: cxS, y });
    stroke(half); out.slice_starting_inside_one = { regions_added: S.regions.length - n2, draft_left: !!S.draft }; E.undo();
    // 12c. label: a number key gives the selected region a class, U marks it unsure, the menu opens on a click
    const piece = S.regions.find((x) => x.name === tgt.name + "a");
    S.selected = piece.id; E.refresh(); key("2"); const toolKey = S.tool; key("1");      // without the menu, 1 to 4 pick the tool
    E.setTool("label"); E.openLabel(piece); key("2"); key("u");                            // with the menu open, a number picks the class
    out.label_keys = { number_without_menu_picks_tool: toolKey, menu_closed_after_key: !document.getElementById("labelPop").classList.contains("open"), cls: piece.cls, expected: S.classes[1].id, unsure: piece.unsure === true, dot_in_list: !!document.querySelector(".q-item.on .q-dot") };
    E.setTool("label");
    const bbP = G.bbox(piece.paths), mid = { x: (bbP.x0 + bbP.x1) / 2, y: (bbP.y0 + bbP.y1) / 2 };
    ev("pointerdown", mid); ev("pointerup", mid); await wait(350);
    const pop = document.getElementById("labelPop");
    out.label_menu = { open: pop.classList.contains("open"), rows: pop.querySelectorAll("[data-cls]").length, inside_stage: pop.getBoundingClientRect().right <= document.getElementById("stage").getBoundingClientRect().right };
    pop.querySelector("[data-cls]").click();
    out.label_menu.click_sets = E.region(piece.id).cls === S.classes[0].id; out.label_menu.closes = !pop.classList.contains("open");
    E.openLabel(E.region(piece.id)); key("1"); out.label_menu.same_key_clears = E.region(piece.id).cls === undefined;
    E.openLabel(E.region(piece.id)); key("1");
    key("x"); out.peek_on = S.peek === true; document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "x", bubbles: true })); out.peek_off = S.peek === false;
    E.setTool("edit");
    // 12d. measure panel and the reshape bar
    const rm = S.regions.find((x) => x.source === "model" && x.paths.length === 1 && x.label != null);
    S.selected = rm.id; E.refresh(); await wait(300);
    out.measure = { class_rows: document.querySelectorAll("#measBody .meas-t tr").length, selected_tiles: document.querySelectorAll("#measBody .stat").length, slider_in_bar: !!document.querySelector("#shapeBar #slider") && !document.querySelector("#detail #slider"),
      bar_open: document.getElementById("shapeBar").classList.contains("open"), area_matches: Math.abs(E.measures(rm).area - area(rm)) < 0.02 * area(rm) };
    const a1 = area(rm); document.getElementById("sbDist").value = 10;
    await E.shapeOp("grow"); const a2 = area(E.region(rm.id)); await E.shapeOp("shrink"); const a3 = area(E.region(rm.id));
    out.reshape_offset = { start: Math.round(a1), grown_10: Math.round(a2), shrunk_back: Math.round(a3) };
    const nB = S.regions.length; await E.shapeOp("band");
    const band = S.regions[S.regions.length - 1];
    out.reshape_band = { added: S.regions.length - nB, band_area: Math.round(E.measures(band).area), expected_about: Math.round(E.measures(rm).perim * 10 + Math.PI * 100), selected: S.selected === band.id };
    E.undo(); S.selected = rm.id; E.refresh(); document.getElementById("sbDist").value = 1; await E.shapeOp("band");
    out.reshape_band_1px = { added: S.regions.length - nB, area: Math.round(E.measures(S.regions[S.regions.length - 1]).area), expected_about: Math.round(E.measures(rm).perim) };
    document.getElementById("sbDist").value = 10;
    E.undo();
    const pa = S.regions.find((x) => x.name === tgt.name + "a"), pb = S.regions.find((x) => x.name === tgt.name + "b"), sum = area(pa) + area(pb), nM = S.regions.length;
    await E.serverShape("merge", pa, pb);
    out.reshape_merge = { regions_removed: nM - S.regions.length, merged_area: Math.round(E.measures(E.region(pa.id)).area), sum_of_pieces: Math.round(sum) };
    await E.saveNow();
    const mc = await (await fetch("/api/editor/library/measurements?id=" + S.lib.id)).json();
    out.measure_csv = { rows: mc.rows, columns: mc.csv.split("\n")[0].trim() };
    E.setTool("ruler"); ev("pointerdown", { x: 100, y: 100 }); ev("pointermove", { x: 400, y: 500 }); ev("pointerup", { x: 400, y: 500 });
    out.ruler_px = S.ruler ? Math.round(G.dist(S.ruler.a, S.ruler.b)) : null;
    // ruler clicks: two pins on one outline give its length both ways; a region, then another, gives the gap
    const zoomOn = (c) => { S.view = { s: 3, x: 500 - c.x * 3, y: 350 - c.y * 3 }; E.draw(); };
    const tap = (c) => { zoomOn(c); ev("pointerdown", c); ev("pointerup", c); };
    const rr = S.regions.find((x) => x.source === "model" && x.paths.length === 1), pth = rr.paths[0];
    tap(G.bez(G.cubic(pth, 0), 0.5)); const k1 = S.ruler && S.ruler.kind;
    tap(G.bez(G.cubic(pth, Math.floor(pth.segs.length / 2)), 0.5));
    out.ruler_selects = S.selected === rr.id;
    out.ruler_outline = { first_click: k1, then: S.ruler && S.ruler.kind, both_ways_sum: S.ruler && Math.round(S.ruler.len1 + S.ruler.len2), perimeter: Math.round(E.measures(rr).perim) };
    const two = S.regions.filter((x) => x.source === "model").slice(0, 2);
    key("Escape"); tap(E.labelPoint(two[0])); const k2 = S.ruler && S.ruler.kind; tap(E.labelPoint(two[1]));
    out.ruler_regions = { first_click: k2, gap_deselects: S.selected === null, then: S.ruler && S.ruler.kind, gap_px: S.ruler && S.ruler.a ? Math.round(G.dist(S.ruler.a, S.ruler.b)) : null };
    {                                                          // two points on a boundary that two pieces share still give the outline length
      E.setTool("draw"); const cut = []; for (let x = 1480; x <= 1770; x += 9) cut.push({ x, y: 600 });
      S.view = { s: 2, x: 500 - 1625 * 2, y: 350 - 600 * 2 }; stroke(cut);
      const pcs = S.regions.filter((x) => x.name === "region-04a" || x.name === "region-04b");
      const edge = (x) => { const a = pcs[0] && G.nearest(pcs[0].paths[0], { x, y: 600 }); return a ? a.point : { x, y: 600 }; };
      E.setTool("ruler"); tap(edge(1580)); const first = S.ruler && S.ruler.kind; tap(edge(1680));
      out.ruler_on_shared_edge = { pieces: pcs.length, first_click: first, then: S.ruler && S.ruler.kind, shorter_way: S.ruler && S.ruler.len1 != null ? Math.round(Math.min(S.ruler.len1, S.ruler.len2)) : null };
      E.undo();
    }
    // rename: double-click a name in the list
    {
      E.setTool("edit"); const nm = document.querySelector("#queue .q-item .q-name"), rid = nm.closest(".q-item").dataset.id;
      nm.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); nm.textContent = "gland A"; nm.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      out.rename = { name: E.region(rid).name, in_list: [...document.querySelectorAll("#queue .q-name")].some((x) => x.textContent === "gland A") };
      E.undo();
    }
    out.fold = (() => { const b = document.querySelector('[data-fold="regions"]'); b.click(); const shut = document.getElementById("secRegions").classList.contains("shut"); b.click(); return { shuts: shut, opens_again: !document.getElementById("secRegions").classList.contains("shut") }; })();
    out.measure_table = { columns: [...document.querySelectorAll("#measBody .meas-t th")].map((x) => x.textContent).join("|"), has_total: !!document.querySelector("#measBody .meas-t tr.tot") };
    E.fitView();
    E.setTool("edit");
    // 13. export
    const st = await (await fetch("/api/editor/settings")).json(), testDest = st.root + "/scratch/export-test";
    document.getElementById("export").click(); await wait(700);
    out.export_menu = { opens_as_menu: !!document.getElementById("exGo"), options: [...document.querySelectorAll("input[name=exScope]")].map((x) => x.value + (x.checked ? "*" : "")), save_in: document.getElementById("exDest").value };
    out.export_menu.formats = [...document.querySelectorAll("input[name=exFmt]")].map((x) => x.value).length;
    const ej = await E.runExport("image", { id: S.lib.id, name: S.lib.name }, testDest, ["mask_png", "qupath_geojson"]);
    out.export_image = { dir: ej.dir.replace(st.root, ""), text: document.getElementById("exportBody").innerText.replace(/\s+/g, " ").slice(0, 90) };
    document.getElementById("exportModal").classList.remove("show");
    // 14. library: next image saves this one and opens the next; previous comes back with edits kept
    const i0 = S.caseIndex, name0 = S.meta.name, n0r = S.regions.length;
    key("]"); await wait(2500);
    out.next_image = { index: [i0, S.caseIndex], changed: S.meta.name !== name0, pos: document.getElementById("casePos").textContent };
    key("["); await wait(2500);
    out.back_keeps_edits = { index: S.caseIndex, same_image: S.meta.name === name0, regions: [n0r, S.regions.length], has_drawn: S.regions.some((x) => x.source === "drawn") };
    // 15. Open dialog: first click previews, second click opens
    document.getElementById("open").click(); await wait(900);
    const target = Math.min(S.lib.cases.length - 1, i0 + 2);
    E.pickCase(target); await wait(1200);
    const pv = document.getElementById("preview"), pim = document.getElementById("previewImg"), mrect = document.querySelector("#openModal .modal").getBoundingClientRect(), prect = pv.getBoundingClientRect();
    out.preview = { shown: !pv.hidden, image_loaded: pim.naturalWidth > 0, gap_px: Math.round(prect.left - mrect.right), still_on_image: S.caseIndex, width: Math.round(prect.width) };
    window.__shot = true; await wait(1500); window.__shot = false;
    E.pickCase(target); await wait(2500);
    out.second_click_opens = { index: S.caseIndex, expected: target, dialog_closed: !document.getElementById("openModal").classList.contains("show") };
    // 16. done mark: marks this image and stays on it
    const dIdx = S.caseIndex; await E.toggleDone(); await wait(600);
    out.done_mark = { was_marked: S.lib.cases[dIdx].done === true, stayed_on: [dIdx, S.caseIndex], button_on: document.getElementById("doneBtn").classList.contains("on"), buttons_in_foot: document.querySelectorAll(".side-foot .btn").length };
    await E.toggleDone(); await wait(400);
    // 17. export the whole library to a chosen folder
    let seen = []; const watch = setInterval(() => { const e = document.getElementById("exPct"); if (e) seen.push(e.textContent); }, 200);
    const lj = await E.runExport("library", { id: S.lib.id, name: S.lib.name }, testDest, ["mask_png", "imagej_tif"]);
    clearInterval(watch);
    out.library_export = { dir: lj.dir.replace(st.root, ""), images: lj.images, progress_seen: [...new Set(seen)] };
    document.getElementById("exportModal").classList.remove("show");
    out.header_order = [...document.querySelector(".topbar").children].slice(0, 3).map((x) => x.id || x.className);
    out.conf_head = document.getElementById("confHead").textContent;
  } catch (e) { out.ERROR = String(e && e.stack || e); }
  await fetch("/api/editor/selftest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(out) });
  const pre = document.createElement("pre"); pre.id = "selftest"; pre.textContent = JSON.stringify(out); pre.style.display = "none"; document.body.appendChild(pre);
})();
