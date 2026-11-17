"""Build the import comparison page's data: every folder is imported exactly as the editor imports it, and the
result is saved next to the model's output as it was delivered, for a person to look at side by side.

  .venv/bin/python dev/compare.py                                  # the synthetic folders (data/synthetic/)
  .venv/bin/python dev/compare.py ~/Downloads/some-model-output     # plus any real folders, given by path
  .venv/bin/python serve.py                                        # then open http://127.0.0.1:8765/compare

The data goes to COMPARE_DIR (default ~/Automations/segmentation-editor-data/compare), outside the repository,
because a real folder is a lab's own image. Nothing is uploaded anywhere.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="compare-")      # the imports are made here and thrown away
import coarse  # noqa: E402
import editor_backend as eb  # noqa: E402
import highlight2imagej as h2  # noqa: E402
from imagej2mask import _fill, read_regions  # noqa: E402

OUT = Path(os.environ.get("COMPARE_DIR") or Path.home() / "Automations" / "segmentation-editor-data" / "compare")


def rings_mask(regions, shape):
    m = np.zeros(shape, bool)
    for reg in regions:
        r = np.zeros(shape, bool)
        for ring in reg["rings"]:
            if len(ring) >= 3:
                r ^= _fill(np.asarray(ring, float), shape)
        m |= r
    return m


def edge(m):
    return m & ~ndi.binary_erosion(m)


def build(folder, name):
    folder = Path(folder)
    files = [p for p in folder.rglob("*") if p.is_file()]
    b = eb.scan_bundle(folder, files)
    meta = eb.import_session(b["route"], {k: folder / v for k, v in b["files"].items()}, name=name)
    d = eb._sdir(meta["id"])
    shape = (meta["height"], meta["width"])
    smooth = rings_mask(meta["regions"], shape)

    # the model's output as delivered, and as the editor imported it before smoothing
    if b["route"] == "grid":
        z = coarse.read_npz(folder / b["files"]["model"])
        t = z["threshold"] if z["threshold"] is not None else eb.DEFAULT_THRESHOLD
        delivered = coarse.expand(z["prob"] > (0.5 if z["binary"] else t), shape, "stretch")
    elif b["route"] == "model":
        a = h2.load_array(folder / b["files"]["model"])
        delivered = a > (0 if len(np.unique(a)) <= 2 else eb.DEFAULT_THRESHOLD)
    else:
        delivered = rings_mask([{"rings": [o] + list(hs)} for _, o, hs in read_regions(folder / (b["files"].get("rois") or b["files"]["imagej"]))], shape)
    before = h2.clean(delivered, 200, 200)
    old = eb._regions_from_labels(eb._labels_by_area(before), before.astype(np.float32), False)

    # the reference (an expert's outlines) if the folder has one, at the model's size
    ref = None
    if b.get("reference"):
        import tifffile
        with tifffile.TiffFile(folder / b["reference"]) as tf:
            rh, rw = tf.series[0].shape[:2]
        ref = [[(np.asarray(r, float) * [shape[1] / rw, shape[0] / rh]).round(2).tolist() for r in [o] + list(hs)]
               for _, o, hs in read_regions(folder / b["reference"])]

    dist_to_delivered = ndi.distance_transform_edt(~edge(delivered))
    case = {
        "name": name, "picked": b["picked"], "notes": b["notes"] + meta.get("notes", []),
        "width": shape[1], "height": shape[0], "fit_tol": meta["fit_tol"], "fit": meta.get("fit"), "coarse": meta.get("coarse"),
        "threshold": meta["threshold"],
        "before": {"regions": [r["rings"] for r in old], "fit_tol": eb.FIT_TOL},
        "after": {"regions": [r["rings"] for r in meta["regions"]]},
        "delivered_outline": [[np.asarray(o).tolist()] + [np.asarray(h).tolist() for h in hs]
                              for _, o, hs in h2.region_geometry(delivered, 0)[0]],
        "reference": ref,
        "stats": {
            "area_change_pct": round(100 * (smooth.sum() / max(delivered.sum(), 1) - 1), 2),
            "max_move_px": round(float(dist_to_delivered[edge(smooth)].max()), 1) if smooth.any() else None,
            "tile_px": meta.get("coarse", {}).get("tile_px") if meta.get("coarse") else None,
        },
    }
    if ref:
        rm = rings_mask([{"rings": r} for r in ref], shape)
        iou = lambda m: round(float((m & rm).sum() / max((m | rm).sum(), 1)), 3)
        case["stats"]["iou_reference_before"] = iou(delivered)
        case["stats"]["iou_reference_after"] = iou(smooth)
    out = OUT / name
    out.mkdir(parents=True, exist_ok=True)
    Image.open(d / "tissue.png").convert("RGB").save(out / "image.jpg", quality=88)
    (out / "case.json").write_text(json.dumps(case))
    return {"name": name, "regions": len(meta["regions"]), **case["stats"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folders", nargs="*", help="more folders to compare (each one image's model output)")
    ap.add_argument("--no-synthetic", action="store_true")
    a = ap.parse_args()
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    todo = []
    syn = ROOT / "data" / "synthetic"
    if not a.no_synthetic and syn.exists():
        todo += [(p, p.name) for p in sorted(syn.iterdir()) if p.is_dir()]
    todo += [(Path(f).expanduser(), Path(f).expanduser().name) for f in a.folders]
    index = []
    for folder, name in todo:
        try:
            row = build(folder, name)
        except Exception as e:                                  # one bad folder should not stop the rest
            row = {"name": name, "error": str(e)}
        row["synthetic"] = str(folder).startswith(str(syn))
        index.append(row)
        print(json.dumps(row))
    (OUT / "index.json").write_text(json.dumps(index, indent=1))
    print("open http://127.0.0.1:8765/compare  (data in", OUT, ")")


if __name__ == "__main__":
    main()
