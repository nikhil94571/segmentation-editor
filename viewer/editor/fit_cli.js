// The regions of an image nobody has edited, exactly as the editor draws them: the same curve fitting
// (geom.js, with the image's own tolerance) and the same flattening to points as the page uses when it exports.
// The server runs this for library exports, so an untouched image exports what the screen shows.
//   node viewer/editor/fit_cli.js <session meta.json>     -> [{name, rings: [[[x, y], ...], ...]}] on stdout
const G = require("./geom.js");
const fs = require("fs");
const meta = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const tol = meta.fit_tol || 3;                                   // FIT_TOL in app.js
const pts = (ring) => ring.map(([x, y]) => ({ x, y }));
const fit = (ring) => (meta.fit === "smooth"
  ? G.fitSmoothClosed(pts(ring), tol, 2, { w: meta.width, h: meta.height })
  : G.fitClosed(pts(ring), tol));
const out = meta.regions.map((r) => ({
  name: r.name,
  rings: r.rings.map(fit).filter((p) => p.nodes.length >= 1 && p.segs.length >= 1)
    .map((p) => G.flatten(p, 1).map((q) => [+q.x.toFixed(2), +q.y.toFixed(2)])),
})).filter((r) => r.rings.length);
process.stdout.write(JSON.stringify(out));
