"""Synthetic test folders shaped like a tiled (patch-based) segmentation model's output.

For each tissue image in data/tissue_2k/ (and its simulated expert mask from make_cases.py), this writes one
folder holding what such a pipeline hands over:

  <id>.tif                                  the original, larger than what the model saw (same proportions),
                                            with the expert's outlines saved inside it as ImageJ shapes, in µm
  <id>_lesion_raw_prediction.npz            the model's raw output, one value per tile:
                                              logits (float32), probabilities (float32, sigmoid of logits),
                                              predicted_mask (bool, probabilities > cut-off),
                                              probability_threshold (float64 0-d), original_shape (int64, H W),
                                              source_filename (str)
  <id>_predicted_lesion_imagej_mask.tif     the mask enlarged to the image by nearest neighbour: uint8 0 / 255
  <id>_predicted_lesion_imagej.tif          the image the model saw, with the tiled outlines as ImageJ shapes
                                            (a point at every pixel step, as an outline traced around pixels has)
  <id>_predicted_lesion_overlay.png         the prediction shaded cyan (a picture, not data)
  <id>_lesion_probability_heatmap.png       the probabilities as a colour map (a picture, not data)
  <id>_prediction_with_gt_overlay.png       prediction and expert outline together (a picture)
  README_segmentation_outputs.md

The format copied: the image the model saw is 2048 x 2467; the grid is 128 x 154 tiles, stretched evenly over the
image (tile j covers pixels [j*W/w, (j+1)*W/w), so tiles are 16 x 16.02 px); the cut-off is 0.675 stored as
float32 widened to float64; logits run from about -8 to +12; the original is 7040 x 5842 (about 2.85 times
larger) with an ImageJ resolution of 2.89 px per µm.
Not copied: the tissue (breast H&E from data/tissue_2k), the target shapes (simulated gland outlines from
make_cases.py, smaller than typical regions), and the word in the file names ("lesion"), so that nothing in the
editor can depend on one pipeline's names.

  .venv/bin/python make_cases.py                      # once: the simulated expert masks (data/cases/)
  .venv/bin/python dev/make_coarse_cases.py           # -> data/synthetic/ (not in the repository)
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image
from scipy import ndimage as ndi
from shapely.geometry import box
from shapely.ops import unary_union
from skimage.measure import approximate_polygon, find_contours, label

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import coarse  # noqa: E402
import highlight2imagej as h2  # noqa: E402
from roifile import ImagejRoi, ROI_TYPE  # noqa: E402

H, W = 2048, 2467                 # the image the model saw
ROWS, COLS = 128, 154             # its tiles
THRESHOLD = np.float64(np.float32(0.675))
ORIGINAL_SIZE = (7040, 5842)      # the original's width and height (2.854 x what the model saw)
PX_PER_UM = 2.89                  # the original's ImageJ resolution
WORD = "lesion"


def model_view(rgb, mask):
    """Scale and crop a tissue image (and its mask) to the model's 2048 x 2467 view."""
    h, w = rgb.shape[:2]
    k = max(W / w, H / h)
    size = (round(w * k), round(h * k))
    big = np.asarray(Image.fromarray(rgb).resize(size, Image.LANCZOS))
    m = np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).resize(size, Image.BILINEAR)) > 127
    y0, x0 = (size[1] - H) // 2, (size[0] - W) // 2
    return big[y0:y0 + H, x0:x0 + W], m[y0:y0 + H, x0:x0 + W]


def simulate(gt, rng):
    """A patch model's logits: one per tile, high where the tile is mostly target, with errors that are
    correlated between neighbouring tiles, a few confident false detections and a few misses."""
    g = coarse.Grid(ROWS, COLS, "stretch")
    ry = coarse._pixel_to_cell(H, ROWS, "stretch")
    rx = coarse._pixel_to_cell(W, COLS, "stretch")
    cover = np.zeros((ROWS, COLS))
    np.add.at(cover, (ry[:, None].repeat(W, 1), rx[None, :].repeat(H, 0)), gt)
    cover /= np.bincount(ry)[:, None] * np.bincount(rx)[None, :]
    noise = ndi.gaussian_filter(rng.normal(size=(ROWS, COLS)), 1.5)
    noise *= 1.3 / max(noise.std(), 1e-9)
    logit = 10.0 * (cover - 0.42) + noise - 1.5
    for _ in range(rng.integers(2, 5)):                    # confident detections where there is no target
        cy, cx = rng.integers(4, ROWS - 4), rng.integers(4, COLS - 4)
        r = rng.uniform(0.8, 2.2)
        yy, xx = np.ogrid[:ROWS, :COLS]
        logit += 7.0 * np.exp(-((yy - cy) ** 2 + (xx - cx) ** 2) / (2 * r * r))
    for _ in range(rng.integers(1, 3)):                    # target the model misses
        cy, cx = rng.integers(4, ROWS - 4), rng.integers(4, COLS - 4)
        yy, xx = np.ogrid[:ROWS, :COLS]
        logit -= 6.0 * np.exp(-((yy - cy) ** 2 + (xx - cx) ** 2) / (2 * 2.0 ** 2))
    logit = np.clip(logit, -7.9, 11.6).astype(np.float32)
    prob = (1 / (1 + np.exp(-logit.astype(np.float64)))).astype(np.float32)
    return g, logit, prob


def tile_edges(n_px, n):
    """Pixel position where each tile starts (and the end), for tiles stretched evenly."""
    return np.array([-(-j * n_px // n) for j in range(n + 1)], float)


def densify(ring):
    """A point at every pixel step along an axis-aligned outline."""
    out = []
    for a, b in zip(ring, np.vstack([ring[1:], ring[:1]])):
        steps = int(round(max(abs(b[0] - a[0]), abs(b[1] - a[1]))))
        for t in range(max(steps, 1)):
            out.append(a + (b - a) * t / max(steps, 1))
    return np.asarray(out, np.float32)


def tile_rois(pred):
    """The predicted tiles as ImageJ polygons along the pixel edges, one per connected piece."""
    by, bx = tile_edges(H, ROWS), tile_edges(W, COLS)
    shapes = unary_union([box(bx[j], by[i], bx[j + 1], by[i + 1]) for i, j in zip(*np.nonzero(pred))])
    polys = list(getattr(shapes, "geoms", [shapes]))
    polys.sort(key=lambda p: (p.bounds[1], p.bounds[0]))
    rois = []
    for k, p in enumerate(polys, 1):
        outer = densify(np.asarray(p.exterior.coords)[:-1])
        holes = [densify(np.asarray(r.coords)[:-1]) for r in p.interiors]
        rois += h2.imagej_rois(f"Predicted {WORD} {k:03d}", outer, holes)
    return rois


def hand_rois(gt, scale):
    """The expert's outlines as an annotator draws them: a few dozen to a few hundred points per region,
    at the original's scale."""
    rois = []
    lab = label(gt, connectivity=2)
    for k in range(1, lab.max() + 1):
        m = np.pad(lab == k, 1)
        if m.sum() < 400:
            continue
        c = max(find_contours(m.astype(float), 0.5), key=len)
        c = approximate_polygon(c, 2.5)[:-1]
        xy = (c[:, ::-1] - 1 + 0.5) * scale
        roi = ImagejRoi.frompoints(xy.astype(np.float32), name=f"{int(xy[:, 0].mean())}-{int(xy[:, 1].mean())}")
        roi.roitype = ROI_TYPE.POLYGON
        rois.append(roi)
    return rois


def jet(v):
    stops = np.array([0, .125, .375, .625, .875, 1])
    cols = np.array([[0, 0, .5], [0, 0, 1], [0, 1, 1], [1, 1, 0], [1, 0, 0], [.5, 0, 0]])
    return (np.stack([np.interp(v, stops, cols[:, i]) for i in range(3)], -1) * 255).astype(np.uint8)


def shade(rgb, mask, colour, alpha):
    out = rgb.astype(float)
    out[mask] = (1 - alpha) * out[mask] + alpha * np.asarray(colour, float)
    return out.round().astype(np.uint8)


README = """# Segmentation output (synthetic test data)

Made by dev/make_coarse_cases.py to look like a tiled segmentation model's output folder. Not real data.

- `<id>.tif`: the original image, larger than what the model saw, with an expert's reference outlines inside
  it as ImageJ shapes. These outlines are the answer, not the model's prediction.
- `<id>_predicted_{w}_imagej_mask.tif`: the prediction at the size the model saw, 0 or 255, enlarged from the
  tiles without smoothing.
- `<id>_predicted_{w}_imagej.tif`: that image with the prediction's outlines as ImageJ shapes.
- `<id>_{w}_raw_prediction.npz`: the model's own output, one value per tile: `logits`, `probabilities`,
  `predicted_mask` (probabilities > `probability_threshold`), `original_shape` and `source_filename`.
- `<id>_predicted_{w}_overlay.png`, `<id>_{w}_probability_heatmap.png`, `<id>_prediction_with_gt_overlay.png`:
  pictures for looking at, not data.
""".replace("{w}", WORD)


def make(case_id, rgb_src, gt_src, out, seed):
    rng = np.random.default_rng(seed)
    rgb, gt = model_view(rgb_src, gt_src)
    g, logit, prob = simulate(gt, rng)
    pred = prob > THRESHOLD
    d = out / case_id
    d.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(d / f"{case_id}_{WORD}_raw_prediction.npz", logits=logit, probabilities=prob,
                        predicted_mask=pred, probability_threshold=THRESHOLD,
                        original_shape=np.array([H, W], np.int64), source_filename=np.array(f"{case_id}.tif"))
    full = coarse.expand(pred, (H, W), "stretch")
    tifffile.imwrite(d / f"{case_id}_predicted_{WORD}_imagej_mask.tif", (full * 255).astype(np.uint8))
    h2.write_imagej_tif(d / f"{case_id}_predicted_{WORD}_imagej.tif", rgb, tile_rois(pred))
    Image.fromarray(shade(rgb, full, (0, 255, 255), 0.35)).save(d / f"{case_id}_predicted_{WORD}_overlay.png")
    heat = coarse.upsample(prob, (H, W), "stretch", order=1).clip(0, 1)     # a smooth display rendering
    Image.fromarray(shade(rgb, np.ones((H, W), bool), (0, 0, 0), 0) // 2 + jet(heat) // 2).save(
        d / f"{case_id}_{WORD}_probability_heatmap.png")
    both = shade(rgb, full, (0, 255, 255), 0.35)
    edge = gt ^ ndi.binary_erosion(gt, iterations=3)
    both[edge] = (255, 220, 0)
    Image.fromarray(both).save(d / f"{case_id}_prediction_with_gt_overlay.png")
    big = ORIGINAL_SIZE                                   # not exactly proportional, as in the real example
    orig = np.asarray(Image.fromarray(rgb).resize(big, Image.LANCZOS))
    rois = hand_rois(gt, big[0] / W)
    tifffile.imwrite(d / f"{case_id}.tif", orig, imagej=True, photometric="rgb", resolution=(PX_PER_UM, PX_PER_UM),
                     metadata={"unit": "\\u00B5m", "Overlays": [r.tobytes() for r in rois]})
    (d / "README_segmentation_outputs.md").write_text(README)
    return {"id": case_id, "tiles_predicted": int(pred.sum()), "regions_predicted": int(label(pred, connectivity=2).max()),
            "logit_range": [round(float(logit.min()), 2), round(float(logit.max()), 2)], "reference_regions": len(rois)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data" / "synthetic"))
    ap.add_argument("--only", nargs="*", help="tissue names to use (default: every one with a simulated expert mask)")
    a = ap.parse_args()
    out = Path(a.out)
    names = sorted(p.stem for p in (ROOT / "data" / "tissue_2k").glob("*.png"))
    rows = []
    for i, name in enumerate(names, 1):
        if a.only and name not in a.only:
            continue
        ex = ROOT / "data" / "cases" / f"{name}__regions" / "expert.png"
        if not ex.exists():
            ex = next((ROOT / "data" / "cases").glob(f"{name}__*/expert.png"), None)
        if ex is None:
            print("skipped", name, "(no simulated expert mask: run make_cases.py)")
            continue
        rgb = np.asarray(Image.open(ROOT / "data" / "tissue_2k" / f"{name}.png").convert("RGB"))
        gt = np.asarray(Image.open(ex).convert("L")) > 127
        rows.append(make(f"S{i:02d}-{name}", rgb, gt, out, seed=1000 + i))
        print(json.dumps(rows[-1]))
    (out / "index.json").write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
