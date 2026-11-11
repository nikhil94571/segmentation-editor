/* Geometry for the segmentation editor. No DOM: runs in the browser and in node (tests).
 *
 * A PATH is { closed, nodes: [{x,y}], segs: [{c1:{x,y}, c2:{x,y}}] }.
 * segs[i] is a cubic Bezier from nodes[i] to nodes[i+1] (wrapping when closed) with control points c1, c2.
 * A straight segment simply has its control points on the chord. "Bending the line" moves c1/c2.
 */
(function (root) {
  const G = {};
  const P = (x, y) => ({ x, y });
  const add = (a, b) => P(a.x + b.x, a.y + b.y);
  const sub = (a, b) => P(a.x - b.x, a.y - b.y);
  const mul = (a, k) => P(a.x * k, a.y * k);
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const len = (a) => Math.hypot(a.x, a.y);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const norm = (a) => { const l = len(a); return l < 1e-12 ? P(0, 0) : P(a.x / l, a.y / l); };
  const neg = (a) => P(-a.x, -a.y);
  const lerp = (a, b, t) => P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  Object.assign(G, { P, add, sub, mul, dot, len, dist, norm, lerp });

  /* ---------- cubic Bezier: b = [p0, c1, c2, p3] ---------- */
  G.bez = (b, t) => {
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    return P(w0 * b[0].x + w1 * b[1].x + w2 * b[2].x + w3 * b[3].x, w0 * b[0].y + w1 * b[1].y + w2 * b[2].y + w3 * b[3].y);
  };
  G.splitBez = (b, t) => {
    const p01 = lerp(b[0], b[1], t), p12 = lerp(b[1], b[2], t), p23 = lerp(b[2], b[3], t);
    const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t), m = lerp(p012, p123, t);
    return [[b[0], p01, p012, m], [m, p123, p23, b[3]]];
  };
  G.reverseBez = (b) => [b[3], b[2], b[1], b[0]];
  G.bezLength = (b) => dist(b[0], b[1]) + dist(b[1], b[2]) + dist(b[2], b[3]);   // upper bound, cheap

  /* ---------- Schneider curve fitting (Graphics Gems, 1990) ----------
     Fits the fewest cubic Beziers through a polyline within maxErr (squared px). */
  function chordParams(d, first, last) {
    const u = [0];
    for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + dist(d[i], d[i - 1]));
    const total = u[u.length - 1] || 1;
    return u.map((v) => v / total);
  }
  function generateBezier(d, first, last, u, t1, t2) {
    const n = last - first + 1, p0 = d[first], p3 = d[last];
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    for (let i = 0; i < n; i++) {
      const t = u[i], s = 1 - t;
      const b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t;
      const a0 = mul(t1, b1), a1 = mul(t2, b2);
      c00 += dot(a0, a0); c01 += dot(a0, a1); c11 += dot(a1, a1);
      const tmp = sub(d[first + i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
      x0 += dot(a0, tmp); x1 += dot(a1, tmp);
    }
    const det = c00 * c11 - c01 * c01;
    let al = Math.abs(det) > 1e-12 ? (x0 * c11 - x1 * c01) / det : 0;
    let ar = Math.abs(det) > 1e-12 ? (c00 * x1 - c01 * x0) / det : 0;
    const seg = dist(p0, p3), eps = 1e-6 * seg;
    if (al < eps || ar < eps || al > seg * 3 || ar > seg * 3) al = ar = seg / 3;   // degenerate: Wu/Barsky fallback
    return [p0, add(p0, mul(t1, al)), add(p3, mul(t2, ar)), p3];
  }
  function maxError(d, first, last, b, u) {
    let max = 0, split = Math.floor((last - first + 1) / 2) + first;
    for (let i = first + 1; i < last; i++) {
      const p = G.bez(b, u[i - first]), e = (p.x - d[i].x) ** 2 + (p.y - d[i].y) ** 2;
      if (e >= max) { max = e; split = i; }
    }
    return [max, split];
  }
  function reparam(d, first, last, u, b) {
    const q1 = [0, 1, 2].map((i) => mul(sub(b[i + 1], b[i]), 3));
    const q2 = [0, 1].map((i) => mul(sub(q1[i + 1], q1[i]), 2));
    const quad = (q, t) => { const s = 1 - t; return add(add(mul(q[0], s * s), mul(q[1], 2 * s * t)), mul(q[2], t * t)); };
    return u.map((t, i) => {
      const p = G.bez(b, t), d1 = quad(q1, t), d2 = lerp(q2[0], q2[1], t), diff = sub(p, d[first + i]);
      const den = dot(d1, d1) + dot(diff, d2);
      return Math.abs(den) < 1e-12 ? t : Math.min(1, Math.max(0, t - dot(diff, d1) / den));
    });
  }
  function fitCubic(d, first, last, t1, t2, err, out) {
    if (last - first === 1) {
      const k = dist(d[first], d[last]) / 3;
      out.push([d[first], add(d[first], mul(t1, k)), add(d[last], mul(t2, k)), d[last]]);
      return;
    }
    let u = chordParams(d, first, last);
    let b = generateBezier(d, first, last, u, t1, t2);
    let [e, split] = maxError(d, first, last, b, u);
    if (e < err) { out.push(b); return; }
    if (e < err * 16) {
      for (let i = 0; i < 4; i++) {
        u = reparam(d, first, last, u, b);
        b = generateBezier(d, first, last, u, t1, t2);
        [e, split] = maxError(d, first, last, b, u);
        if (e < err) { out.push(b); return; }
      }
    }
    let tc = norm(sub(d[split - 1], d[split + 1]));
    if (len(tc) === 0) tc = norm(sub(d[split - 1], d[split]));
    fitCubic(d, first, split, t1, tc, err, out);
    fitCubic(d, split, last, neg(tc), t2, err, out);
  }
  function dedupe(pts) {
    const o = [];
    for (const p of pts) if (!o.length || dist(o[o.length - 1], p) > 1e-6) o.push(p);
    return o;
  }
  /* -> array of cubics. t1/t2: optional unit tangents at the ends (pointing INTO the curve). */
  G.fitCurve = (pts, err, t1, t2) => {
    const d = dedupe(pts);
    if (d.length < 2) return [];
    const n = d.length;
    t1 = t1 || norm(sub(d[Math.min(2, n - 1)], d[0]));
    t2 = t2 || norm(sub(d[Math.max(n - 3, 0)], d[n - 1]));
    const out = [];
    fitCubic(d, 0, n - 1, t1, t2, err, out);
    return out;
  };
  /* One cubic through pts with given end tangents (used when a node is removed). */
  G.fitSingle = (pts, t1, t2) => {
    const d = dedupe(pts), n = d.length;
    if (n < 2) return null;
    let u = chordParams(d, 0, n - 1), b = generateBezier(d, 0, n - 1, u, t1, t2);
    for (let i = 0; i < 4; i++) { u = reparam(d, 0, n - 1, u, b); b = generateBezier(d, 0, n - 1, u, t1, t2); }
    return b;
  };

  /* ---------- polylines ---------- */
  G.resample = (pts, step, closed) => {
    const src = closed ? pts.concat([pts[0]]) : pts, out = [src[0]];
    let carry = 0;
    for (let i = 1; i < src.length; i++) {
      const a = src[i - 1], b = src[i], L = dist(a, b);
      let s = step - carry;
      while (s <= L) { out.push(lerp(a, b, s / L)); s += step; }
      carry = (carry + L) % step;
    }
    if (closed) { if (out.length > 1 && dist(out[out.length - 1], out[0]) < step * 0.5) out.pop(); }
    else if (dist(out[out.length - 1], src[src.length - 1]) > 1e-6) out.push(src[src.length - 1]);
    return out;
  };
  G.polyArea = (pts) => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
    return a / 2;
  };
  function corners(pts, step) {
    const n = pts.length, w = Math.max(2, Math.round(10 / step)), h = Math.max(1, Math.round(w / 2));
    const ang = (i, k) => {
      const a = norm(sub(pts[i], pts[(i - k + n) % n])), b = norm(sub(pts[(i + k) % n], pts[i]));
      return Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI;
    };
    const A = pts.map((_, i) => ang(i, w)), out = [];
    for (let i = 0; i < n; i++) {
      if (A[i] < 60 || ang(i, h) < 45) continue;
      let isMax = true;
      for (let k = 1; k <= w && isMax; k++) if (A[(i + k) % n] > A[i] || A[(i - k + n) % n] >= A[i]) isMax = false;
      if (isMax) out.push(i);
    }
    return out;
  }

  /* ---------- paths ---------- */
  G.pathFromCubics = (cubics, closed) => ({
    closed,
    nodes: cubics.map((b) => P(b[0].x, b[0].y)).concat(closed || !cubics.length ? [] : [P(cubics[cubics.length - 1][3].x, cubics[cubics.length - 1][3].y)]),
    segs: cubics.map((b) => ({ c1: P(b[1].x, b[1].y), c2: P(b[2].x, b[2].y) })),
  });
  G.segCount = (path) => path.segs.length;
  G.cubic = (path, i) => [path.nodes[i], path.segs[i].c1, path.segs[i].c2, path.nodes[(i + 1) % path.nodes.length]];
  G.cubics = (path) => path.segs.map((_, i) => G.cubic(path, i));

  /* Dense outline ring (model output) -> closed curve path with few nodes. Sharp corners are kept. */
  G.fitClosed = (ring, tol) => {
    const step = 2.5, pts = G.resample(dedupe(ring), step, true), n = pts.length, err = tol * tol;
    if (n < 4) return G.pathFromCubics(G.fitCurve(pts.concat([pts[0]]), err), true);
    const cs = corners(pts, step);
    let cubics = [];
    if (!cs.length) {
      const t = norm(sub(pts[1], pts[n - 1]));                 // smooth across the join
      cubics = G.fitCurve(pts.concat([pts[0]]), err, t, neg(t));
    } else {
      for (let k = 0; k < cs.length; k++) {
        const a = cs[k], b = cs[(k + 1) % cs.length], span = [];
        for (let i = a; ; i = (i + 1) % n) { span.push(pts[i]); if (i === b && span.length > 1) break; }
        cubics = cubics.concat(G.fitCurve(span, err));
      }
    }
    return G.pathFromCubics(cubics, true);
  };
  G.fitOpen = (pts, tol) => G.pathFromCubics(G.fitCurve(pts, tol * tol), false);

  /* Points along a path. Each has {x, y, seg, t}. step in px. */
  G.flatten = (path, step) => {
    const out = [];
    for (let i = 0; i < path.segs.length; i++) {
      const b = G.cubic(path, i), k = Math.max(4, Math.min(200, Math.ceil(G.bezLength(b) / step)));
      for (let j = 0; j < k; j++) { const p = G.bez(b, j / k); out.push({ x: p.x, y: p.y, seg: i, t: j / k }); }
    }
    if (!path.closed && path.nodes.length) { const e = path.nodes[path.nodes.length - 1]; out.push({ x: e.x, y: e.y, seg: Math.max(0, path.segs.length - 1), t: 1 }); }
    return out;
  };
  G.pathArea = (path) => Math.abs(G.polyArea(G.flatten(path, 2)));
  G.bbox = (paths) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of paths) for (const q of G.flatten(p, 4)) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    return { x0, y0, x1, y1 };
  };

  /* Nearest point on a path: {seg, t, point, dist}. */
  G.nearest = (path, p) => {
    let best = null;
    for (let i = 0; i < path.segs.length; i++) {
      const b = G.cubic(path, i), k = Math.max(8, Math.min(120, Math.ceil(G.bezLength(b) / 3)));
      for (let j = 0; j <= k; j++) {
        const t = j / k, q = G.bez(b, t), d = dist(p, q);
        if (!best || d < best.dist) best = { seg: i, t, point: q, dist: d, k };
      }
    }
    if (!best) return null;
    const b = G.cubic(path, best.seg);
    let lo = Math.max(0, best.t - 1 / best.k), hi = Math.min(1, best.t + 1 / best.k);
    for (let i = 0; i < 20; i++) {
      const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      if (dist(p, G.bez(b, m1)) < dist(p, G.bez(b, m2))) hi = m2; else lo = m1;
    }
    const t = (lo + hi) / 2, q = G.bez(b, t);
    return { seg: best.seg, t, point: q, dist: dist(p, q) };
  };

  /* Insert a node on segment `seg` at parameter t. Returns the new node's index. Mutates path. */
  G.insertNode = (path, seg, t) => {
    const [l, r] = G.splitBez(G.cubic(path, seg), Math.min(0.999, Math.max(0.001, t)));
    path.segs.splice(seg, 1, { c1: l[1], c2: l[2] }, { c1: r[1], c2: r[2] });
    path.nodes.splice(seg + 1, 0, P(l[3].x, l[3].y));
    return seg + 1;
  };
  /* Remove node i, merging its two segments into one fitted curve. Returns false if not allowed. */
  G.removeNode = (path, i) => {
    const n = path.nodes.length;
    if (path.closed ? n <= 2 : n <= 2) return false;
    if (!path.closed && (i === 0 || i === n - 1)) {            // open end: just drop the end segment
      path.nodes.splice(i, 1); path.segs.splice(i === 0 ? 0 : i - 1, 1); return true;
    }
    const a = (i - 1 + n) % n, A = G.cubic(path, a), B = G.cubic(path, i), pts = [];
    for (let j = 0; j <= 16; j++) pts.push(G.bez(A, j / 16));
    for (let j = 1; j <= 16; j++) pts.push(G.bez(B, j / 16));
    let t1 = norm(sub(A[1], A[0])), t2 = norm(sub(B[2], B[3]));
    if (len(t1) === 0) t1 = norm(sub(pts[1], pts[0]));
    if (len(t2) === 0) t2 = norm(sub(pts[pts.length - 2], pts[pts.length - 1]));
    const m = G.fitSingle(pts, t1, t2);
    path.segs[a] = { c1: m[1], c2: m[2] };
    path.segs.splice(i, 1); path.nodes.splice(i, 1);
    return true;
  };
  /* Move a node; its two neighbouring control points travel with it so the local shape is kept. */
  G.moveNode = (path, i, d) => {
    const n = path.nodes.length;
    path.nodes[i] = add(path.nodes[i], d);
    if (i < path.segs.length) path.segs[i].c1 = add(path.segs[i].c1, d);
    const prev = path.closed ? (i - 1 + n) % n : i - 1;
    if (prev >= 0 && prev < path.segs.length) path.segs[prev].c2 = add(path.segs[prev].c2, d);
  };
  /* Bend a segment by dragging the point at parameter t by d (the line itself is the handle). */
  G.bendSeg = (path, seg, t, d) => {
    t = Math.min(0.9, Math.max(0.1, t));
    let w;
    if (t <= 1 / 6) w = 0;
    else if (t <= 0.5) w = Math.pow((6 * t - 1) / 2, 3) / 2;
    else if (t <= 5 / 6) w = (1 - Math.pow((6 * (1 - t) - 1) / 2, 3)) / 2 + 0.5;
    else w = 1;
    const s = path.segs[seg];
    s.c1 = add(s.c1, mul(d, (1 - w) / (3 * t * (1 - t) * (1 - t))));
    s.c2 = add(s.c2, mul(d, w / (3 * t * t * (1 - t))));
  };

  /* Reroute: replace the stretch of a closed path between where a stroke starts and ends (both on
     the border) with the stroke. Of the two possible results, keep the one with the larger area:
     a correction is smaller than the region it corrects. Returns a new path, or null. */
  G.reroute = (path, stroke, tol) => {
    if (!path.closed || stroke.length < 2) return null;
    const p = JSON.parse(JSON.stringify(path));
    const a = G.nearest(p, stroke[0]);
    G.insertNode(p, a.seg, a.t);
    const b = G.nearest(p, stroke[stroke.length - 1]);
    G.insertNode(p, b.seg, b.t);
    const n = p.nodes.length, near = (q) => { let bi = 0; for (let i = 1; i < n; i++) if (dist(p.nodes[i], q) < dist(p.nodes[bi], q)) bi = i; return bi; };
    const ib = near(b.point);
    let ia = 0, best = Infinity;
    for (let i = 0; i < n; i++) { const dd = dist(p.nodes[i], a.point); if (i !== ib && dd < best) { best = dd; ia = i; } }
    const pts = stroke.slice(); pts[0] = p.nodes[ia]; pts[pts.length - 1] = p.nodes[ib];
    const drawn = G.fitCurve(pts, tol * tol);
    if (!drawn.length) return null;
    const arc = (from, to) => { const o = []; for (let i = from; i !== to; i = (i + 1) % n) o.push(G.cubic(p, i)); return o; };
    const fwd = arc(ib, ia);                                    // b -> a, going forward
    const back = arc(ia, ib).reverse().map(G.reverseBez);       // b -> a, going the other way round
    const c1 = G.pathFromCubics(drawn.concat(fwd), true), c2 = G.pathFromCubics(drawn.concat(back), true);
    return G.pathArea(c1) >= G.pathArea(c2) ? c1 : c2;
  };

  /* Append fitted stroke cubics to an open draft path (or start one). */
  G.appendCubics = (draft, cubics) => {
    if (!cubics.length) return draft;
    if (!draft || !draft.nodes.length) return G.pathFromCubics(cubics, false);
    for (const b of cubics) { draft.segs.push({ c1: b[1], c2: b[2] }); draft.nodes.push(P(b[3].x, b[3].y)); }
    return draft;
  };
  /* Close an open draft: the last node is merged into the first. */
  G.closeDraft = (draft, snap) => {
    const n = draft.nodes.length;
    if (n < 3) return null;
    if (snap) {                                                 // last node sits on the start: drop it
      draft.nodes.pop();
    } else {                                                    // join with a straight closing segment
      const a = draft.nodes[n - 1], b = draft.nodes[0];
      draft.segs.push({ c1: lerp(a, b, 1 / 3), c2: lerp(a, b, 2 / 3) });
    }
    draft.closed = true;
    return draft;
  };

  if (typeof module !== "undefined" && module.exports) module.exports = G; else root.G = G;
})(typeof window !== "undefined" ? window : globalThis);
