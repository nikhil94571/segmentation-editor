/* Records the tutorial clips shown in the editor's Tutorial panel (viewer/editor/tutorial/*.mp4).
   Usage:  node tutorial/make_tutorial.js <library id> [scene ...]
   The library must hold the six "__regions" practice cases named slide-01..06 (see tutorial/README.md). */
const { connect, hand, sleep, W, H, ROOT } = require("./rec.js");
const SLIDE = 5;                                              // slide-06: the image most clips use
const CANVAS = { x: 4, y: 66, w: 800, h: 500 };               // tool rail + left part of the image area
const CBOX = { x: 96, y: 86, w: 690, h: 462 };                // where the image window sits inside CANVAS
const SIDE = { x: 476, y: 66, w: 800, h: 500 };               // right part of the image area + side panel (top)
const SBOX = { x: 492, y: 90, w: 440, h: 440 };
const LOW = { x: 476, y: 212, w: 800, h: 500 };               // same, lower: the slider and Mark done
const LBOX = { x: 492, y: 236, w: 440, h: 440 };
const FULL = { x: 0, y: 0, w: W, h: H };

let R;
const view = (x0, y0, x1, y1, b) => R.ev(`(()=>{const S=__editor.S,c=document.getElementById('cv').getBoundingClientRect(),s=Math.min(${b.w}/${x1 - x0},${b.h}/${y1 - y0});
  S.view={s,x:${b.x + b.w / 2}-c.left-${(x0 + x1) / 2}*s,y:${b.y + b.h / 2}-c.top-${(y0 + y1) / 2}*s};S.fitted=false;__editor.refresh();})()`);
const reg = (name) => `__editor.S.regions.find(r=>r.name===${JSON.stringify(name)})`;
const select = (name) => R.ev(`(()=>{__editor.S.selected=${reg(name)}.id;__editor.S.hole=null;__editor.refresh();})()`);
const onLine = async (name, x, y, pi = 0) => { const p = await R.ev(`(()=>{const n=G.nearest(${reg(name)}.paths[${pi}],{x:${x},y:${y}});return [n.point.x,n.point.y]})()`); return R.at(p[0], p[1]); };
const node = async (name, x, y, pi = 0) => { const p = await R.ev(`(()=>{let b=null;for(const n of ${reg(name)}.paths[${pi}].nodes){const d=Math.hypot(n.x-${x},n.y-${y});if(!b||d<b[2])b=[n.x,n.y,d];}return b})()`); return R.at(p[0], p[1]); };
const way = async (pts, opt) => hand(await R.ats(pts), opt);
const start = async (name, clip, p) => { await R.put(p.x, p.y); await R.cursor(); await sleep(150); R.begin(name, clip); await R.hold(0.6); };
const finish = async (poster) => { await R.hold(1.4); await R.end(poster); };
const stroke = async (pts, opt = {}) => { await R.move(pts[0], opt.moveOpt); await R.hold(0.2); await R.press(); await R.hold(0.1); await R.trace(pts, opt); await R.hold(0.12); await R.release(); await R.hold(opt.after == null ? 0.5 : opt.after); };
const tool = async (t) => R.ev(`__editor.setTool(${JSON.stringify(t)})`);

const GLAND = [[1300, 990], [1322, 952], [1385, 936], [1447, 950], [1478, 990], [1523, 1003], [1550, 1040], [1552, 1100], [1528, 1150], [1478, 1168], [1428, 1135], [1392, 1155], [1340, 1140], [1322, 1085], [1298, 1045]];

const scenes = {
  /* 1. Open a library and pick an image */
  async open() {
    await R.load(0, { blank: true });
    await start("01-open", FULL, { x: 820, y: 560 });
    await R.click(await R.el("#openEmpty"), { after: 0.9 });
    await R.click(await R.el('#libList [data-act="use"]'), { after: 0.3 });
    await R.waitFor("!!__editor.S.img && !document.getElementById('openModal').classList.contains('show')"); await R.hold(1.1);
    await R.click(await R.el("#open"), { after: 0.9 });
    await R.click(await R.el('#libList [data-case="5"]'), { after: 0.2 });
    await R.waitFor("document.getElementById('previewImg').complete && document.getElementById('previewImg').naturalWidth>0"); await R.hold(1.5);
    await R.press(); await R.hold(0.1); await R.release();
    await R.waitFor("__editor.S.caseIndex===5 && !!__editor.S.img && document.getElementById('sessionName').textContent==='slide-06'"); await R.hold(0.4);
    await R.move({ x: 700, y: 600 }); await finish();
  },

  /* 2. Zoom, pan, fit */
  async zoom() {
    await R.load(SLIDE);
    await start("02-zoom", FULL, { x: 420, y: 520 });
    const g = await R.at(1560, 760); await R.move(g); await R.hold(0.3);
    await R.ev(`__key("<b>⌘</b> + scroll &nbsp;·&nbsp; or pinch", 508, 640, 2600)`); await R.hold(0.5);
    for (let i = 0; i < 26; i++) { await R.wheel(0, -4.4 * Math.sin((i + 0.5) / 26 * Math.PI), 4); await R.cursor(); }
    await R.hold(0.9);
    await R.ev(`__key("Drag empty space to move around", 508, 640, 2600)`);
    const e = await R.at(1500, 1010); await R.drag(e, { x: e.x + 150, y: e.y - 190 }, { dur: 1.3, after: 0.3 });
    await R.drag(null, { x: R.pos.x - 230, y: R.pos.y + 60 }, { dur: 1.1, after: 0.6 });
    await R.click(await R.el("#fit"), { after: 0.5 });
    await finish(0.45);
  },

  /* 3. Select a region: on the image, in the list, or N */
  async select() {
    await R.load(SLIDE);
    await start("03-select", { x: 232, y: 64, w: 1042, h: 650 }, { x: 420, y: 560 });
    await R.click(await R.at(1620, 600), { after: 1.1 });
    await R.click(await R.el("#queue .q-item:nth-child(4)"), { after: 1.3 });
    await R.move({ x: 800, y: 600 }); await R.key("n", { after: 1.3 });
    await R.key("n", { after: 0.7 });
    await finish(0.3);
  },

  /* 4. Move a node */
  async node() {
    await R.load(SLIDE); await view(1400, 480, 1830, 770, CBOX);
    await start("04-node", CANVAS, { x: 240, y: 430 });
    await R.click(await R.at(1640, 600), { after: 0.8 });
    const n = await node("region-04", 1659, 656);
    await R.drag(n, await R.at(1668, 716), { dur: 1.2, after: 0.5 });
    const n2 = await node("region-04", 1605, 651);
    await R.drag(n2, await R.at(1612, 700), { dur: 1.0, after: 0.3 });
    await R.move({ x: R.pos.x - 110, y: R.pos.y + 40 }); await finish();
  },

  /* 5. Bend the line */
  async bend() {
    await R.load(SLIDE); await view(1400, 480, 1830, 770, CBOX); await select("region-04");
    await start("05-bend", CANVAS, { x: 250, y: 420 });
    const a = await onLine("region-04", 1708, 610);
    await R.drag(a, { x: a.x + 30, y: a.y - 14 }, { dur: 1.1, after: 0.5 });
    const b = await onLine("region-04", 1536, 610);
    await R.drag(b, { x: b.x - 26, y: b.y + 6 }, { dur: 1.0, after: 0.3 });
    await R.move({ x: R.pos.x - 60, y: R.pos.y + 90 }); await finish();
  },

  /* 6. Add and remove nodes */
  async addnode() {
    await R.load(SLIDE); await view(1400, 480, 1830, 770, CBOX); await select("region-04");
    await start("06-add-remove-node", CANVAS, { x: 250, y: 420 });
    const a = await onLine("region-04", 1630, 652);
    await R.dbl(a, { after: 0.7 });
    await R.drag(null, await R.at(1640, 712), { dur: 1.1, after: 0.6 });
    await R.dbl(await node("region-04", 1576, 567), { after: 0.5 });
    await R.dbl(await node("region-04", 1566, 565), { after: 0.4 });
    await R.move({ x: R.pos.x - 70, y: R.pos.y + 110 }); await finish();
  },

  /* 7. Move a whole region */
  async moveregion() {
    await R.load(SLIDE); await view(1300, 440, 1930, 860, CBOX);
    await start("07-move-region", CANVAS, { x: 250, y: 430 });
    const a = await R.at(1640, 600);
    await R.drag(a, { x: a.x + 64, y: a.y - 22 }, { dur: 1.3, after: 0.5 });
    await R.drag(null, { x: a.x + 6, y: a.y + 4 }, { dur: 1.2, after: 0.3 });
    await R.move({ x: R.pos.x - 150, y: R.pos.y + 130 }); await finish(0.4);
  },

  /* 8. Draw a new region */
  async draw() {
    await R.load(SLIDE); await view(1180, 860, 1800, 1250, CBOX);
    await start("08-draw", CANVAS, { x: 300, y: 300 });
    await R.click(await R.el("#toolDraw"), { after: 0.5 });
    await stroke(await way(GLAND, { closed: true }), { speed: 215, after: 0.4 });
    await R.move({ x: R.pos.x - 120, y: R.pos.y + 150 }); await finish();
  },

  /* 9. Draw in several strokes: stop, continue from the orange end, close on the first node */
  async parts() {
    await R.load(SLIDE); await view(1180, 860, 1800, 1250, CBOX); await tool("draw");
    await start("09-draw-in-parts", CANVAS, { x: 300, y: 330 });
    const all = await way(GLAND, { closed: true }), cut1 = Math.round(all.length * 0.36), cut2 = Math.round(all.length * 0.7);
    await stroke(all.slice(0, cut1 + 1), { speed: 215, after: 0.3 });
    await R.move({ x: R.pos.x + 70, y: R.pos.y - 50 }); await R.hold(0.7);          // hand comes off, has a look
    const end = async () => { const p = await R.ev("(()=>{const n=__editor.S.draft.nodes;return [n[n.length-1].x,n[n.length-1].y]})()"); return R.at(p[0], p[1]); };
    let e = await end(); await stroke([e].concat(all.slice(cut1 + 1, cut2 + 1)), { speed: 215, after: 0.3 });
    await R.move({ x: R.pos.x - 80, y: R.pos.y + 40 }); await R.hold(0.6);
    e = await end(); await stroke([e].concat(all.slice(cut2 + 1)), { speed: 215, after: 0.4 });
    await R.move({ x: R.pos.x - 130, y: R.pos.y + 130 }); await finish();
  },

  /* 10. Fix a slip while drawing: drag back along the line, or Backspace for the last node */
  async undraw() {
    await R.load(SLIDE); await view(1180, 860, 1800, 1250, CBOX); await tool("draw");
    await start("10-undraw", CANVAS, { x: 300, y: 330 });
    const all = await way(GLAND, { closed: true }), k = Math.round(all.length * 0.3);
    const good = all.slice(0, k + 1), tip = good[good.length - 1];
    const slip = hand([tip, { x: tip.x + 34, y: tip.y - 30 }, { x: tip.x + 86, y: tip.y - 44 }, { x: tip.x + 132, y: tip.y - 30 }], { wobble: 0.5 });
    await R.move(good[0]); await R.hold(0.2); await R.press(); await R.hold(0.1);
    await R.trace(good, { speed: 215, ramp: 0.1 }); await R.trace(slip, { speed: 215, ramp: 0.2 });
    await R.hold(0.5);
    await R.trace(slip.slice().reverse(), { speed: 150, ramp: 0.2 }); await R.hold(0.3);
    await R.trace(all.slice(k), { speed: 215 }); await R.hold(0.12); await R.release(); await R.hold(0.4);
    await R.move({ x: R.pos.x - 120, y: R.pos.y + 140 }); await finish();
  },

  /* 11. Extend a region: start on its outline, draw the new edge, end on the outline */
  async extend() {
    await R.load(SLIDE); await view(1400, 480, 1830, 770, CBOX); await tool("draw");
    await start("11-extend", CANVAS, { x: 260, y: 430 });
    const a = await onLine("region-04", 1570, 640), b = await onLine("region-04", 1712, 702);
    const mid = await R.ats([[1578, 690], [1612, 728], [1662, 738], [1698, 722]]);
    await stroke(hand([a].concat(mid, [b]), { wobble: 0.7 }), { speed: 190, after: 0.5 });
    await R.move({ x: R.pos.x - 150, y: R.pos.y + 60 }); await finish();
  },

  /* 12. Trim a region: same move, drawn through the region */
  async trim() {
    await R.load(SLIDE); await view(-40, 1390, 390, 1680, CBOX); await tool("draw");
    await start("12-trim", CANVAS, { x: 560, y: 200 });
    const a = await onLine("region-03", 146, 1508), b = await onLine("region-03", 150, 1596);
    const mid = await R.ats([[136, 1532], [132, 1560], [140, 1582]]);
    await stroke(hand([a].concat(mid, [b]), { wobble: 0.6 }), { speed: 170, after: 0.5 });
    await R.move({ x: R.pos.x + 170, y: R.pos.y - 120 }); await finish();
  },

  /* 13. Cut a hole: draw a closed shape inside a region */
  async hole() {
    await R.load(SLIDE); await view(1560, 690, 1870, 900, CBOX); await tool("draw");
    await start("13-cut-hole", CANVAS, { x: 300, y: 420 });
    await stroke(await way([[1716, 808], [1725, 826], [1719, 850], [1704, 876], [1688, 884], [1684, 870], [1696, 846], [1704, 822]], { closed: true, wobble: 0.6 }), { speed: 170, after: 0.5 });
    await R.move({ x: R.pos.x - 170, y: R.pos.y + 70 }); await finish();
  },

  /* 14. Remove a hole: click inside it, press Delete */
  async unhole() {
    await R.load(SLIDE); await view(1560, 690, 1870, 900, CBOX);
    await R.ev(`(()=>{const r=${reg("region-02")},pts=[];for(let i=0;i<40;i++){const t=i/40*6.2832;pts.push({x:1782+21*Math.cos(t)+5*Math.cos(2*t),y:762+15*Math.sin(t)});}r.paths.push(G.fitClosed(pts,1.5));r.edited=true;__editor.refresh();})()`);
    await start("14-remove-hole", CANVAS, { x: 300, y: 420 });
    await R.click(await R.at(1782, 762), { after: 0.9 });
    await R.move({ x: R.pos.x + 150, y: R.pos.y + 110 });
    await R.key("Backspace", { cap: "Delete", after: 0.6 });
    await finish();
  },

  /* 15. Grow / shrink slider */
  async slider() {
    await R.load(SLIDE); await view(1260, 500, 1930, 1010, LBOX);
    await start("15-grow-shrink", LOW, { x: 600, y: 600 });
    await R.click(await R.at(1640, 600), { after: 0.7 });
    const s = await R.el("#slider"), t0 = await R.ev("+document.getElementById('slider').value");
    const X = (t) => s.l + 8 + (t - 0.05) / 0.9 * (s.w - 16);
    await R.move({ x: X(t0), y: s.y }); await R.hold(0.2); await R.press(); await R.hold(0.15);
    const glide = async (to, dur) => { const a = R.pos.x, n = Math.round(dur * 30); for (let i = 1; i <= n; i++) { const t = i / n, e = t * t * t * (10 - 15 * t + 6 * t * t); await R.put(a + (to - a) * e, s.y + Math.sin(t * 3) * 1.2); await sleep(45); await R.cursor(); await R.frame(); } };
    await glide(X(0.22), 1.6); await R.hold(0.7); await glide(X(0.72), 2.2); await R.hold(0.7); await glide(X(0.4), 1.3); await R.hold(0.3);
    await R.release(); await R.hold(0.7);
    await R.click(await R.el("#sliderReset"), { after: 0.6 });
    await finish(0.3);
  },

  /* 16. Delete a region */
  async del() {
    await R.load(SLIDE); await view(1250, 470, 1960, 1000, SBOX);
    await start("16-delete", SIDE, { x: 560, y: 470 });
    await R.click(await R.at(1640, 600), { after: 0.8 });
    await R.move({ x: 700, y: 470 });
    await R.key("Backspace", { cap: "Delete", bx: 712, by: 506, after: 0.7 });
    await finish();
  },

  /* 17. Undo and redo */
  async undo() {
    await R.load(SLIDE); await view(1330, 500, 1900, 760, { x: 380, y: 110, w: 520, h: 440 });
    const clip = { x: 356, y: 0, w: 920, h: 575 };
    await start("17-undo", clip, { x: 520, y: 480 });
    await R.click(await R.at(1640, 600), { after: 0.5 });
    await R.drag(await node("region-04", 1659, 656), await R.at(1700, 745), { dur: 1.0, after: 0.5 });
    await R.click(await R.el("#undo"), { after: 1.0 });
    await R.click(await R.el("#redo"), { after: 1.0 });
    await R.move({ x: 620, y: 500 });
    await R.ev(`__key("<b>⌘</b> <b>Z</b>", 816, 512, 1500)`); await R.hold(0.35);
    await R.ev("__editor.undo()"); await R.hold(0.6);
    await finish(0.35);
  },

  /* 18. Display helpers */
  async display() {
    await R.load(SLIDE); await view(1250, 470, 1960, 1000, SBOX);
    await R.ev(`(()=>{const r=${reg("region-04")},p=r.paths[0];G.moveNode(p,p.nodes.findIndex(n=>Math.round(n.x)===1659),{x:12,y:58});G.moveNode(p,p.nodes.findIndex(n=>Math.round(n.x)===1605),{x:8,y:46});r.edited=true;__editor.refresh();})()`);
    await start("18-display", SIDE, { x: 700, y: 420 });
    const o = await R.el("#opacity"), X = (v) => o.l + 8 + v / 0.8 * (o.w - 16);
    await R.move({ x: X(0.4), y: o.y }); await R.hold(0.2); await R.press(); await R.hold(0.1);
    const glide = async (to, dur) => { const a = R.pos.x, n = Math.round(dur * 30); for (let i = 1; i <= n; i++) { const t = i / n, e = t * t * t * (10 - 15 * t + 6 * t * t); await R.put(a + (to - a) * e, o.y); await R.cursor(); await R.frame(); } };
    await glide(X(0.05), 1.2); await R.hold(0.6); await glide(X(0.4), 1.1); await R.release(); await R.hold(0.4);
    await R.click(await R.el("#showModel"), { after: 1.6 }); await R.click(null, { after: 0.3 });
    await R.click(await R.el("#showHeat"), { after: 1.8 }); await R.click(null, { after: 0.3 });
    await finish(0.6);
  },

  /* 19. Mark done, next image */
  async done() {
    await R.load(SLIDE - 1); await R.ev("__editor.S.lib.cases[4].done && __editor.toggleDone()");
    await start("19-done-next", FULL, { x: 760, y: 560 });
    await R.click(await R.el("#doneBtn"), { after: 1.0 });
    await R.click(await R.el("#nextCase"), { after: 0.2 });
    await R.waitFor("__editor.S.caseIndex===5 && document.getElementById('sessionName').textContent==='slide-06'"); await R.hold(1.0);
    await R.click(await R.el("#prevCase"), { after: 0.2 });
    await R.waitFor("__editor.S.caseIndex===4 && document.getElementById('sessionName').textContent==='slide-05'"); await R.hold(0.6);
    await finish(0.3);
    await R.ev("__editor.S.lib.cases[4].done && __editor.toggleDone()");
  },

  /* 20. Export */
  async export() {
    await R.load(SLIDE);
    await start("20-export", { x: 300, y: 0, w: 980, h: 612 }, { x: 900, y: 420 });
    await R.click(await R.el("#export"), { after: 0.9 });
    await R.click(await R.el('input[name=exScope][value=library]'), { after: 0.6 });
    await R.click(await R.el('input[name=exFmt][value=overlay_png]'), { after: 0.3 });
    await R.click(await R.el('input[name=exFmt][value=roiset_zip]'), { after: 0.5 });
    await R.click(await R.el("#exGo"), { after: 0.1 });
    for (let i = 0; i < 400 && !(await R.ev("!!document.getElementById('exDone')")); i++) await R.hold(0.1);
    await R.hold(1.6);
    await R.click(await R.el("#exDone"), { after: 0.4 });
    await finish(0.8);
  },

  /* 21. Bring in your own images */
  async import() {
    await R.load(SLIDE);
    await start("21-import", FULL, { x: 900, y: 420 });
    await R.click(await R.el("#open"), { after: 0.9 });
    await R.move(await R.el("#libDrop")); await R.hold(1.6);
    await R.click(await R.el('#openTabs [data-tab="import"]'), { after: 1.8 });
    await R.click(await R.el('#openTabs [data-tab="libs"]'), { after: 0.6 });
    await finish(0.4);
  },
};

(async () => {
  const [lib, ...want] = process.argv.slice(2);
  if (!lib) { console.error("usage: node tutorial/make_tutorial.js <library id> [scene ...]"); process.exit(1); }
  R = await connect(lib);
  for (const name of want.length ? want : Object.keys(scenes)) {
    try { await scenes[name](); } catch (e) { console.error(name + " FAILED: " + e.message); R.on = false; }
  }
  R.close();
})();
