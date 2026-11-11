"""Convert every case, check it, and render images for the QA viewer.

For each case in data/cases/ (plus any extra highlighted images in data/real/):
  - highlight2imagej.convert -> out/<case>/highlighted_RoiSet.zip (+ mask, csv)
  - fidelity: re-read the RoiSet from disk, re-draw it with ImageJ's fill rule, compare to the mask
  - accuracy (synthetic cases only): compare the ImageJ regions with the known truth
  - viewer images: original, ImageJ outlines over the original, ImageJ mask, difference vs truth
Writes out/cases.json for the viewer.
"""
import json
import shutil
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image, ImageDraw
from roifile import roiread
from skimage.segmentation import find_boundaries

from highlight2imagej import convert
from verify_roiset import iou, rasterise

OUT = Path("out")
YELLOW, RED, CYAN = (255, 230, 0), (230, 30, 30), (0, 200, 255)


def jpg(arr, path):
    Image.fromarray(arr).save(path, quality=88)


def outline_view(base, redraw, roi_path):
    """What ImageJ shows: clean tissue + translucent blue fill (the editable shapes) + handles."""
    img = base.astype(float)
    img[redraw] = 0.55 * img[redraw] + 0.45 * np.array([10, 80, 235])
    img = img.round().astype(np.uint8)
    rgb = base
    edge = find_boundaries(redraw, mode="inner")
    edge = np.pad(edge, 1)[:-2, 1:-1] | np.pad(edge, 1)[2:, 1:-1] | np.pad(edge, 1)[1:-1, :-2] | np.pad(edge, 1)[1:-1, 2:] | edge
    img[edge] = YELLOW
    im = Image.fromarray(img)
    d = ImageDraw.Draw(im)
    if roi_path.exists():
        s = max(3, rgb.shape[1] // 400)                       # handle half-size, like ImageJ's squares
        for roi in roiread(roi_path):
            if not roi.shape_roi_size:                          # composite (holed) regions have no handles
                for x, y in roi.coordinates():
                    d.rectangle([x - s, y - s, x + s, y + s], fill=(255, 255, 255), outline=(0, 0, 0))
            d.text((roi.left + 4, roi.top + 4), roi.name, fill=YELLOW, stroke_width=2,
                       stroke_fill=(0, 0, 0), font_size=max(14, rgb.shape[1] // 70))
    return np.asarray(im)


def diff_view(rgb, redraw, truth):
    img = (rgb * 0.35 + 255 * 0.65).astype(np.uint8)       # faded tissue
    img[redraw & truth] = (90, 90, 90)
    img[truth & ~redraw] = RED                               # missed
    img[redraw & ~truth] = CYAN                              # extra
    return img


def dice(a, b):
    t = a.sum() + b.sum()
    return 1.0 if t == 0 else 2 * (a & b).sum() / t


def prob_view(base, prob):
    """Model probability shown over the tissue: blue strength = probability (left panel, model route)."""
    a = (0.6 * prob)[..., None]
    return (base * (1 - a) + np.array([10, 80, 235]) * a).round().astype(np.uint8)


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir()
    jobs = []
    for c in sorted(Path("data/cases").glob("*/prob.tif")):
        c = c.parent
        jobs.append((f"{c.name}__model", c, dict(image=c / "tissue.png", prob=c / "prob.tif")))
        jobs.append((f"{c.name}__screenshot", c, dict(overlay=c / "overlay.png")))
    for p in sorted(Path("data/real").glob("*.png")):
        jobs.append((f"{p.stem}__real-screenshot", None, dict(overlay=p)))
    results = []
    for name, case_dir, inputs in jobs:
        d = OUT / name
        r = convert(d, **inputs, stem="result")
        mask, rows = r["mask"], r["rows"]
        base = np.asarray(Image.open(r["tissue"]).convert("RGB"))
        # everything below is measured on the outlines as read back from the ImageJ .tif on disk
        redraw = rasterise(r["tif"], mask.shape)
        if "prob" in inputs:
            left = prob_view(base, tifffile.imread(inputs["prob"]))
            left_label = "Model output: probability map (blue = more likely)"
        else:
            left = np.asarray(Image.open(inputs["overlay"]).convert("RGB"))
            left_label = "Screenshot of the shaded result (colour-detected)"
        jpg(left, d / "v_original.jpg")
        jpg(outline_view(base, redraw, r["roiset"]), d / "v_outlines.jpg")
        jpg((redraw * 255).astype(np.uint8), d / "v_mask.jpg")
        res = {"case": name, "route": r["route"], "left_label": left_label, "regions": len(rows),
               "width": base.shape[1], "height": base.shape[0], "highlighted_px": int(mask.sum()),
               "vertices": sum(x["vertices"] for x in rows),
               "outline_vs_shading_iou": round(iou(redraw, mask), 4),
               "imagej_tif": f"{name}/{r['tif'].name}", "roiset": f"{name}/{r['roiset'].name}",
               "qupath": f"{name}/{r['qupath'].name}", "region_rows": rows}
        views = ["outlines", "mask"]
        if case_dir is not None:
            model = np.asarray(Image.open(case_dir / "mask.png")) > 0
            expert = np.asarray(Image.open(case_dir / "expert.png")) > 0
            res.update({"conversion_iou": round(iou(redraw, model), 4),
                        "vs_expert_dice": round(dice(redraw, expert), 3)})
            jpg(diff_view(base, redraw, model), d / "v_conv.jpg")
            jpg(diff_view(base, redraw, expert), d / "v_expert.jpg")
            views += ["conv", "expert"]
        res["views"] = views
        results.append(res)
        print(f"{name:46s} regions={res['regions']:2d} handles={res['vertices']:4d} "
              f"conversion_iou={res.get('conversion_iou', '-')} vs_expert_dice={res.get('vs_expert_dice', '-')}")
    (OUT / "cases.json").write_text(json.dumps(results, indent=1))
    for route in ("model-output", "screenshot"):
        c = [x["conversion_iou"] for x in results if x["route"] == route and "conversion_iou" in x]
        print(f"{route:13s} route: conversion IoU (outlines vs model mask) mean {np.mean(c):.4f} min {min(c):.4f}  (n={len(c)})")
    e = [x["vs_expert_dice"] for x in results if x["case"].endswith("regions__model")]
    print(f"model vs expert Dice (regions cases): mean {np.mean(e):.3f}")


if __name__ == "__main__":
    main()
