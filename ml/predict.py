"""Run a trained model on tissue images and write files the editor opens: <name>_image.jpg and <name>_prob.png.

  .venv-ml/bin/python ml/predict.py --model models/loop/v1-base.pt --mpp 0.5 --out out/predicted  slide1.png slide2.png
  .venv-ml/bin/python ml/predict.py --practice      # rebuild data/practice-bcss/ (the editor's practice images)

--mpp is the images' micrometres per pixel; the model works at 1.0 and its map is resized back to the image.
Put the output folder into the editor's Open dialog: files are paired by name."""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

PRACTICE = C.ROOT / "data" / "practice-bcss"
SHOW_MPP = 0.5                                                   # the practice images are shown at 0.5 µm per pixel


def prob_for(model, rgb, mpp):
    """Probability map at the image's own size, from a model that works at C.MODEL_MPP."""
    img = Image.fromarray(rgb)
    f = C.MODEL_MPP / mpp
    small = np.asarray(img.resize((max(1, round(img.width / f)), max(1, round(img.height / f))), Image.Resampling.LANCZOS))
    p = C.predict(model, small)
    return np.asarray(Image.fromarray(p.astype(np.float32), mode="F").resize(img.size, Image.Resampling.BILINEAR)).clip(0, 1)


def write_pair(out, name, rgb, prob):
    out.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb).save(out / f"{name}_image.jpg", quality=92)
    Image.fromarray((prob * 255).round().astype(np.uint8)).save(out / f"{name}_prob.png")


def practice(model_path, n=6):
    """The editor's practice images: 6 of the 12 test regions (never trained on), at 0.5 µm per pixel, with the
    first model's output and the BCSS expert outline (for scoring corrections later)."""
    model, meta = C.load(model_path)
    test = C.splits()["test"]
    rows = []
    for name in test:
        rgb, y = C.load_roi(name, SHOW_MPP)
        p = prob_for(model, rgb, SHOW_MPP)
        rows.append({"src": name, "dice": C.dice(p, y), "unsure": C.uncertainty(p, y), "rgb": rgb, "y": y, "p": p,
                     "size": list(rgb.shape[:2])})
    # a spread of difficulty, so the practice set has both easy and clearly wrong outputs
    rows.sort(key=lambda r: r["dice"])
    pick = [rows[round(i * (len(rows) - 1) / (n - 1))] for i in range(n)]
    pick.sort(key=lambda r: r["dice"])
    # practice-01 is the tour's image: a middling one (3rd of 6, separate tumour nests), then the hard ones, then the easy
    pick = [pick[2], pick[3], pick[0], pick[1], pick[4], pick[5]]
    (PRACTICE / "expert").mkdir(parents=True, exist_ok=True)
    cases = []
    for i, r in enumerate(pick, 1):
        nm = f"bcss-{i:02d}"
        write_pair(PRACTICE, nm, r["rgb"], r["p"])
        Image.fromarray(np.where(r["y"] == 1, 255, np.where(r["y"] == C.IGNORE, 128, 0)).astype(np.uint8)).save(PRACTICE / "expert" / f"{nm}_expert.png")
        cases.append({"name": nm, "source": r["src"], "size_px": r["size"], "model_dice_vs_expert": round(r["dice"], 4)})
    C.write_json(PRACTICE / "manifest.json", {
        "pixel_um": SHOW_MPP, "model": Path(model_path).name, "model_trained_on": meta.get("trained_on"),
        "source": "BCSS (Amgad et al. 2019, Bioinformatics 35(18):3461), CC0 1.0. Colour-normalised regions from TCGA "
                  "breast cancer slides, shown at 0.5 µm per pixel. https://github.com/PathologyDataScience/BCSS",
        "expert": "expert/<name>_expert.png: 255 tumour, 0 other tissue, 128 outside the annotated region",
        "cases": cases})
    for c in cases:
        print(c["name"], c["source"][:23], "Dice vs expert", c["model_dice_vs_expert"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="*")
    ap.add_argument("--model", default=str(C.ROOT / "models" / "loop" / "v1-base.pt"))
    ap.add_argument("--mpp", type=float, default=0.5, help="micrometres per pixel of the input images")
    ap.add_argument("--out", default=str(C.ROOT / "out" / "predicted"))
    ap.add_argument("--practice", action="store_true")
    a = ap.parse_args()
    if a.practice:
        return practice(a.model)
    if not a.images:
        ap.error("give images, or --practice")
    model, _ = C.load(a.model)
    for f in a.images:
        rgb = np.asarray(Image.open(f).convert("RGB"))
        write_pair(Path(a.out), Path(f).stem, rgb, prob_for(model, rgb, a.mpp))
        print("wrote", Path(a.out) / f"{Path(f).stem}_prob.png")


if __name__ == "__main__":
    main()
