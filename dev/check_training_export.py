"""Check the training-data export end to end on a throw-away data folder: import a practice image, save a correction
with a class, an unclassed region, an Exclude region and a hole, export, and check every pixel value.

  .venv/bin/python dev/check_training_export.py"""
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="train-export-")
sys.path.insert(0, str(ROOT))
import editor_backend as eb  # noqa: E402


def square(x0, y0, x1, y1):
    n = [{"x": x0, "y": y0}, {"x": x1, "y": y0}, {"x": x1, "y": y1}, {"x": x0, "y": y1}]
    segs = [{"c1": {"x": a["x"] + (b["x"] - a["x"]) / 3, "y": a["y"] + (b["y"] - a["y"]) / 3},
             "c2": {"x": a["x"] + 2 * (b["x"] - a["x"]) / 3, "y": a["y"] + 2 * (b["y"] - a["y"]) / 3}}
            for a, b in zip(n, n[1:] + n[:1])]
    return {"closed": True, "nodes": n, "segs": segs}


fails = []
def check(name, ok):
    print(("PASS " if ok else "FAIL ") + name)
    if not ok:
        fails.append(name)


saved_settings = eb.SETTINGS.read_text() if eb.SETTINGS.exists() else None   # exporting to a folder remembers it
eb.list_libraries()
lib = eb._read_lib("practice")
sid = eb.open_library_case("practice", 0)["id"]
meta = json.loads((eb._sdir(sid) / "meta.json").read_text())
W, H = meta["width"], meta["height"]
regions = [
    {"id": "a", "name": "tum", "cls": "tumour", "edited": True, "source": "model", "paths": [square(10, 10, 110, 110), square(40, 40, 60, 60)]},
    {"id": "b", "name": "str", "cls": "stroma", "edited": True, "source": "drawn", "unsure": True, "note": "check", "paths": [square(200, 10, 300, 110)]},
    {"id": "c", "name": "none", "cls": None, "edited": False, "source": "model", "paths": [square(10, 200, 110, 300)]},
    {"id": "d", "name": "fold", "cls": "exclude", "edited": True, "source": "drawn", "paths": [square(90, 90, 130, 130)]},
]
eb.save_state(sid, {"regions": regions, "counter": 4})

r = eb.export(sid, [], "case", formats=["training"])
root = eb._sdir(sid) / "export" / "training"
ds = json.loads((root / "dataset.json").read_text())
vals = {lab.get("class"): lab["value"] for lab in ds["labels"] if "class" in lab}
m = np.asarray(Image.open(root / "masks" / "case.png"))
img = Image.open(root / "images" / "case.png")
before = np.asarray(Image.open(root / "model" / "case.png"))
check("files: image, mask, model mask, dataset.json, README", all((root / p).exists() for p in ("images/case.png", "masks/case.png", "model/case.png", "dataset.json", "README.txt")))
check("mask and model mask are the image's size", m.shape == (img.height, img.width) == before.shape == (H, W))
check("mask is one 8-bit channel", m.dtype == np.uint8 and m.ndim == 2)
check("label values: tumour 1, stroma 2, no class 5, ignore 255", (vals.get("tumour"), vals.get("stroma"), vals.get(None)) == (1, 2, 5) and ds["ignore_value"] == 255)
check("tumour inside the region", m[20, 20] == 1)
check("the hole is background", m[50, 50] == 0)
check("stroma region", m[50, 250] == 2)
check("region with no class", m[250, 50] == 5)
check("Exclude wins over tumour where they overlap", m[100, 100] == 255 and m[120, 120] == 255)
check("background outside", m[400, 400] == 0 if H > 400 and W > 400 else True)
check("only expected values", set(np.unique(m)) <= {0, 1, 2, 5, 255})
check("model mask is 0/1 and from the original regions", set(np.unique(before)) <= {0, 1} and before.sum() > 0)
e = ds["images"][0]
check("status corrected", e["status"] == "corrected")
check("unsure and note kept", any(x.get("unsure") and x.get("note") == "check" for x in e["regions"]))
check("pixel size recorded", ds["pixel_size_um"] == lib.get("pixel_um"))
check("probability saved when the model gave one", ("model_probability" in e) == bool(meta.get("has_prob")))
check("export reports it", r["training"] == {"images": 1, "status": "corrected"})

# whole library: only corrected or done images
eb.set_done("practice", 1, True)
os.makedirs(os.environ["DATA_DIR"] + "/out")
lr = eb.export_library("practice", dest=os.environ["DATA_DIR"] + "/out", formats=["training"])
out = Path(lr["dir"]) / "training"
ds2 = json.loads((out / "dataset.json").read_text())
check("library: corrected + done images included, the rest skipped",
      [x["status"] for x in ds2["images"]] == ["corrected", "accepted"] and len(ds2["skipped"]) == len(lib["cases"]) - 2)
check("library: accepted image's mask equals its model mask (nothing changed)",
      ds2["images"][1]["pixels_changed"] == 0)
if saved_settings is None:
    eb.SETTINGS.unlink(missing_ok=True)
else:
    eb.SETTINGS.write_text(saved_settings)
print("\n" + ("all pass" if not fails else f"{len(fails)} failed"))
sys.exit(1 if fails else 0)
