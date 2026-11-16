"""Stand in for an expert: save the BCSS expert outlines as the corrections of some practice images, in the editor's
own save format, so that ml/retrain.py can be run end to end without anyone correcting by hand.

  .venv-ml/bin/python ml/simulate_corrections.py --data /tmp/editor-data 2 3      # practice-02 and practice-03
  .venv-ml/bin/python ml/retrain.py --library practice --data /tmp/editor-data

Use a throw-away --data folder: this overwrites any saved corrections of those images there."""
import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def path_of(ring):
    """A closed outline as the editor stores it: nodes joined by straight cubic segments."""
    n = [{"x": float(x), "y": float(y)} for x, y in ring]
    segs = []
    for i, a in enumerate(n):
        b = n[(i + 1) % len(n)]
        segs.append({"c1": {"x": a["x"] + (b["x"] - a["x"]) / 3, "y": a["y"] + (b["y"] - a["y"]) / 3},
                     "c2": {"x": a["x"] + 2 * (b["x"] - a["x"]) / 3, "y": a["y"] + 2 * (b["y"] - a["y"]) / 3}})
    return {"closed": True, "nodes": n, "segs": segs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cases", type=int, nargs="+", help="practice image numbers, 1 to 6")
    ap.add_argument("--data", required=True, help="the editor's DATA_DIR (use a throw-away one)")
    a = ap.parse_args()
    os.environ["DATA_DIR"] = str(Path(a.data).resolve())
    sys.path.insert(0, str(ROOT))
    import editor_backend as eb
    import highlight2imagej as h2
    eb.list_libraries()
    man = json.loads((ROOT / "data" / "practice-bcss" / "manifest.json").read_text())
    for k in a.cases:
        name = man["cases"][k - 1]["name"]
        sid = eb.open_library_case("practice", k - 1)["id"]
        expert = np.asarray(Image.open(ROOT / "data" / "practice-bcss" / "expert" / f"{name}_expert.png")) == 255
        geoms, _ = h2.region_geometry(expert, 1.5)
        regions = [{"id": f"x{i}", "name": f"corrected-{i:02d}", "source": "drawn", "label": None, "t": None, "meanProb": None,
                    "edited": True, "paths": [path_of(outer)] + [path_of(h) for h in holes]}
                   for i, (_, outer, holes) in enumerate(geoms, 1) if len(outer) >= 3]
        eb.save_state(sid, {"regions": regions, "counter": len(regions)})
        print(f"practice-{k:02d}: saved {len(regions)} expert regions as its corrections")


if __name__ == "__main__":
    main()
