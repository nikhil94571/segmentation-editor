"""Retrain the model from experts' corrections made in the editor.

  .venv-ml/bin/python ml/retrain.py --library practice                  # the corrections saved in a library
  .venv-ml/bin/python ml/retrain.py --library practice --data /path/to/DATA_DIR --workspace <id>
  .venv-ml/bin/python ml/retrain.py --pairs out/corrected --mpp 0.5    # folders of <name>_image.* + <name>_mask.png

Every image in the library that has saved corrections becomes a training example: regions with no class or the
class "Tumour" are tumour, regions of any class marked "leave out of measurements" are ignored, regions of any other
class (Stroma, Necrosis, Normal...) and everything else are other tissue.
The model is fine-tuned from --base on those examples together with the regions it was first trained on (so it does
not forget them), then scored before and after on the BCSS test regions it never sees (practice images that were corrected are
left out of that score, since the practice images are themselves BCSS test regions).
Writes the new model (--out) and a short report next to it."""
import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

PRACTICE = C.ROOT / "data" / "practice-bcss"


def _digest(rgb):
    import hashlib
    return hashlib.md5(np.ascontiguousarray(rgb).tobytes()).hexdigest()


def practice_sources():
    """Pixel digest of each built-in practice image -> its BCSS region. The practice images are BCSS test regions,
    so a corrected one must never be scored as unseen; matching on the pixels works whatever library it is in."""
    man = PRACTICE / "manifest.json"
    if not man.exists():
        return {}
    return {_digest(np.asarray(Image.open(PRACTICE / f"{c['name']}_image.jpg").convert("RGB"))): c["source"]
            for c in json.loads(man.read_text())["cases"]}


def to_model_mpp(rgb, y, mpp):
    f = C.MODEL_MPP / mpp
    if abs(f - 1) < 1e-6:
        return rgb, y
    size = (max(1, round(rgb.shape[1] / f)), max(1, round(rgb.shape[0] / f)))
    return (np.asarray(Image.fromarray(rgb).resize(size, Image.Resampling.LANCZOS)),
            np.asarray(Image.fromarray(y).resize(size, Image.Resampling.NEAREST)))


def from_library(lid, data_dir, workspace, mpp):
    """(name, rgb, target) for every corrected image of an editor library."""
    if data_dir:
        os.environ["DATA_DIR"] = str(data_dir)
    sys.path.insert(0, str(C.ROOT))
    import editor_backend as eb
    from imagej2mask import _fill
    eb.set_workspace(workspace or "")
    lib = eb._read_lib(lid)
    mpp = mpp or lib.get("pixel_um")
    if not mpp:
        raise SystemExit("This library has no pixel size. Set it in the editor's Measure panel, or pass --mpp.")
    leave_out = {c["id"] for c in eb._classes(lib) if c.get("exclude")}
    tumour = {None, "", "tumour"}
    sources = practice_sources()
    out = []
    for i, case in enumerate(lib["cases"]):
        sid = case.get("sid")
        if not sid or not (eb._sdir(sid) / "state.json").exists():
            continue
        sd = eb._sdir(sid)
        state = json.loads((sd / "state.json").read_text())
        rgb = np.asarray(Image.open(sd / "tissue.png").convert("RGB"))
        y = np.zeros(rgb.shape[:2], np.uint8)
        masks = []
        for reg, rings in zip(state["regions"], eb._state_rings(state)):
            m = np.zeros(y.shape, bool)
            for r in rings:
                if len(r) >= 3:
                    m ^= _fill(r, y.shape)
            cls = reg.get("cls")
            masks.append((2 if cls in leave_out else 1 if cls in tumour else 0, m))
        for rank, m in sorted(masks, key=lambda t: t[0]):          # fixed order: left-out areas win over tumour
            if rank:
                y[m] = C.IGNORE if rank == 2 else 1
        out.append((case["name"], *to_model_mpp(rgb, y, mpp), sources.get(_digest(rgb))))
    return out


def from_pairs(folder, mpp):
    out = []
    for m in sorted(Path(folder).glob("*_mask.png")):
        stem = m.name[:-len("_mask.png")]
        img = next((p for p in m.parent.glob(stem + "_image.*")), None) or next((p for p in m.parent.glob(stem + "_tissue.*")), None)
        if not img:
            print("skipped", m.name, "(no image next to it)")
            continue
        rgb = np.asarray(Image.open(img).convert("RGB"))
        y = (np.asarray(Image.open(m).convert("L")) > 127).astype(np.uint8)
        out.append((stem, *to_model_mpp(rgb, y, mpp), practice_sources().get(_digest(rgb))))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--library", help="editor library id (practice is the built-in one)")
    ap.add_argument("--data", help="the editor's DATA_DIR (default: this folder)")
    ap.add_argument("--workspace", help="hosted mode: the visitor workspace id")
    ap.add_argument("--pairs", help="folder of <name>_image.* and <name>_mask.png")
    ap.add_argument("--mpp", type=float, help="micrometres per pixel of the images (default: the library's pixel size)")
    ap.add_argument("--base", default=str(C.ROOT / "models" / "loop" / "v1-base.pt"))
    ap.add_argument("--steps", type=int, default=300)
    ap.add_argument("--out", default=str(C.ROOT / "models" / f"retrained-{time.strftime('%Y%m%d-%H%M')}.pt"))
    a = ap.parse_args()

    ex = []
    if a.library:
        ex += from_library(a.library, a.data, a.workspace, a.mpp)
    if a.pairs:
        if not a.mpp:
            ap.error("--pairs needs --mpp")
        ex += from_pairs(a.pairs, a.mpp)
    if not ex:
        raise SystemExit("No corrected images found. Correct and save at least one image in the editor first.")
    print(f"{len(ex)} corrected image(s):", ", ".join(n for n, _, _, _ in ex))

    model, meta = C.load(a.base)
    seen = {src for _, _, _, src in ex if src} | set(meta.get("test_regions_used") or [])   # never score on a test region
    if seen:                                                                                  # any model in the chain saw
        print(f"Left out of the score: {len(seen)} practice image(s) that are BCSS test regions and have been trained on")
    test_names = [n for n in C.splits()["test"] if n not in seen]
    test = [C.load_roi(n) for n in test_names]
    before = [C.dice(C.predict(model, rgb), y) for rgb, y in test]
    fit_before = [C.dice(C.predict(model, rgb), y) for _, rgb, y, _ in ex]
    keep = [C.load_roi(n) for n in (meta.get("trained_on") or [])
            if (C.BCSS / "rgbs_colorNormalized" / n).exists() or (C.BCSS / "rgb" / n).exists() or (C.BCSS / "cache" / f"{Path(n).stem}@{C.MODEL_MPP}.npz").exists()]
    C.seed_all(0)
    model = C.train(model, keep + [(rgb, y) for _, rgb, y, _ in ex], a.steps, lr=1e-4, seed=0, log=print)
    after = [C.dice(C.predict(model, rgb), y) for rgb, y in test]
    fit_after = [C.dice(C.predict(model, rgb), y) for _, rgb, y, _ in ex]
    C.save(model, a.out, {"base": Path(a.base).name, "test_regions_used": sorted(seen),
                          "trained_on": (meta.get("trained_on") or []) + [src or f"corrected:{n}" for n, _, _, src in ex]})
    report = {"base": a.base, "out": a.out, "corrected": [n for n, _, _, _ in ex], "steps": a.steps, "test_regions_scored": len(test_names),
              "bcss_test_dice_before": float(np.mean(before)), "bcss_test_dice_after": float(np.mean(after)),
              "corrected_images_dice_before": float(np.mean(fit_before)), "corrected_images_dice_after": float(np.mean(fit_after))}
    C.write_json(Path(a.out).with_suffix(".json"), report)
    print(f"\nOn the corrected images: Dice {report['corrected_images_dice_before']:.3f} -> {report['corrected_images_dice_after']:.3f}")
    print(f"On the {len(test_names)} BCSS test regions not among them (never trained on): Dice {report['bcss_test_dice_before']:.3f} -> {report['bcss_test_dice_after']:.3f}")
    print("Model:", a.out)


if __name__ == "__main__":
    main()
