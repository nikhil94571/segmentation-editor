"""Draw the "bcss" spots of viewer/editor/demo-spots.js on practice-01, to check them by eye.
  .venv/bin/python dev/show_spots.py out.jpg"""
import json, re, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
ROOT = Path(__file__).resolve().parent.parent
js = (ROOT / "viewer/editor/demo-spots.js").read_text()
D = json.loads(re.search(r"SPOTS\.bcss = (\{.*?\});\n", js, re.S).group(1))
man = json.loads((ROOT / "data/practice-bcss/manifest.json").read_text())
n = man["cases"][0]["name"]
im = Image.open(ROOT / f"data/practice-bcss/{n}_image.jpg").convert("RGB")
p = np.asarray(Image.open(ROOT / f"data/practice-bcss/{n}_prob.png")) >= 128
a = np.asarray(im).copy(); a[p] = (a[p] * 0.6 + np.array([10, 80, 235]) * 0.4).astype(np.uint8)
im = Image.fromarray(a); d = ImageDraw.Draw(im)
def rect(v, c, w=4): d.rectangle(v, outline=c, width=w)
def poly(pts, c, w=5, closed=False): d.line([tuple(q) for q in pts] + ([tuple(pts[0])] if closed else []), fill=c, width=w)
def dot(q, c, r=9): d.ellipse([q[0] - r, q[1] - r, q[0] + r, q[1] + r], fill=c)
rect(D["work"], "yellow"); rect(D["measure"]["view"], "cyan", 3); rect(D["missed"]["view"], "lime", 3)
poly([D["extend"]["a"]] + D["extend"]["mid"] + [D["extend"]["b"]], "orange")
poly([D["trimMain"]["a"]] + D["trimMain"]["mid"] + [D["trimMain"]["b"]], "red")
poly(D["missed"]["loop"], "lime", 5, True)
for m in D["nodes"]: poly([m["from"], m["to"]], "magenta"); dot(m["to"], "magenta")
for b in D["bends"]: poly([b["at"], [b["at"][0] + b["by"][0], b["at"][1] + b["by"][1]]], "white"); dot(b["at"], "white", 6)
poly(D["measure"]["drag"], "cyan"); dot(D["measure"]["empty"], "cyan", 12)
for q in D["measure"]["pins"]: dot(q, "blue", 11)
s = D["split"]["line"]; poly([s[:2], s[2:]], "black", 4)
poly(D["hole"]["loop"], "red", 4, True); dot(D["hole"]["centre"], "red", 6)
t = D["trim"]; poly([t["a"]] + t["mid"] + [t["b"]], "pink"); rect(t["view"], "pink", 2)
e = D["email"]["second"]; poly([e["a"]] + e["mid"] + [e["b"]], "orange")
d.text((20, 20), f"main {D['main']}  second {D['second']}  trim {t['region']}  hole {D['hole']['region']}", fill="black")
im.thumbnail((1500, 1500)); im.save(sys.argv[1], quality=85)
