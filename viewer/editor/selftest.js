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
    const picked = { hole_selected: E.selHole() != null, region_selected: S.selected === host.id, panel: document.querySelector("#detail .d-name").textContent };
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
    out.done_mark = { was_marked: S.lib.cases[dIdx].done === true, stayed_on: [dIdx, S.caseIndex], button_now: document.getElementById("doneLabel").textContent, in_side_panel: !!document.querySelector(".side #doneBtn") };
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
