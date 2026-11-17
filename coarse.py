"""Coarse (tiled) model output -> smooth outlines.

Many segmentation models answer once per tile, not once per pixel (a vision transformer gives one answer per
16 x 16 patch, for example). Their mask, enlarged to the image, is a staircase of tiles; traced as it is, every
stair corner becomes a node. This module recognises such output and rebuilds a smooth probability field at the
image's size, so the outline follows what the model meant rather than the tiles it answered in.

  grid = read_npz(path)                      # a model's raw output saved with numpy (.npz), found by content
  g = detect_grid(mask)                      # a full-size mask or map that is really a grid of tiles -> Grid
  field = upsample(values, shape)            # tile values -> a smooth field at the image's size

The grid is mapped onto the image the way an even stretch maps it: tile j covers pixels [j*W/w, (j+1)*W/w), so
its centre is at (j + 0.5) * W/w - 0.5 in pixel coordinates. Getting that centre right matters: placing values
at tile corners instead would shift every outline by half a tile.
"""
from dataclasses import dataclass

import numpy as np
from scipy import ndimage as ndi

MIN_CELL = 4            # px: finer than this is treated as ordinary per-pixel output
EPS = 1e-4


@dataclass
class Grid:
    rows: int
    cols: int
    kind: str = "stretch"   # "stretch": tile j covers [j*W/w, (j+1)*W/w); "fixed": tiles of k px, the last one wider


def _pixel_to_cell(n_px, n_cells, kind):
    """Index of the tile each pixel falls in."""
    i = np.arange(n_px)
    if kind == "stretch":
        return (i * n_cells) // n_px
    k = n_px // n_cells
    return np.minimum(i // k, n_cells - 1)


def _cell_coord(n_px, n_cells, kind):
    """Continuous tile coordinate of each pixel centre (0 = centre of the first tile)."""
    i = np.arange(n_px, dtype=float)
    if kind == "stretch":
        return (i + 0.5) * n_cells / n_px - 0.5
    k = n_px // n_cells
    return np.minimum((i + 0.5) / k - 0.5, n_cells - 1.0)


def expand(values, shape, kind="stretch"):
    """Tile values -> image size, each tile filled with its own value (the staircase, as the model's mask has it)."""
    ry = _pixel_to_cell(shape[0], values.shape[0], kind)
    rx = _pixel_to_cell(shape[1], values.shape[1], kind)
    return values[ry][:, rx]


def upsample(values, shape, kind="stretch", order=3):
    """Tile values -> a smooth field at image size, each tile's value placed at the tile's centre."""
    v = _cell_coord(shape[0], values.shape[0], kind)
    u = _cell_coord(shape[1], values.shape[1], kind)
    vv, uu = np.meshgrid(v, u, indexing="ij")
    return ndi.map_coordinates(values.astype(np.float32), [vv, uu], order=order, mode="nearest", prefilter=order > 1)


def to_logit(p):
    p = np.clip(p, EPS, 1 - EPS)
    return np.log(p / (1 - p))


def smooth_probability(prob_grid, shape, kind="stretch", blur=0.0):
    """Probabilities per tile -> probabilities per pixel. Interpolated as logits (the model's own scale, where
    a confident tile is not flattened towards 0.5 by its neighbours), then turned back into probabilities.
    blur (in tiles) first evens out tile-to-tile jitter, so the outline does not wiggle wherever neighbouring
    tiles sit either side of the cut-off."""
    lg = to_logit(prob_grid)
    if blur > 0:
        lg = ndi.gaussian_filter(lg, blur, mode="nearest")
    return (1 / (1 + np.exp(-upsample(lg, shape, kind)))).astype(np.float32)


def smooth_mask(mask_grid, shape, kind="stretch", blur=0.0):
    """A yes/no tile grid (no probabilities given) -> a smooth 0..1 field whose 0.5 line rounds off the stairs."""
    g = mask_grid.astype(np.float32)
    if blur > 0:
        g = ndi.gaussian_filter(g, blur, mode="nearest")
    return np.clip(upsample(g, shape, kind), 0, 1).astype(np.float32)


def tile_centres(shape, rows, cols, kind="stretch"):
    """Pixel (row, column) of every tile's centre, as two (rows, cols) arrays."""
    cy = np.minimum(np.floor(_centres(shape[0], rows, kind)).astype(int), shape[0] - 1)
    cx = np.minimum(np.floor(_centres(shape[1], cols, kind)).astype(int), shape[1] - 1)
    return np.meshgrid(cy, cx, indexing="ij")


def _stamp(m, y, x, r, value):
    y0, y1, x0, x1 = max(0, int(y - r) - 1), min(m.shape[0], int(y + r) + 2), max(0, int(x - r) - 1), min(m.shape[1], int(x + r) + 2)
    yy, xx = np.ogrid[y0:y1, x0:x1]
    m[y0:y1, x0:x1][(yy - y) ** 2 + (xx - x) ** 2 <= r * r] = value


def respect_tiles(mask, yes, kind="stretch", close_r=0, min_r=0.0):
    """Tidy a smooth mask without ever overruling the model where it answered.

    mask: the smooth decision at every pixel; yes: the model's own yes/no per tile. The smooth mask only decides
    what happens between tile centres, so:
      - narrow gaps and notches (narrower than 2 * close_r) are closed, unless one holds a tile the model said no to;
      - specks the smoothing made between tiles are removed, but never a region holding a tile the model said yes to;
      - pinholes are filled, but never a hole holding a tile the model said no to;
      - every tile centre ends up on the model's side, and a region or hole the model marked is at least min_r px
        in radius, so a one-tile mark stays visible and clickable (deleting one is easier than finding one)."""
    from skimage.morphology import disk
    m = mask.copy()
    yy, xx = tile_centres(m.shape, yes.shape[0], yes.shape[1], kind)
    yin, xin, yout, xout = yy[yes], xx[yes], yy[~yes], xx[~yes]
    if close_r:
        pad = 2 * close_r
        closed = ndi.binary_closing(np.pad(m, pad, mode="edge"), disk(close_r))[pad:-pad, pad:-pad]
        added = closed & ~m
        lab, _ = ndi.label(added)
        m |= added & ~np.isin(lab, np.unique(lab[yout, xout])[1:])
    lab, n = ndi.label(m, structure=np.ones((3, 3)))
    keep = np.zeros(n + 1, bool)
    keep[lab[yin, xin]] = True
    keep[0] = False
    m = keep[lab]
    lab, n = ndi.label(~m)
    hole_kept = np.zeros(n + 1, bool)
    hole_kept[lab[yout, xout]] = True
    m |= ~hole_kept[lab] & (lab > 0)
    if min_r:
        area = np.pi * min_r * min_r
        for want, ys, xs in ((True, yin, xin), (False, yout, xout)):
            lab, _ = ndi.label(m if want else ~m, structure=np.ones((3, 3)) if want else None)
            sizes = np.bincount(lab.ravel())
            for y, x in zip(ys, xs):
                if lab[y, x] == 0 or sizes[lab[y, x]] < area:
                    _stamp(m, y, x, min_r, want)
    return m


def _transitions(a, axis):
    d = a[:, 1:] != a[:, :-1] if axis == 1 else a[1:, :] != a[:-1, :]
    return np.nonzero(d.any(axis=0 if axis == 1 else 1))[0] + 1


def _cells_along(a, axis):
    """Candidate tile counts along one axis, from the spacing of value changes."""
    n_px = a.shape[axis]
    t = _transitions(a, axis)
    if len(t) == 0:
        return []
    edges = np.concatenate([[0], t, [n_px]])
    gap = np.diff(edges)
    g = int(gap[1:-1].min()) if len(gap) > 2 else int(gap.min())
    if g < MIN_CELL:
        return []
    out = set()
    for size in (g - 1, g, g + 1, g + 2):
        if size >= MIN_CELL:
            for n in (n_px // size - 1, n_px // size, n_px // size + 1, round(n_px / size)):
                if n >= 1:
                    out.add(int(n))
    return sorted(out)


def detect_grid(a, min_agree=0.9995):
    """A full-size 2-D map that is constant over tiles -> Grid, else None. Works on masks and on probability maps
    that were enlarged without smoothing."""
    a = np.asarray(a)
    if a.ndim != 2 or min(a.shape) < 2 * MIN_CELL:
        return None
    rows, cols = _cells_along(a, 0), _cells_along(a, 1)
    if not rows or not cols:
        return None
    best = None
    for kind in ("stretch", "fixed"):
        for h in rows:
            for w in cols:
                if a.shape[0] / h < MIN_CELL or a.shape[1] / w < MIN_CELL:
                    continue
                g = sample(a, Grid(h, w, kind))
                agree = float((expand(g, a.shape, kind) == a).mean())
                if agree >= min_agree and (best is None or agree > best[0]):
                    best = (agree, Grid(h, w, kind))
        if best and best[0] == 1.0:
            break
    return best[1] if best else None


def sample(a, grid):
    """The value at each tile's centre pixel."""
    cy = np.minimum(np.floor(_centres(a.shape[0], grid.rows, grid.kind)).astype(int), a.shape[0] - 1)
    cx = np.minimum(np.floor(_centres(a.shape[1], grid.cols, grid.kind)).astype(int), a.shape[1] - 1)
    return a[cy][:, cx]


def _centres(n_px, n_cells, kind):
    j = np.arange(n_cells, dtype=float)
    if kind == "stretch":
        return (j + 0.5) * n_px / n_cells
    k = n_px // n_cells
    return np.minimum((j + 0.5) * k, n_px - 1)


def read_npz(path):
    """A model's raw output saved with numpy, recognised by what it holds rather than by key names:
    a 2-D array of probabilities (0..1), or of scores before the sigmoid (logits), or a yes/no mask; a single
    number between 0 and 1 (the cut-off), a pair of whole numbers (the image's height and width), and a name.
    -> {"prob": 2-D array, "threshold": float or None, "shape": (H, W) or None, "source": str or None,
        "from": which array was used}  or None if nothing usable is inside."""
    with np.load(path, allow_pickle=False) as z:
        arrs = {k: z[k] for k in z.files}
    probs, logits, masks = [], [], []
    threshold = shape = source = None
    for k, a in arrs.items():
        name = k.lower()
        if a.ndim == 2 and a.size > 1:
            if a.dtype == bool or (a.dtype.kind in "iu" and set(np.unique(a)) <= {0, 1}):
                masks.append((k, a.astype(bool)))
            elif a.dtype.kind == "f":
                if np.nanmin(a) >= 0 and np.nanmax(a) <= 1:
                    probs.append((("prob" not in name), k, a))
                else:
                    logits.append((("logit" not in name), k, a))
        elif a.ndim == 0 and a.dtype.kind == "f" and 0 < float(a) < 1 and (threshold is None or "thr" in name):
            threshold = float(a)
        elif a.ndim == 1 and a.size == 2 and a.dtype.kind in "iu" and min(a) > 0:
            shape = (int(a[0]), int(a[1]))
        elif a.ndim == 0 and a.dtype.kind == "U":
            source = str(a)
    if probs:
        _, used, p = sorted(probs, key=lambda t: t[0])[0]
    elif logits:
        _, used, lg = sorted(logits, key=lambda t: t[0])[0]
        p = 1 / (1 + np.exp(-lg.astype(np.float64)))
    elif masks:
        used, m = masks[0]
        p = m.astype(np.float32)
        threshold = 0.5
    else:
        return None
    return {"prob": np.asarray(p, np.float32), "threshold": threshold, "shape": shape, "source": source, "from": used,
            "binary": not probs and not logits}
