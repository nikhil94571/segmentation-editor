"""Make realistic test cases from square ~2k H&E tiles (data/tissue_2k/), mirroring what a segmentation
model really produces. Per case:

  tissue.png    the original image (what the model was given; the lab always has it)
  prob.tif      the model's raw output: a float32 probability map (0-1 per pixel), soft at edges,
                confident in the middle, lower for its false positive, plus a few sub-threshold "maybe"
                areas. This is what a fine-tuned segmentation head outputs.
  mask.png      the model's mask = prob >= 0.5 (0/255), saved as-is (may contain small specks)
  overlay.png   the mask rendered in blue over the tissue (45% blend towards RGB 10,80,235): a
                visualisation for humans, i.e. "the screenshot". Not a model output.
  expert.png    the expert's annotation (ground truth): 3-4 purple-dense lobular areas, white lumen
                excluded. The model is deliberately imperfect against it (about 80%, like a real model in development): wobbly
                edges, part of one region missed, one false-positive area.

Every third tile also gets a 'grid' variant: the model output averaged over 100 px cells (positive cell
= mean probability >= 0.5).
"""
import json
import shutil
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image
from scipy import ndimage as ndi
from skimage.color import rgb2hed, rgb2hsv
from skimage.measure import label, regionprops
from skimage.morphology import disk, opening, remove_small_holes, remove_small_objects

BLUE, ALPHA = np.array([10, 80, 235], float), 0.45
CELL = 100


def shade(rgb, mask):
    out = rgb.astype(float)
    out[mask] = (1 - ALPHA) * out[mask] + ALPHA * BLUE
    return out.round().astype(np.uint8)


def tidy(m, white, h, w):
    m = m & ~white                                                       # lumen stays unshaded
    m = remove_small_holes(m, max_size=int(0.002 * h * w))               # solid blobs, like the example
    return remove_small_objects(m, max_size=int(0.002 * h * w))          # no stray fragments


def candidates(rgb):
    h, w = rgb.shape[:2]
    scale = max(h, w) / 2048
    hema = ndi.gaussian_filter(rgb2hed(rgb)[..., 0], 30 * scale)          # smoothed purple density
    hsv = rgb2hsv(rgb)
    white = opening((hsv[..., 1] < 0.12) & (hsv[..., 2] > 0.80), disk(int(4 * scale) or 1))
    cand = opening(hema > np.percentile(hema, 85), disk(int(6 * scale) or 1))   # whole lobular units
    lab = label(cand)
    regs = sorted([r for r in regionprops(lab) if r.area > 0.003 * h * w], key=lambda r: -r.area)
    return lab, regs, white, scale


def smooth(m, sigma):
    return ndi.gaussian_filter(m.astype(float), sigma) > 0.5


def expert_annotation(lab, regs, white, scale, rng, n):
    picks = [regs[rng.integers(0, min(3, len(regs)))]]                   # one large-ish, rest any size
    rest = [r for r in regs if r.label != picks[0].label]
    picks += [rest[i] for i in rng.choice(len(rest), n - 1, replace=False)]
    m = smooth(np.isin(lab, [r.label for r in picks]), 8 * scale)
    h, w = m.shape
    return tidy(m, white, h, w), {r.label for r in picks}


def model_prediction(expert, lab, regs, used, white, scale, rng):
    """Imperfect copy of the expert annotation: the usual kinds of model error."""
    h, w = expert.shape
    # 1. wobbly boundary: shift the edge in/out by a smooth random amount (typically <15 px)
    sd = ndi.distance_transform_edt(expert) - ndi.distance_transform_edt(~expert)
    noise = ndi.gaussian_filter(rng.standard_normal((h, w)), 40 * scale)
    m = sd + noise * (8 * scale / noise.std()) > 0
    # 2. under-highlight: miss a chunk of one region
    parts = regionprops(label(expert))
    r = parts[rng.integers(len(parts))]
    cy, cx = r.coords[rng.integers(len(r.coords))]
    yy, xx = np.ogrid[:h, :w]
    m &= (yy - cy) ** 2 + (xx - cx) ** 2 > (0.30 * np.sqrt(r.area)) ** 2
    # 3. over-highlight: flag one extra purple-dense area that the expert did not
    small = np.median([q.area for q in regs if q.label in used])           # a modest extra area, not a huge one
    unused = [q for q in regs if q.label not in used and q.area <= small]
    fp = np.zeros_like(m)
    if unused:
        pick = unused[rng.integers(len(unused))]
        fp = smooth(lab == pick.label, 8 * scale) & ~white
        unused = [q for q in unused if q.label != pick.label]
    m = tidy(smooth(m, 3 * scale), white, h, w)
    return m, fp, unused


def model_probability(m, fp, maybes, white, scale, rng):
    """Soft probability map like a segmentation head's sigmoid output: ~0.9+ inside confident regions,
    a smooth ramp across edges, a lower plateau (~0.6-0.7) on the false positive, sub-threshold
    (~0.3-0.45) 'maybe' areas elsewhere, and a little pixel noise."""
    ramp = 3 * scale
    def soft(region, peak):
        sd = ndi.distance_transform_edt(region) - ndi.distance_transform_edt(~region)
        return peak / (1 + np.exp(np.clip(-sd / ramp, -50, 50)))
    p = soft(m, 0.95)
    if fp.any():
        p = np.maximum(p, soft(fp, rng.uniform(0.6, 0.72)))
    for q in maybes:
        p = np.maximum(p, soft(q, rng.uniform(0.3, 0.45)))
    p = p + ndi.gaussian_filter(rng.standard_normal(p.shape), 1.5) * 0.04
    p[white] *= 0.3                                                      # lumen: model mostly says no
    return np.clip(p, 0, 1).astype(np.float32)


def to_grid(prob, cell=CELL):
    """Cell-level output: every pixel in a cell gets the cell's mean probability."""
    h, w = prob.shape
    g = np.zeros_like(prob)
    for y in range(0, h, cell):
        for x in range(0, w, cell):
            g[y:y + cell, x:x + cell] = prob[y:y + cell, x:x + cell].mean()
    return g


def dice(a, b):
    return 2 * (a & b).sum() / max(a.sum() + b.sum(), 1)


def main(src_dir="data/tissue_2k", out_dir="data/cases", grid_every=3, seed=7):
    rng = np.random.default_rng(seed)
    out_dir = Path(out_dir)
    shutil.rmtree(out_dir, ignore_errors=True)
    index = []
    for i, p in enumerate(sorted(Path(src_dir).glob("*.png"))):
        rgb = np.asarray(Image.open(p).convert("RGB"))
        lab, regs, white, scale = candidates(rgb)
        n = min(int(rng.integers(3, 5)), len(regs) - 1)                  # keep one spare for the false positive
        if n < 2:
            print("skip (not enough purple-dense areas):", p.name)
            continue
        expert, used = expert_annotation(lab, regs, white, scale, rng, n)
        m, fp, unused = model_prediction(expert, lab, regs, used, white, scale, rng)
        maybes = [lab == q.label for q in (unused[:2] if unused else [])]
        prob = model_probability(m, fp, maybes, white, scale, rng)
        variants = [("regions", prob)]
        if i % grid_every == 0:
            variants.append(("grid", to_grid(prob)))
        for kind, pr in variants:
            mask = pr >= 0.5
            case = out_dir / f"{p.stem}__{kind}"
            case.mkdir(parents=True)
            Image.fromarray(rgb).save(case / "tissue.png")
            tifffile.imwrite(case / "prob.tif", pr)
            Image.fromarray((mask * 255).astype(np.uint8)).save(case / "mask.png")
            Image.fromarray(shade(rgb, mask)).save(case / "overlay.png")
            Image.fromarray((expert * 255).astype(np.uint8)).save(case / "expert.png")
            index.append({"case": case.name, "source": p.stem, "kind": kind,
                          "model_vs_expert_dice": round(dice(mask, expert), 3)})
            print(f"{case.name:36s} {rgb.shape[1]}x{rgb.shape[0]}  mask regions="
                  f"{label(mask, connectivity=2).max()}  model vs expert Dice={dice(mask, expert):.3f}")
    (out_dir / "index.json").write_text(json.dumps(index, indent=1))


if __name__ == "__main__":
    main()
