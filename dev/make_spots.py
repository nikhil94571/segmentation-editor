"""Work out where the tour and the Tutorial recorder act on the BCSS practice-01, from its own geometry, and write
them into viewer/editor/demo-spots.js (the "bcss" set).

  .venv/bin/python dev/make_spots.py --main region-05 --second region-06     # after ml/predict.py --practice

The regions are the ones the editor itself makes from practice-01 (imported into a throw-away data folder).
"Draw a region the model missed" uses a real miss: the largest piece of the expert's tumour outline that the model
left out."""
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="spots-")
os.environ["PRACTICE_SET"] = "bcss"
sys.path.insert(0, str(ROOT))
import editor_backend as eb  # noqa: E402
from shapely.geometry import LineString, Point, Polygon  # noqa: E402
from shapely.ops import unary_union  # noqa: E402
from skimage.measure import approximate_polygon, find_contours, label, regionprops  # noqa: E402

ASPECT = 690 / 462                                              # the recorder's image window (CBOX)


def view(cx, cy, w, W, H, aspect=ASPECT):
    """A view w wide centred on (cx, cy), with the window's aspect, kept on the image where possible."""
    h = w / aspect
    x0, y0 = cx - w / 2, cy - h / 2
    x0 = min(max(x0, -w * 0.05), W - w * 0.95)
    y0 = min(max(y0, -h * 0.05), H - h * 0.95)
    return [round(x0), round(y0), round(x0 + w), round(y0 + h)]


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--main", help="the region the tour edits (default: chosen by shape and size)")
    ap.add_argument("--second", help="its neighbour, for the gap and the second correction")
    args = ap.parse_args()
    eb.list_libraries()
    sid = eb.open_library_case("practice", 0)["id"]
    meta = json.loads((eb._sdir(sid) / "meta.json").read_text())
    W, H = meta["width"], meta["height"]
    man = json.loads((ROOT / "data" / "practice-bcss" / "manifest.json").read_text())
    expert = np.asarray(Image.open(ROOT / "data" / "practice-bcss" / "expert" / f"{man['cases'][0]['name']}_expert.png"))
    regs = {}
    for r in meta["regions"]:
        rings = [np.asarray(x, float) for x in r["rings"]]
        poly = Polygon(rings[0], rings[1:]).buffer(0)
        regs[r["name"]] = {"poly": poly, "outer": Polygon(rings[0]).buffer(0), "ring": rings[0], "area": poly.area, "conf": r.get("mean_prob")}
    allp = unary_union([r["poly"] for r in regs.values()])
    img_area = W * H
    print(f"{len(regs)} regions:", {n: round(r['area'] / img_area * 100, 2) for n, r in regs.items()})

    def outside_all(p, margin=6):
        q = Point(p)
        return 0 < p[0] < W and 0 < p[1] < H and allp.distance(q) > margin and not allp.contains(q)

    # ---- the main region: mid-sized, compact, away from the edges; the second: its nearest mid-sized neighbour ----
    def fit(n):
        r = regs[n]; a = r["area"] / img_area
        x0, y0, x1, y1 = r["poly"].bounds
        if not (0.006 < a < 0.08) or x0 < 40 or y0 < 40 or x1 > W - 40 or y1 > H - 40:
            return -1
        return r["poly"].area / r["poly"].convex_hull.area - abs(a - 0.025) * 4
    main = args.main or max(regs, key=fit)
    assert args.main or fit(main) > 0, "no suitable main region"
    M = regs[main]
    others = [n for n in regs if n != main and regs[n]["area"] / img_area > 0.003]
    second = args.second or min(others, key=lambda n: regs[n]["poly"].distance(M["poly"]) if regs[n]["poly"].distance(M["poly"]) > 15 else 1e9)
    S2 = regs[second]
    cx, cy = M["poly"].representative_point().coords[0]
    x0, y0, x1, y1 = M["poly"].bounds
    size = max(x1 - x0, (y1 - y0) * ASPECT)
    work = view((x0 + x1) / 2, (y0 + y1) / 2, size * 1.55, W, H)
    print("main", main, "second", second, "work", work)

    ring = LineString(np.vstack([M["ring"], M["ring"][:1]]))
    L = ring.length

    def at(u, r=ring):
        p = r.interpolate((u % 1) * r.length)
        return [p.x, p.y]

    def normal(u, poly=M["outer"], r=ring):
        a, b = np.array(at(u - 0.004, r)), np.array(at(u + 0.004, r))
        t = (b - a) / (np.linalg.norm(b - a) + 1e-9)
        n = np.array([-t[1], t[0]])
        p = np.array(at(u, r))
        return n if not poly.contains(Point(p + n * 3)) else -n

    def bump(u0, span, depth, sign, r=ring, poly=M["outer"]):
        """Points between two outline points, pushed out (sign 1) or in (sign -1) by depth x the chord."""
        a, b = np.array(at(u0, r)), np.array(at(u0 + span, r))
        chord = np.linalg.norm(b - a)
        mids = []
        for f in (0.2, 0.4, 0.6, 0.8):
            p = np.array(at(u0 + span * f, r))
            nrm = normal(u0 + span * f, poly, r)
            mids.append((p + sign * nrm * depth * chord * np.sin(np.pi * f) ** 0.7).round(1).tolist())
        return [round(v, 1) for v in a], mids, [round(v, 1) for v in b]

    # extend: the stretch whose outward bump stays clear of everything
    best = None
    for k in range(40):
        u = k / 40
        a, mids, b = bump(u, 0.14, 0.35, 1)
        clear = min(allp.distance(Point(m)) if not M["poly"].contains(Point(m)) else -1 for m in mids)
        if all(outside_all(m, 4) for m in mids) and (best is None or clear > best[0]):
            best = (clear, u, a, mids, b)
    assert best, "no room to extend"
    u_ext = best[1]
    extend = {"a": best[2], "mid": best[3], "b": best[4]}

    # trim on the main region: a short inward chord, away from the extended stretch
    u_trim = (u_ext + 0.5) % 1
    a, mids, b = bump(u_trim, 0.07, 0.18, -1)
    trim_main = {"a": a, "mid": mids[1:3], "b": b}

    # nodes to move outward, then bends between and beside them (on the side between extend and trim)
    u_n = (u_ext + 0.28) % 1
    push = (work[2] - work[0]) * 0.12
    nodes = []
    for du in (0.0, 0.05):
        p = np.array(at(u_n + du)); nrm = normal(u_n + du)
        nodes.append({"from": p.round(1).tolist(), "to": (p + nrm * push).round(1).tolist()})
    mid_t = (np.array(nodes[0]["to"]) + np.array(nodes[1]["to"])) / 2
    nb = normal(u_n + 0.025)
    bends = [{"at": mid_t.round(1).tolist(), "by": (nb * push * 0.27).round(1).tolist()},
             {"at": at(u_n + 0.085), "by": (normal(u_n + 0.085) * push * 0.45).round(1).tolist()}]

    # a new region to draw: the largest compact lymphocyte cluster in the BCSS expert mask (code 3) that no region
    # touches. (On this image the model's misses all sit along existing edges, which Extend covers.)
    src = man["cases"][0]["source"]
    full = Image.open(ROOT / "data" / "bcss" / "masks" / src).resize((W, H), Image.Resampling.NEAREST)
    lab = label(np.asarray(full) == 3)
    outers = unary_union([r["outer"] for r in regs.values()])
    cands = []
    for r in regionprops(lab):
        if not (0.002 * img_area < r.area < 0.05 * img_area) or r.solidity < 0.6:
            continue
        crop = np.pad(lab[r.bbox[0]:r.bbox[2], r.bbox[1]:r.bbox[3]] == r.label, 2)
        c = max(find_contours(crop.astype(float), 0.5), key=len)
        poly = Polygon([(x + r.bbox[1] - 2, y + r.bbox[0] - 2) for y, x in c]).buffer(0)
        if poly.distance(outers) > 8:
            cands.append((r, c))
    if cands:
        r, c = max(cands, key=lambda rc: rc[0].area * rc[0].solidity)
        poly = Polygon([(x + r.bbox[1] - 2, y + r.bbox[0] - 2) for y, x in c]).buffer(0)
        rad = np.sqrt(poly.area) * 0.12                          # round off the annotation's zigzags, as a hand would
        poly = poly.buffer(rad).buffer(-rad * 1.4).buffer(rad * 0.4)
        poly = max(getattr(poly, "geoms", [poly]), key=lambda g: g.area)
        ext = LineString(poly.exterior.coords)
        loop = [[round(ext.interpolate(f * ext.length).x, 1), round(ext.interpolate(f * ext.length).y, 1)] for f in np.linspace(0, 1, 15, endpoint=False)]
        loop = [[min(max(x, 4), W - 4), min(max(y, 4), H - 4)] for x, y in loop]
        what = "lymphocytes"
        print("lymphocyte cluster:", r.area, "px,", len(loop), "points")
    else:                                                        # none: a blob in empty tissue
        ys, xs = np.mgrid[0:H:16, 0:W:16]
        d = np.array([[allp.distance(Point(x, y)) for x in xs[0]] for y in ys[:, 0]])
        iy, ix = np.unravel_index(d.argmax(), d.shape)
        c0, rr = (xs[0][ix], ys[iy][0]), min(140, d.max() * 0.6)
        loop = [[round(c0[0] + rr * np.cos(t) * (1 + 0.15 * np.sin(3 * t)), 1), round(c0[1] + rr * 0.8 * np.sin(t), 1)] for t in np.linspace(0, 2 * np.pi, 15, endpoint=False)]
        what = "tissue"
        print("no lymphocyte cluster clear of the regions; drawing in empty tissue")
    lp = np.array(loop)
    missed = {"view": view(lp[:, 0].mean(), lp[:, 1].mean(), max(np.ptp(lp[:, 0]), np.ptp(lp[:, 1]) * ASPECT) * 1.8, W, H), "loop": loop, "what": what}

    # measure view: main and second together; a drag and an empty spot in clear tissue
    both = unary_union([M["poly"], S2["poly"]]).bounds
    mv = view((both[0] + both[2]) / 2, (both[1] + both[3]) / 2, max(both[2] - both[0], (both[3] - both[1]) * ASPECT) * 1.3, W, H)
    grid = [(mv[0] + (mv[2] - mv[0]) * fx, mv[1] + (mv[3] - mv[1]) * fy) for fx in np.linspace(0.08, 0.92, 12) for fy in np.linspace(0.1, 0.9, 9)]
    clear = sorted((p for p in grid if outside_all(p, 10)), key=lambda p: -allp.distance(Point(p)))
    empty = [round(v) for v in clear[0]]
    dlen = (mv[2] - mv[0]) * 0.16
    drag = None
    for p in clear:
        for ang in (0.6, -0.6, 2.5, -2.5):
            q = (p[0] + dlen * np.cos(ang), p[1] + dlen * np.sin(ang))
            if outside_all(q, 8) and mv[0] < q[0] < mv[2] and mv[1] < q[1] < mv[3] and Point(p).distance(Point(empty)) > dlen * 0.6:
                drag = [[round(p[0]), round(p[1])], [round(q[0]), round(q[1])]]
                break
        if drag:
            break
    measure = {"view": mv, "drag": drag, "empty": empty, "pins": [at(u_n + 0.1), at(u_n + 0.32)]}

    # split: a straight line right through the main region, ends clear of every region
    split = None
    for ang in np.linspace(0, np.pi, 13)[:-1]:
        d = np.array([np.cos(ang), np.sin(ang)])
        half = max(x1 - x0, y1 - y0) * 0.75
        p0, p1 = np.array([cx, cy]) - d * half, np.array([cx, cy]) + d * half
        ln = LineString([p0, p1])
        xs_ = ln.intersection(M["poly"].boundary)                 # holes included: the editor will not cut through one
        n = len(getattr(xs_, "geoms", [xs_])) if not xs_.is_empty else 0
        if n == 2 and outside_all(p0, 8) and outside_all(p1, 8) and not any(ln.intersects(regs[o]["poly"]) for o in regs if o != main):
            pieces = M["poly"].difference(ln.buffer(0.5))
            parts = sorted(getattr(pieces, "geoms", [pieces]), key=lambda g: -g.area)
            if len(parts) >= 2 and parts[1].area > 0.3 * parts[0].area:
                split = {"line": [round(p0[0]), round(p0[1]), round(p1[0]), round(p1[1])], "drag": [round(cx), round(cy)],
                         "by": (np.array([-d[1], d[0]]) * push * 0.4).round(1).tolist()}
                break
    assert split, "no clean split line"

    # trim clip: another region, a short inward chord
    third = max((n for n in regs if n not in (main, second) and regs[n]["area"] / img_area > 0.003), key=lambda n: regs[n]["area"], default=second)
    T = regs[third]
    tring = LineString(np.vstack([T["ring"], T["ring"][:1]]))
    span = min(0.07, 180 / tring.length)                          # a short stretch, even on a big region
    best_t = None
    for k in range(20):                                           # a stretch well inside the image, so the view is not clipped
        ta, tmid, tb = bump(0.05 * k, span, 0.2, -1, tring, T["outer"])
        mx, my = (ta[0] + tb[0]) / 2, (ta[1] + tb[1]) / 2
        room = min(mx, my, W - mx, H - my)
        if all(T["poly"].contains(Point(m)) for m in tmid) and (best_t is None or room > best_t[0]):
            best_t = (room, ta, tmid, tb)
    _, ta, tmid, tb = best_t
    chord = np.hypot(tb[0] - ta[0], tb[1] - ta[1])
    trim = {"region": third, "view": view((ta[0] + tb[0]) / 2, (ta[1] + tb[1]) / 2, max(420, chord * 3), W, H),
            "a": ta, "mid": tmid[1:], "b": tb}

    # hole: inside the largest region, where it is thickest
    big = max(regs, key=lambda n: regs[n]["area"])
    B = regs[big]
    bx0, by0, bx1, by1 = B["poly"].bounds
    pts = [(x, y) for x in np.linspace(bx0, bx1, 40) for y in np.linspace(by0, by1, 40) if B["poly"].contains(Point(x, y))]
    hc = max(pts, key=lambda p: B["poly"].exterior.distance(Point(p)) if B["poly"].contains(Point(p).buffer(1)) else 0)
    depth = B["poly"].boundary.distance(Point(hc))
    hr = min(28, depth * 0.45)
    hole = {"region": big, "view": view(hc[0], hc[1], max(hr * 14, 300), W, H),
            "loop": [[round(hc[0] + hr * np.cos(t) * (1 + 0.18 * np.sin(2 * t)), 1), round(hc[1] + hr * 1.25 * np.sin(t), 1)] for t in np.linspace(0, 2 * np.pi, 9, endpoint=False)],
            "centre": [round(hc[0] + hr * 2.4), round(hc[1])] if B["poly"].contains(Point(hc[0] + hr * 2.4, hc[1]).buffer(30)) else [round(hc[0]), round(hc[1])]}

    # the email GIF: zoom on the main region, extend it, then trim it
    email = {"zoomAt": [round(cx), round(cy)], "region": main, "second": trim_main}   # both GIF corrections on one region, in view

    w0 = work[2] - work[0]
    spots = {
        "main": main, "second": second,
        "overview": [[round(cx), round(cy)], [round(v) for v in S2["poly"].representative_point().coords[0]], [round(W * 0.18), round(H * 0.55)]],
        "work": work, "extend": extend, "trimMain": trim_main, "missed": missed, "nodes": nodes, "bends": bends, "measure": measure,
        "zoom": {"at": [round(cx), round(cy)], "pan": [round(min(W - 60, cx + w0 * 0.3)), round(min(H - 60, cy + w0 * 0.4))]},
        "bendClip": [{"at": at(u_ext + 0.55), "by": (normal(u_ext + 0.55) * push * 0.35).round(1).tolist()},
                     {"at": at(u_ext + 0.8), "by": (normal(u_ext + 0.8) * push * 0.3).round(1).tolist()}],
        "addNode": {"at": at(u_n + 0.6), "to": (np.array(at(u_n + 0.6)) + normal(u_n + 0.6) * push * 0.9).round(1).tolist(),
                    "remove": [at(u_ext + 0.07), at(u_ext + 0.09)]},
        "moveView": view(cx, cy, w0 * 1.45, W, H), "trim": trim, "hole": hole,
        "barView": view(cx, cy + w0 * 0.08, w0 * 1.1, W, H, 690 / 380), "sideView": view(cx, cy, w0 * 1.65, W, H, 1),
        "lowView": view(cx, cy, w0 * 1.55, W, H, 1), "undoView": view(cx, cy, w0 * 1.3, W, H, 520 / 440),
        "undoNode": {"from": nodes[0]["from"], "to": (np.array(nodes[0]["from"]) + normal(u_n) * push * 1.4).round(1).tolist()},
        "split": split, "email": email,
    }
    js = ROOT / "viewer" / "editor" / "demo-spots.js"
    s = js.read_text()
    a, b = s.index("/* BCSS-SPOTS-START */"), s.index("/* BCSS-SPOTS-END */")
    body = "/* BCSS-SPOTS-START */\n  SPOTS.bcss = " + json.dumps(spots, separators=(", ", ": ")) + ";\n  "
    js.write_text(s[:a] + body + s[b:])
    print("wrote", js)


if __name__ == "__main__":
    main()
