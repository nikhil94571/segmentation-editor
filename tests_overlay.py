"""Shading found by comparing with the original image: does it work for any colour?
Re-shades the practice cases in ten colours at three opacities (plus JPEG-compressed and soft-edged
variants) and compares the detected mask with the known one.

    python tests_overlay.py            # every *__regions case
    python tests_overlay.py quick      # two cases
"""
import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

from overlay_detect import pair_mask

COLOURS = {"blue": (10, 80, 235), "green": (0, 200, 80), "yellow": (255, 220, 0), "red": (230, 30, 30),
           "cyan": (0, 200, 230), "orange": (255, 140, 0), "purple": (150, 40, 200), "pink": (255, 105, 180),
           "black": (0, 0, 0), "white": (255, 255, 255)}
ALPHAS = (0.25, 0.45, 0.65)


def shade(tissue, mask, colour, alpha, soft=0.0):
    m = mask.astype(np.float32)
    if soft:
        m = ndi.gaussian_filter(m, soft)
    out = tissue.astype(np.float32) * (1 - alpha * m[..., None]) + alpha * m[..., None] * np.array(colour, np.float32)
    return out.round().astype(np.uint8)


def jpeg(arr, q):
    b = io.BytesIO()
    Image.fromarray(arr).save(b, "JPEG", quality=q)
    return np.asarray(Image.open(io.BytesIO(b.getvalue())).convert("RGB"))


def iou(a, b):
    u = (a | b).sum()
    return (a & b).sum() / u if u else 1.0


def main():
    cases = sorted(Path("data/cases").glob("*__regions"))
    if "quick" in sys.argv:
        cases = cases[:2]
    rows = {}
    for c in cases:
        tissue = np.asarray(Image.open(c / "tissue.png").convert("RGB"))
        mask = np.asarray(Image.open(c / "mask.png").convert("L")) > 127
        runs = [(n, a, "exact copy") for n in COLOURS for a in ALPHAS]
        runs += [(n, 0.45, k) for n in ("blue", "green", "pink") for k in ("both jpeg 85", "both jpeg 60", "soft edge")]
        for name, alpha, kind in runs:
            img, orig = shade(tissue, mask, COLOURS[name], alpha, soft=1.5 if kind == "soft edge" else 0), tissue
            if kind.startswith("both jpeg"):
                q = int(kind.split()[-1])
                img, orig = jpeg(img, q), jpeg(tissue, q)
            m, b = pair_mask(img, orig)
            rows.setdefault((name, alpha, kind), []).append((iou(m, mask), b))
        m, b = pair_mask(tissue, jpeg(tissue, 85))                 # no shading at all: nothing should be found
        rows.setdefault(("none", 0.0, "one jpeg 85"), []).append((1.0 - m.mean(), b))
    print(f"{len(cases)} images\n\n{'colour':8} {'opacity':>7} {'kind':14} {'mean IoU':>8} {'min IoU':>8}   measured opacity / colour (first image)")
    for (name, alpha, kind), rs in rows.items():
        v, b = [r[0] for r in rs], rs[0][1]
        est = f"{b['alpha']:.2f} / {tuple(int(x) for x in b['colour'].round())}" if b else "-"
        print(f"{name:8} {alpha:7.2f} {kind:14} {np.mean(v):8.3f} {np.min(v):8.3f}   {est}")
    plain = [r[0] for k, rs in rows.items() if k[2] == "exact copy" for r in rs]
    print(f"\nall colours x opacities, exact copy: mean IoU {np.mean(plain):.4f}, lowest {np.min(plain):.4f}")


if __name__ == "__main__":
    main()
