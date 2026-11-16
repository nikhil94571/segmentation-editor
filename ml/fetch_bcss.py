"""Download the BCSS data this project uses into data/bcss/ (not in the repository).

  .venv-ml/bin/python ml/fetch_bcss.py

BCSS: Amgad et al., "Structured crowdsourcing enables convolutional segmentation of histology images",
Bioinformatics 35(18):3461, 2019. Licence CC0 1.0 (https://github.com/PathologyDataScience/BCSS). Files come from the
Hugging Face mirror nabil-m/bcss (the same colour-normalised regions and masks at 0.25 um per pixel).
All 151 masks are fetched (16 MB); of the images (4.9 GB in all), only the 64 listed in ml/bcss_picked.txt (1.4 GB).
That list was made by pick() below: regions with a 10-75% tumour share and files under 40 MB, shuffled with seed 7."""
import concurrent.futures as cf
import json
import random
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "bcss"
HF = "https://huggingface.co/datasets/nabil-m/bcss"


def listing(folder):
    return json.loads(urllib.request.urlopen(f"https://huggingface.co/api/datasets/nabil-m/bcss/tree/main/{folder}").read())


def get(rel):
    out = OUT / rel
    if out.exists() and out.stat().st_size > 0:
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".part")
    urllib.request.urlretrieve(f"{HF}/resolve/main/{rel}", tmp)
    tmp.rename(out)


def pick(n=64):
    """The selection as it was made on 17 Nov 2026 (kept for the record; ml/bcss_picked.txt is what is used)."""
    sizes = {Path(x["path"]).name: x["size"] for x in listing("rgbs_colorNormalized")}
    ok = []
    for f in sorted((OUT / "masks").glob("*.png")):
        m = np.asarray(Image.open(f))
        roi = m > 0
        tum = float(np.isin(m, [1, 19, 20])[roi].mean()) if roi.any() else 0
        if sizes.get(f.name, 0) / 1e6 <= 40 and 0.10 <= tum <= 0.75:
            ok.append(f.name)
    random.Random(7).shuffle(ok)
    return ok[:n]


def main():
    for f in ("README.md", "configs.py", "gtruth_codes.tsv", "roiBounds_BaseMagnification.csv"):
        get(f"meta/{f}")
    with cf.ThreadPoolExecutor(8) as ex:
        list(ex.map(get, [x["path"] for x in listing("masks")]))
    names = [n for n in (ROOT / "ml" / "bcss_picked.txt").read_text().split() if n]
    with cf.ThreadPoolExecutor(6) as ex:
        list(ex.map(lambda n: get(f"rgbs_colorNormalized/{n}"), names))
    rgb = OUT / "rgbs_colorNormalized"
    print(len(list((OUT / "masks").glob("*.png"))), "masks,", len(list(rgb.glob("*.png"))), "images in", OUT)


if __name__ == "__main__":
    main()
