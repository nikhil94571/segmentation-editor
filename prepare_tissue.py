"""Make square ~2k tissue tiles like the real data (about 2000x2000 px).

Takes the high-resolution downloads in scratch/big/ (falling back to data/tissue/), scales them to
2048 px on the short side (never upscaling) and centre-crops a square. Writes data/tissue_2k/.
"""
import json
import shutil
from pathlib import Path

from PIL import Image

SIZE = 2048
src_dirs = [Path("scratch/big"), Path("data/tissue")]
out = Path("data/tissue_2k")
out.mkdir(exist_ok=True)
names = json.loads(Path("data/tissue/SOURCES.json").read_text())
for name in names:
    src = next((d / f"{name}.png" for d in src_dirs if (d / f"{name}.png").exists()), None)
    if src is None:
        print("missing", name)
        continue
    im = Image.open(src).convert("RGB")
    short = min(im.size)
    if short > SIZE:
        f = SIZE / short
        im = im.resize((round(im.width * f), round(im.height * f)), Image.LANCZOS)
        short = SIZE
    l, t = (im.width - short) // 2, (im.height - short) // 2
    im.crop((l, t, l + short, t + short)).save(out / f"{name}.png")
    print(name, src.parent.name, "->", short, "x", short)
shutil.copy("data/tissue/SOURCES.json", out / "SOURCES.json")
