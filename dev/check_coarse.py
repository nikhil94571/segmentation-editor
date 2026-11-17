"""Checks for tiled model output: grid detection, smoothing alignment, reading .npz files by content, choosing files
from a folder, folder-of-folders libraries and the corrected-mask export. Runs on a throw-away data folder.

  .venv/bin/python dev/make_coarse_cases.py      # once (the synthetic folders)
  .venv/bin/python dev/check_coarse.py
"""
import json
import os
import random
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="check-coarse-"))
os.environ["DATA_DIR"] = str(TMP / "data")
sys.path.insert(0, str(ROOT))
import coarse  # noqa: E402
import editor_backend as eb  # noqa: E402
from scipy.ndimage import binary_dilation as ndi_binary_dilation, binary_erosion as ndi_binary_erosion, label as ndi_label  # noqa: E402
from imagej2mask import _fill  # noqa: E402

SYN = ROOT / "data" / "synthetic"
fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    if not ok:
        fails.append(name)


saved_settings = eb.SETTINGS.read_text() if eb.SETTINGS.exists() else None
rng = np.random.default_rng(3)

# ---- grid detection ----
for (H, W, h, w, kind) in [(2048, 2467, 128, 154, "stretch"), (1000, 1003, 125, 100, "stretch"), (2047, 2467, 127, 154, "fixed"),
                           (512, 512, 32, 32, "stretch")]:
    g = rng.random((h, w)) > 0.6
    m = coarse.expand(g, (H, W), kind)
    d = coarse.detect_grid(m)
    check(f"grid found: {H}x{W} image, {h}x{w} tiles ({kind})", d is not None and (d.rows, d.cols) == (h, w)
          and (coarse.expand(coarse.sample(m, d), (H, W), d.kind) == m).all(), str(d))
blob = np.zeros((600, 700), bool)
yy, xx = np.ogrid[:600, :700]
blob |= (yy - 300) ** 2 / 180 ** 2 + (xx - 330) ** 2 / 240 ** 2 < 1
check("no grid in an ordinary per-pixel mask", coarse.detect_grid(blob) is None)
smooth = np.clip(1 - np.hypot(yy - 300, xx - 330) / 300, 0, 1).astype(np.float32)
check("no grid in a smooth probability map", coarse.detect_grid(smooth) is None)
cases = sorted((ROOT / "data" / "cases").glob("*/mask.png"))[:6]
check("no grid in the simulated per-pixel masks", all(coarse.detect_grid(np.asarray(Image.open(p)) > 0) is None for p in cases),
      f"{len(cases)} masks")

# ---- alignment: a smoothed outline sits on the true boundary, not half a tile off ----
H, W, h, w = 2048, 2467, 128, 154
yy, xx = np.mgrid[:H, :W]
truth = (yy - 1000.3) ** 2 + (xx - 1210.7) ** 2 < 520 ** 2
ry, rx = coarse._pixel_to_cell(H, h, "stretch"), coarse._pixel_to_cell(W, w, "stretch")
cover = np.zeros((h, w))
np.add.at(cover, (ry[:, None].repeat(W, 1), rx[None, :].repeat(H, 0)), truth)
cover /= np.bincount(ry)[:, None] * np.bincount(rx)[None, :]
prob = 1 / (1 + np.exp(-12 * (cover - 0.5)))
sm = coarse.smooth_probability(prob, (H, W)) > 0.5
r_smooth = np.sqrt(sm.sum() / np.pi)
cy, cx = np.argwhere(sm).mean(0)
check("smoothed disk keeps its centre (no half-tile shift)", abs(cy - 1000.3) < 1 and abs(cx - 1210.7) < 1, f"centre off by {cy - 1000.3:+.2f}, {cx - 1210.7:+.2f} px")
check("smoothed disk keeps its size", abs(r_smooth - 520) < 2, f"radius {r_smooth:.1f} vs 520")
shifted = np.asarray(Image.fromarray(prob.astype(np.float32), "F").resize((W, H), Image.BILINEAR)) > 0.5   # a naive resize
cy2, cx2 = np.argwhere(shifted).mean(0)
print(f"     (for comparison, a plain image resize puts the centre {cy2 - 1000.3:+.1f}, {cx2 - 1210.7:+.1f} px off)")

# ---- reading .npz files by content ----
d = TMP / "npz"
d.mkdir()
p = rng.random((40, 50)).astype(np.float32)
np.savez(d / "a.npz", scores=np.log(p / (1 - p)), cutoff=np.float64(0.6), size=np.array([640, 800]))
np.savez(d / "b.npz", foo=p, other=np.zeros((3, 3, 3)))
np.savez(d / "c.npz", yes=p > 0.5)
a, b, c = coarse.read_npz(d / "a.npz"), coarse.read_npz(d / "b.npz"), coarse.read_npz(d / "c.npz")
check(".npz with logits only, other key names", np.allclose(a["prob"], p, atol=1e-5) and a["threshold"] == 0.6 and a["shape"] == (640, 800))
check(".npz with probabilities under any name", np.allclose(b["prob"], p) and b["threshold"] is None)
check(".npz with only a yes/no mask", c["binary"] and c["threshold"] == 0.5)

# ---- folders: which file is what ----
folders = sorted(q for q in SYN.iterdir() if q.is_dir()) if SYN.exists() else []
check("synthetic folders exist", len(folders) >= 6, f"{len(folders)} found (run dev/make_coarse_cases.py)")


def files_of(f):
    return [q for q in f.iterdir() if q.is_file()]


def variant(src, keep, rename=False):
    """A copy of a folder (as symbolic links) with only some files, optionally with meaningless names."""
    out = TMP / f"v{random.randrange(10 ** 9)}" / src.name
    out.mkdir(parents=True)
    for q in files_of(src):
        if keep(q.name):
            name = (f"file{random.randrange(10 ** 6)}{q.suffix}" if rename else q.name)
            (out / name).symlink_to(q)
    return out


ok_all = True
for f in folders:
    sb = eb.scan_bundle(f, files_of(f))
    good = (sb["route"] == "grid" and sb["files"]["model"].endswith(".npz") and sb["files"]["image"].endswith("_imagej.tif")
            and sb["reference"] == f"{f.name}.tif")
    ok_all &= good
check("every synthetic folder: raw .npz for outlines, the model-size ImageJ copy for the image, the original as reference", ok_all)
f0 = folders[0]
renamed = variant(f0, lambda n: True, rename=True)
sb = eb.scan_bundle(renamed, files_of(renamed))
img_ok = tifffile.TiffFile(renamed / sb["files"]["image"]).series[0].shape[:2] == (2048, 2467)
check("names changed to meaningless ones: same choices", sb["route"] == "grid" and img_ok and sb["reference"] is not None, json.dumps(sb["picked"]))
no_npz = variant(f0, lambda n: not n.endswith(".npz"))
sb = eb.scan_bundle(no_npz, files_of(no_npz))
check("without the .npz: the mask TIF", sb["route"] == "model" and sb["files"]["model"].endswith("_mask.tif"))
tifs = variant(f0, lambda n: n.endswith("_imagej.tif") or n == f"{f0.name}.tif")
sb = eb.scan_bundle(tifs, files_of(tifs))
check("only the two TIFs: the traced ImageJ outlines, not the hand-drawn original", sb["route"] == "imagej"
      and sb["files"]["imagej"].endswith("_imagej.tif") and sb["reference"] == f"{f0.name}.tif")
only_orig = variant(f0, lambda n: n == f"{f0.name}.tif")
sb = eb.scan_bundle(only_orig, files_of(only_orig))
check("only the original: it is used, and named as drawn by hand", "drawn by hand" in " ".join(o["what"] for o in sb["options"]["outlines"]))
sb = eb.scan_bundle(f0, files_of(f0))
check("notes are short: the cut-off, and the outlines left out", sb["notes"] == ["Cut-off: 0.675", f"{f0.name}.tif contains outlines that were discarded"], str(sb["notes"]))
check("the larger original is found (for a full-size export)", sb["original"] == {"file": f"{f0.name}.tif", "width": 7040, "height": 5842}, str(sb["original"]))
pngs = variant(f0, lambda n: n.endswith(".png"))
try:
    sb = eb.scan_bundle(pngs, files_of(pngs))
    check("only the pictures: read as a shaded picture", sb["route"] == "screenshot")
except ValueError as e:
    check("only the pictures: read as a shaded picture", False, str(e))
no_ref = variant(f0, lambda n: n != f"{f0.name}.tif")
outs = []
for folder in (f0, no_ref):
    b2 = eb.scan_bundle(folder, files_of(folder))
    outs.append(json.dumps([r["rings"] for r in eb.import_session(b2["route"], {k: folder / v for k, v in b2["files"].items()}, name="ref")["regions"]]))
check("the expert's reference plays no part: outlines identical with and without it in the folder", outs[0] == outs[1])

# ---- import: smoothing, cut-off, node tolerance, export ----
eb.list_libraries()
sb = eb.scan_bundle(f0, files_of(f0))
meta = eb.import_session(sb["route"], {k: f0 / v for k, v in sb["files"].items()}, name=f0.name)
check("import: tiled output recognised and smoothed", meta.get("coarse", {}).get("grid") == [128, 154], str(meta.get("coarse")))
check("import: the cut-off from the model's file", abs(meta["threshold"] - 0.675) < 1e-6)
z0 = coarse.read_npz(f0 / sb["files"]["model"])
yes0 = z0["prob"] > z0["threshold"]
lab0 = np.load(eb._sdir(meta["id"]) / "labels.npy") > 0
cyy, cxx = coarse.tile_centres(lab0.shape, *yes0.shape)
check("import: every tile centre is on the model's side (smoothing only decides between centres)", (lab0[cyy, cxx] == yes0).all(),
      f"{(lab0[cyy, cxx] != yes0).sum()} of {yes0.size} differ")
# a one-tile region and a one-tile hole, put into a copy of the model's output: both must survive
syn = TMP / "onetile" / f0.name
syn.mkdir(parents=True)
for q in files_of(f0):
    if not q.name.endswith(".npz"):
        (syn / q.name).symlink_to(q)
with np.load(f0 / sb["files"]["model"]) as zz:
    arrs = {k: zz[k] for k in zz.files}
p1 = arrs["probabilities"].copy()
far = np.argwhere(~ndi_binary_dilation(yes0, iterations=4))[len(np.argwhere(~ndi_binary_dilation(yes0, iterations=4))) // 2]
inner = np.argwhere(ndi_binary_erosion(yes0, iterations=3))[0]
p1[tuple(far)] = 0.70                                    # just over the cut-off, alone
p1[tuple(inner)] = 0.60                                  # just under, inside a region
arrs.update(probabilities=p1, logits=np.log(p1 / (1 - p1)).astype(np.float32), predicted_mask=p1 > arrs["probability_threshold"])
np.savez(syn / sb["files"]["model"], **arrs)
m1 = eb.import_session("grid", {"image": syn / sb["files"]["image"], "model": syn / sb["files"]["model"]}, name="onetile")
l1 = np.load(eb._sdir(m1["id"]) / "labels.npy") > 0
check("a one-tile region the model marked is kept, and big enough to see", l1[cyy[tuple(far)], cxx[tuple(far)]]
      and ndi_label(l1)[0][cyy[tuple(far)], cxx[tuple(far)]] and (ndi_label(l1)[0] == ndi_label(l1)[0][cyy[tuple(far)], cxx[tuple(far)]]).sum() > 100)
check("a one-tile hole the model marked is kept", not l1[cyy[tuple(inner)], cxx[tuple(inner)]])
check("import: curves fitted to a third of a tile, with the node-removing fitter", meta["fit_tol"] == 5.33 and meta.get("fit") == "smooth")
check("import: source image name kept for the export", meta.get("source_name") == f"{f0.name}.tif")
regions = [{"name": r["name"], "rings": r["rings"]} for r in meta["regions"]]
r = eb.export(meta["id"], regions, formats=["corrected_mask_tif"])
out = eb._sdir(meta["id"]) / "export"
mask_files = list(out.glob("*_corrected_mask.tif"))
m = tifffile.imread(mask_files[0]) if mask_files else None
check("export: <image>_corrected_mask.tif", [q.name for q in mask_files] == [f"{f0.name}_corrected_mask.tif"])
check("export: image size, one 8-bit channel, 0 and 255", m is not None and m.shape == (2048, 2467) and m.dtype == np.uint8
      and set(np.unique(m)) <= {0, 255})
eb._patch_meta(meta, original=sb["original"])
eb.export(meta["id"], regions, formats=["corrected_mask_tif", "corrected_mask_full_tif"])
names_out = sorted(q.name for q in out.glob("*.tif"))
big = tifffile.imread(out / f"{f0.name}_corrected_mask.tif")
check("full-size export: <image>_corrected_mask.tif at the original's size, the small one named by its size",
      names_out == sorted([f"{f0.name}_corrected_mask.tif", f"{f0.name}_corrected_mask_2467x2048.tif"]) and big.shape == (5842, 7040), str(names_out))
small = tifffile.imread(out / f"{f0.name}_corrected_mask_2467x2048.tif") > 0
shrunk = np.asarray(Image.fromarray(big).resize((2467, 2048), Image.BILINEAR)) > 127
check("full-size export: the same regions as the small one", (shrunk == small).mean() > 0.998, f"{(shrunk == small).mean():.5f} of pixels agree")
for route_name, files in (("the mask TIF", {"image": f0 / f"{f0.name}_predicted_lesion_imagej.tif", "model": f0 / f"{f0.name}_predicted_lesion_imagej_mask.tif"}),
                          ("the ImageJ TIF", {"imagej": f0 / f"{f0.name}_predicted_lesion_imagej.tif"})):
    mm = eb.import_session("model" if "model" in files else "imagej", files, name="x")
    check(f"import from {route_name}: smoothed too", bool(mm.get("coarse")))

# ---- libraries: a folder of image folders, and a mix with name-paired files ----
lib_root = TMP / "lib-upload"
for f in folders[:3]:
    shutil.copytree(f, lib_root / "batch" / f.name, symlinks=True)
flat = lib_root / "batch" / "flat"
flat.mkdir()
for nm in ("pash-low", "fibrocystic-mid"):
    (flat / f"{nm}_image.png").symlink_to(ROOT / "data" / "tissue_2k" / f"{nm}.png")
    (flat / f"{nm}_prob.png").symlink_to(ROOT / "data" / "practice" / f"{nm}_prob.png")
cs, skipped = eb._build_cases(lib_root, [q for q in lib_root.rglob("*") if q.is_file()])
names = sorted(c["name"] for c in cs)
check("library: one image per folder, plus the name-paired files", names == sorted([f.name for f in folders[:3]] + ["pash-low", "fibrocystic-mid"]),
      f"{names}, skipped {skipped}")
check("library: what was picked is recorded per image", all(c.get("picked") and c.get("chosen") and c.get("options") for c in cs if c["route"] == "grid"))
lid = "choosecheck"
eb._write_lib({"id": lid, "name": "check", "created": "", "root": str(lib_root), "own_files": False, "cases": cs})
eb._lib_root = (lambda orig: (lambda lib: lib_root if lib["id"] == lid else orig(lib)))(eb._lib_root)
k = next(i for i, c in enumerate(cs) if c["route"] == "grid")
sid = eb.open_library_case(lid, k)["id"]
mask_file = next(o["file"] for o in cs[k]["options"]["outlines"] if o["file"].endswith("_mask.tif"))
v = eb.library_choose(lid, k, outlines=mask_file)
after = eb._read_lib(lid)["cases"][k]
check("library: another file can be chosen for one image; its old import is dropped",
      v["chosen"]["outlines"] == mask_file and after["route"] == "model" and after["sid"] is None and not (eb._sdir(sid) / "meta.json").exists())
check("library: the full-size original is kept per image", bool(after.get("original")))

# ---- the fitter: as few nodes as the tolerance allows, no node pairs ----
import subprocess  # noqa: E402
js = f"""
const G = require({json.dumps(str(ROOT / 'viewer/editor/geom.js'))});
const ring = []; for (let i = 0; i < 400; i++) {{ const t = i / 400 * 2 * Math.PI; ring.push({{ x: 300 + 220 * Math.cos(t) + Math.sin(7 * t), y: 200 + 120 * Math.sin(t) + Math.cos(5 * t) }}); }}
const stad = []; for (let i = 0; i <= 100; i++) stad.push({{ x: 100 + 4 * i + Math.sin(i), y: 100 }});
for (let i = 0; i <= 60; i++) {{ const t = Math.PI / 2 - i / 60 * Math.PI; stad.push({{ x: 500 + 60 * Math.cos(t), y: 160 - 60 * Math.sin(t) }}); }}
for (let i = 0; i <= 100; i++) stad.push({{ x: 500 - 4 * i, y: 220 + Math.cos(i) }});
for (let i = 0; i <= 60; i++) {{ const t = -Math.PI / 2 - i / 60 * Math.PI; stad.push({{ x: 100 + 60 * Math.cos(t), y: 160 - 60 * Math.sin(t) }}); }}
const far = (p, ring) => {{ const fl = G.flatten(p, 0.5); return Math.max(...ring.map((q) => Math.min(...fl.map((f) => Math.hypot(f.x - q.x, f.y - q.y))))); }};
const a = G.fitSmoothClosed(ring, 5.33), b = G.fitSmoothClosed(stad, 5.33), c = G.fitClosed(ring, 4);
// a region in the image's top-left corner: along the two edges it must stay straight and inside the image
const cor = []; for (let i = 0; i <= 80; i++) cor.push({{ x: 4 * i, y: 0 }});
for (let i = 1; i <= 60; i++) {{ const t = i / 60 * Math.PI / 2; cor.push({{ x: 320 * Math.cos(t) + 6 * Math.sin(9 * t), y: 220 * Math.sin(t) }}); }}
for (let i = 80; i >= 1; i--) cor.push({{ x: 0, y: 220 * i / 80 }});
const e = G.fitSmoothClosed(cor, 5.33, 2, {{ w: 1000, h: 800 }}), fl = G.flatten(e, 0.5);
console.log(JSON.stringify({{ ellipse: a.nodes.length, ellipse_far: far(a, ring), stadium: b.nodes.length, stadium_far: far(b, stad), old_ellipse: c.nodes.length,
  edge_outside: Math.min(...fl.map((q) => Math.min(q.x, q.y))) }}));
"""
fit = json.loads(subprocess.check_output(["node", "-e", js]))
check("fitter: a wobbly ellipse in 4 nodes or fewer, within tolerance", fit["ellipse"] <= 4 and fit["ellipse_far"] <= 5.4, str(fit))
check("fitter: two straight sides and two round ends in 6 nodes or fewer, within tolerance", fit["stadium"] <= 6 and fit["stadium_far"] <= 5.4, str(fit))
check("fitter: along the image's edge the outline is straight and never leaves the image", fit["edge_outside"] > -0.01, str(fit["edge_outside"]))

# ---- the practice images are unchanged ----
lib = eb._read_lib("practice")
sid = eb.open_library_case("practice", 0)["id"]
pm = json.loads((eb._sdir(sid) / "meta.json").read_text())
check("practice images: still cut at 0.5, not treated as tiles", pm["threshold"] == 0.5 and not pm.get("coarse") and pm["fit_tol"] == 3)

if saved_settings is None:
    eb.SETTINGS.unlink(missing_ok=True)
else:
    eb.SETTINGS.write_text(saved_settings)
shutil.rmtree(TMP, ignore_errors=True)
print("\n" + ("all pass" if not fails else f"{len(fails)} failed: " + "; ".join(fails)))
sys.exit(1 if fails else 0)
