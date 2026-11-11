"""Backend for the segmentation editor (viewer/editor.html). Pure functions; serve.py does the HTTP.

A *session* is one image being corrected, stored in sessions/<id>/:
    tissue.png   clean base image
    score.npy    float32 0..1 map the grow/shrink slider thresholds: the model's probability map when
                 there is one, otherwise a stand-in built from distance to the region edge
    labels.npy   int32 label image of the regions as imported (the slider's seeds)
    meta.json    name, route, sizes, and each region's outline as dense rings
    state.json   the editor's own save (curves), written by the page
    export/      mask PNG, overlay PNG, ImageJ .tif, RoiSet.zip, QuPath .geojson

Three ways in (import_session):
    model       image + probability map (.tif/.npy/8-16 bit) or mask (.png/.tif/.npy)
    screenshot  a picture of the shaded result (+ the original image if available)
    imagej      an ImageJ .tif with an overlay, or an image + RoiSet .zip/.roi (or QuPath .geojson)
"""
import json
import re
import shutil
import time
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image
from roifile import ImagejRoi, ROI_OPTIONS, ROI_TYPE, roiwrite
from scipy import ndimage as ndi
from skimage.measure import approximate_polygon, label, regionprops
from skimage.morphology import remove_small_holes, remove_small_objects
from skimage.segmentation import watershed

import highlight2imagej as h2
from imagej2mask import _fill, read_regions, to_mask

ROOT = Path(__file__).resolve().parent
SESSIONS = ROOT / "sessions"
UPLOADS = SESSIONS / "_uploads"
PSEUDO_PX = 80          # stand-in score: 0.5 at the edge, +-0.5 over +-40 px
RING_TOL = 0.75         # px; removes the pixel staircase before the page fits curves
_cache = {}


# ---------- small helpers ----------

def _slug(s):
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", s).strip("-")[:60] or "session"


def _sdir(sid):
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", sid or ""):
        raise ValueError("bad session id")
    return SESSIONS / sid


def _rgb(path):
    """Any image file -> uint8 RGB array (ImageJ/greyscale/16-bit TIFFs included)."""
    path = Path(path)
    if path.suffix.lower() in (".tif", ".tiff"):
        a = np.squeeze(tifffile.imread(path))
        if a.ndim == 3 and a.shape[0] in (3, 4) and a.shape[2] not in (3, 4):
            a = np.moveaxis(a, 0, -1)
        if a.ndim == 2:
            a = np.stack([a] * 3, axis=-1)
        a = a[..., :3]
        if a.dtype != np.uint8:
            a = a.astype(float)
            a = (255 * (a - a.min()) / max(a.max() - a.min(), 1e-9)).astype(np.uint8)
        return np.ascontiguousarray(a)
    return np.asarray(Image.open(path).convert("RGB"))


def _rings(mask, offset=(0, 0)):
    """All outlines (outer + holes) of a boolean mask as lists of [x, y]."""
    geoms, _ = h2.region_geometry(mask, RING_TOL)
    out = []
    for _, outer, holes in geoms:
        for r in [outer] + holes:
            if len(r) >= 3:
                out.append((r + offset).round(2).tolist())
    return out


def _pseudo_score(mask):
    if not mask.any():
        return np.zeros(mask.shape, np.float32)
    sd = ndi.distance_transform_edt(mask) - ndi.distance_transform_edt(~mask)
    return np.clip(0.5 + sd / PSEUDO_PX, 0, 1).astype(np.float32)


def _regions_from_labels(labels, score, has_prob):
    regions = []
    for r in regionprops(labels, intensity_image=score):
        r0, c0, r1, c1 = r.bbox
        crop = np.pad(labels[r0:r1, c0:c1] == r.label, 2)
        regions.append({"label": int(r.label), "name": f"region-{r.label:02d}", "area": int(r.area),
                        "mean_prob": round(float(r.intensity_mean), 3) if has_prob else None,
                        "rings": _rings(crop, (c0 - 2, r0 - 2))})
    return regions


def _labels_by_area(mask):
    lab = label(mask, connectivity=2)
    out = np.zeros_like(lab, dtype=np.int32)
    for i, r in enumerate(sorted(regionprops(lab), key=lambda r: -r.area), 1):
        out[lab == r.label] = i
    return out


def _write_session(sid, name, route, base, score, labels, has_prob, threshold, regions=None):
    d = _sdir(sid)
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    Image.fromarray(base).save(d / "tissue.png")
    np.save(d / "score.npy", score.astype(np.float32))
    np.save(d / "labels.npy", labels.astype(np.int32))
    meta = {"id": sid, "name": name, "route": route, "has_prob": has_prob, "threshold": threshold,
            "width": int(base.shape[1]), "height": int(base.shape[0]), "created": time.strftime("%Y-%m-%d %H:%M"),
            "regions": regions if regions is not None else _regions_from_labels(labels, score, has_prob)}
    (d / "meta.json").write_text(json.dumps(meta))
    _cache.pop(sid, None)
    return meta


# ---------- import ----------

def import_session(route, files, name=None, threshold=0.5, sid=None):
    """files: dict of role -> path. Roles: image, model, overlay, imagej, rois. Returns the session meta."""
    f = {k: Path(v) for k, v in files.items() if v}
    if not f:
        raise ValueError("Choose a file first.")
    name = name or next(iter(f.values())).stem
    if route == "screenshot" and "overlay" in f and _role(f["overlay"]) == "imagej":
        route, f = "imagej", {"imagej": f["overlay"]}       # an ImageJ .tif that carries its own outlines
    sid = sid or f"{_slug(name)}-{time.strftime('%H%M%S')}"

    if route == "model":
        if "image" not in f or "model" not in f:
            raise ValueError("Model output needs the original image and a probability map or mask.")
        base = _rgb(f["image"])
        raw = h2.load_array(f["model"])
        if raw.shape != base.shape[:2]:
            raise ValueError(f"Model output is {raw.shape[1]}x{raw.shape[0]} but the image is "
                             f"{base.shape[1]}x{base.shape[0]}.")
        two_valued = len(np.unique(raw)) <= 2
        is_prob = not two_valued and (raw.dtype.kind == "f" or not _looks_like_labels(raw))
        if is_prob:
            score = h2.load_prob(f["model"])
            mask = h2.clean(score >= threshold, 200, 200)
        else:
            mask = h2.clean(raw > 0, 200, 200)
            score, threshold = _pseudo_score(mask), 0.5
        return _write_session(sid, name, "model", base, score, _labels_by_area(mask), bool(is_prob), threshold)

    if route == "screenshot":
        if "overlay" not in f:
            raise ValueError("Screenshot route needs the shaded image.")
        rgb = np.asarray(Image.open(f["overlay"]).convert("RGB"))
        mask = h2.clean(h2.highlight_mask(rgb), 200, 200, rgb)
        base = _rgb(f["image"]) if "image" in f else h2.unshade(rgb, mask)
        if base.shape != rgb.shape:
            raise ValueError("The original image and the screenshot are different sizes.")
        return _write_session(sid, name, "screenshot", base, _pseudo_score(mask), _labels_by_area(mask), False, 0.5)

    if route == "imagej":
        src = f.get("imagej") or f.get("image")
        if src is None:
            raise ValueError("ImageJ route needs a .tif (with an overlay), or an image plus a RoiSet.")
        base = _rgb(src)
        outlines = f.get("rois") or src
        if "rois" not in f and src.suffix.lower() not in (".tif", ".tiff"):
            raise ValueError("That image has no ImageJ outlines inside it. Add the RoiSet .zip (or .roi / "
                             ".geojson) as the outlines file, or choose an ImageJ .tif saved with its overlay.")
        try:
            regs = read_regions(outlines)
        except Exception as e:                                    # not an ImageJ/QuPath outline file
            raise ValueError(f"Could not read outlines from {outlines.name}: {e}")
        if not regs:
            raise ValueError("No ImageJ overlay or ROIs found. Add the RoiSet .zip as the outlines file.")
        shape = base.shape[:2]
        labels = np.zeros(shape, np.int32)
        regions = []
        for i, (rname, outer, holes) in enumerate(regs, 1):
            m = _fill(outer, shape)
            for hh in holes:
                m ^= _fill(hh, shape)
            labels[m & (labels == 0)] = i
            regions.append({"label": i, "name": rname or f"region-{i:02d}", "area": int(m.sum()), "mean_prob": None,
                            "rings": [np.asarray(r, float).round(2).tolist() for r in [outer] + holes]})
        return _write_session(sid, name, "imagej", base, _pseudo_score(labels > 0), labels, False, 0.5, regions)

    raise ValueError(f"unknown route {route}")


def _looks_like_labels(a):
    """Integer image with a handful of small ids = a label image (one id per object), not probabilities."""
    u = np.unique(a)
    return len(u) <= 64 and u.max() < 64


def load_session(sid):
    d = _sdir(sid)
    meta = json.loads((d / "meta.json").read_text())
    state = json.loads((d / "state.json").read_text()) if (d / "state.json").exists() else None
    return {"meta": meta, "state": state}


def save_state(sid, state):
    d = _sdir(sid)
    if not (d / "meta.json").exists():
        raise ValueError("unknown session")
    tmp = d / "state.json.tmp"
    tmp.write_text(json.dumps(state))
    tmp.replace(d / "state.json")
    return {"ok": True}


def _arrays(sid):
    if sid not in _cache:
        d = _sdir(sid)
        _cache.clear()
        _cache[sid] = (np.load(d / "score.npy"), np.load(d / "labels.npy"))
    return _cache[sid]


def score_png(sid):
    """The score map as an 8-bit PNG (for the page's heatmap)."""
    out = _sdir(sid) / "score.png"
    if not out.exists():
        Image.fromarray((_arrays(sid)[0] * 255).round().astype(np.uint8)).save(out)
    return out


# ---------- grow / shrink ----------

def rethreshold(sid, lab, t, margin=160):
    """One region's outline at a different cut-off of the score map.

    Shrink (t above the import cut-off): the region's own pixels that still pass.
    Grow (t below): the region floods outward into pixels that pass, by watershed on the score so that
    neighbouring regions each keep their own side instead of merging.
    """
    score, labels = _arrays(sid)
    meta = json.loads((_sdir(sid) / "meta.json").read_text())
    base = meta["threshold"]
    ys, xs = np.nonzero(labels == lab)
    if len(ys) == 0:
        raise ValueError("unknown region")
    r0, r1 = max(ys.min() - margin, 0), min(ys.max() + margin + 1, labels.shape[0])
    c0, c1 = max(xs.min() - margin, 0), min(xs.max() + margin + 1, labels.shape[1])
    s, L = score[r0:r1, c0:c1], labels[r0:r1, c0:c1]
    if t >= base:
        region = (L == lab) & (s >= t)
    else:
        region = watershed(-s, markers=L, mask=(s >= t) | (L > 0)) == lab
    region = remove_small_holes(remove_small_objects(region, max_size=60), max_size=200)
    return {"rings": _rings(np.pad(region, 2), (c0 - 2, r0 - 2)), "area": int(region.sum()), "t": t}


# ---------- export ----------

def _depths(rings):
    """Nesting depth of each ring (0 = outer, 1 = hole, 2 = island in a hole, ...)."""
    def inside(pt, poly):
        x, y = pt
        px, py = poly[:, 0], poly[:, 1]
        qx, qy = np.roll(px, -1), np.roll(py, -1)
        cross = ((py > y) != (qy > y)) & (x < (qx - px) * (y - py) / (qy - py + 1e-12) + px)
        return cross.sum() % 2 == 1
    return [sum(inside(r[0], o) for j, o in enumerate(rings) if j != i) for i, r in enumerate(rings)]


def _roi(name, rings):
    """ImageJ ROI for a region: a polygon (draggable handles) when it is one ring, else a composite."""
    rings = [np.asarray(r, float) for r in rings]
    if len(rings) == 1:
        return h2.imagej_roi(name, rings[0], [])
    depth = _depths(rings)
    roi = ImagejRoi.frompoints(np.vstack(rings).astype(np.float32), name=name)      # name + bounds
    path = []
    for r, dep in zip(rings, depth):
        want_ccw = dep % 2 == 0                         # outers one way round, holes the other
        if (h2._signed_area(r) > 0) != want_ccw:
            r = r[::-1]
        path += [0, *r[0]]
        for x, y in r[1:]:
            path += [1, x, y]
        path += [4]
    roi.roitype, roi.options = ROI_TYPE.RECT, ROI_OPTIONS(0)
    roi.n_coordinates, roi.integer_coordinates, roi.subpixel_coordinates = 0, None, None
    roi.multi_coordinates = np.asarray(path, dtype=np.float32)
    roi.shape_roi_size = len(path)
    roi.fill_color, roi.stroke_color, roi.stroke_width = h2.FILL, h2.STROKE, 1
    return roi


SETTINGS = ROOT / "settings.json"


def get_settings():
    st = json.loads(SETTINGS.read_text()) if SETTINGS.exists() else {}
    d = Path(st.get("export_dir") or Path.home() / "Downloads")
    if not d.is_dir():
        d = Path.home() / "Downloads"
    return {"export_dir": str(d), "root": str(ROOT), "home": str(Path.home())}


def _dest(dest):
    """The folder to export into: must already exist. Remembered for next time."""
    d = Path(dest or get_settings()["export_dir"]).expanduser().resolve()
    if not d.is_dir():
        raise ValueError(f"That folder does not exist: {d}")
    SETTINGS.write_text(json.dumps({"export_dir": str(d)}))
    return d


def choose_folder():
    """Native macOS folder chooser (works whatever the browser). Returns {} if cancelled."""
    import subprocess
    start = get_settings()["export_dir"].replace("\\", "\\\\").replace('"', '\\"')
    r = subprocess.run(["osascript", "-e", "tell me to activate", "-e",
                        f'POSIX path of (choose folder with prompt "Save the export in" default location (POSIX file "{start}"))'],
                       capture_output=True, text=True, timeout=600)
    path = r.stdout.strip()
    if r.returncode != 0 or not path:
        return {}
    return {"export_dir": str(_dest(path))}


def reveal(path):
    """Show an exported folder in Finder."""
    import subprocess
    p = Path(path)
    if not p.is_dir():
        raise ValueError("That folder is no longer there.")
    subprocess.run(["open", str(p)], check=False)
    return {"ok": True}


def export(sid, regions, stem=None, dest=None):
    """regions: [{name, rings: [[[x, y], ...], ...]}] (curves already flattened by the page).
    Writes PNGs + ImageJ + QuPath files to sessions/<id>/export/ and checks the ImageJ file reads back."""
    d = _sdir(sid)
    meta = json.loads((d / "meta.json").read_text())
    stem = _slug(stem or meta["name"])
    out = d / "export"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir()
    base = np.asarray(Image.open(d / "tissue.png").convert("RGB"))
    shape = base.shape[:2]

    mask = np.zeros(shape, bool)
    rois, geoms = [], []
    for reg in regions:
        rings = [np.asarray(r, float) for r in reg["rings"] if len(r) >= 3]
        if not rings:
            continue
        m = np.zeros(shape, bool)
        for r in rings:
            m ^= _fill(r, shape)                       # even-odd within a region
        mask |= m
        # ImageJ polygons: thin the dense curve samples to a manageable number of handles
        slim = [approximate_polygon(np.vstack([r, r[:1]]), 1.0)[:-1] for r in rings]
        slim = [s for s in slim if len(s) >= 3]
        rois.append(_roi(reg["name"], slim))
        depth = _depths(slim)
        outers = [i for i, dd in enumerate(depth) if dd % 2 == 0]
        for k, i in enumerate(outers):
            holes = [slim[j] for j, dd in enumerate(depth) if dd == depth[i] + 1 and _depths([slim[j], slim[i]])[0] == 1]
            geoms.append((reg["name"] if len(outers) == 1 else f"{reg['name']}.{k + 1}", slim[i], holes))

    files = {}
    Image.fromarray((mask * 255).astype(np.uint8)).save(out / f"{stem}_mask.png")
    files["mask_png"] = f"{stem}_mask.png"
    shaded = base.astype(float)
    shaded[mask] = (1 - h2.BLEND_ALPHA) * shaded[mask] + h2.BLEND_ALPHA * h2.BLEND_RGB
    Image.fromarray(shaded.round().astype(np.uint8)).save(out / f"{stem}_overlay.png")
    files["overlay_png"] = f"{stem}_overlay.png"
    h2.write_imagej_tif(out / f"{stem}_ImageJ.tif", base, rois)
    files["imagej_tif"] = f"{stem}_ImageJ.tif"
    if rois:
        roiwrite(out / f"{stem}_RoiSet.zip", rois)
        files["roiset_zip"] = f"{stem}_RoiSet.zip"
    h2.write_qupath_geojson(out / f"{stem}_QuPath.geojson", geoms)
    files["qupath_geojson"] = f"{stem}_QuPath.geojson"

    back = to_mask(out / f"{stem}_ImageJ.tif", shape)             # read the ImageJ file back from disk
    union = (back | mask).sum()
    if dest is not None:                                           # copy the set into the chosen folder
        target = _dest(dest) / stem
        n = 2
        while target.exists():
            target = _dest(dest) / f"{stem}-{n}"
            n += 1
        shutil.copytree(out, target)
        out = target
    return {"dir": str(out), "files": {k: f"/sessions/{sid}/export/{v}" for k, v in files.items()},
            "regions": len(rois), "mask_px": int(mask.sum()),
            "imagej_iou": round(float((back & mask).sum() / union), 4) if union else 1.0}


# ---------- libraries ----------
# A library is a set of images to work through: libraries/<id>/library.json lists its cases, each with the
# files it was built from. A case's session is created the first time it is opened.

LIBS = ROOT / "libraries"
_TOKENS = (r"(mask|masks|prob|probs|probability|pred|prediction|overlay|shaded|highlighted|tissue|image|img|"
           r"original|orig|roiset|rois|roi|imagej|qupath|outlines|labels|label|seg|expert|gt|truth|model|result)")
_IGNORE = re.compile(r"(^|[_\-. ])(expert|gt|truth)$", re.I)


def _lib_path(lid):
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", lid or ""):
        raise ValueError("bad library id")
    return LIBS / lid


def _read_lib(lid):
    f = _lib_path(lid) / "library.json"
    if not f.exists():
        raise ValueError("That library no longer exists.")
    return json.loads(f.read_text())


def _write_lib(lib):
    d = _lib_path(lib["id"])
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "library.json.tmp"
    tmp.write_text(json.dumps(lib, indent=1))
    tmp.replace(d / "library.json")


def _case_key(rel):
    stem = rel.stem
    while True:
        new = re.sub(rf"(^|[_\-. ]){_TOKENS}$", "", stem, flags=re.I)
        if new == stem:
            break
        stem = new
    return str(rel.parent), stem


def _role(path):
    """What a file is: image | overlay | model | imagej | rois | ignore. By content first, name second."""
    ext, stem = path.suffix.lower(), path.stem.lower()
    if _IGNORE.search(stem):
        return "ignore"
    if ext in (".roi", ".zip", ".geojson", ".json"):
        return "rois"
    if ext == ".npy":
        return "model"
    try:
        if ext in (".tif", ".tiff"):
            with tifffile.TiffFile(path) as t:
                if (t.imagej_metadata or {}).get("Overlays"):
                    return "imagej"
                shape = t.pages[0].shape
            rgb = len(shape) == 3 and shape[-1] in (3, 4)
        elif ext in (".png", ".jpg", ".jpeg", ".bmp"):
            im = Image.open(path)
            rgb = im.mode not in ("1", "L", "I", "I;16", "F")
            if rgb:
                small = im.convert("RGB").resize((48, 48), Image.NEAREST)
                rgb = len(small.getcolors(48 * 48) or range(9)) > 2        # a mask saved as RGB is still a mask
        else:
            return "ignore"
    except Exception:
        return "ignore"
    if not rgb:
        return "model"
    if re.search(r"(overlay|shaded|highlighted)", stem):
        return "overlay"
    return "image"


def _build_cases(root, files):
    """Group files into cases and pick each case's route. files: paths under root."""
    groups = {}
    for f in sorted(files):
        rel = f.relative_to(root)
        if any(part.startswith((".", "__MACOSX")) for part in rel.parts):
            continue
        role = _role(f)
        if role != "ignore":
            parent, stem = _case_key(rel)
            g = groups.setdefault((parent, stem.lower()), {"_name": stem})
            g.setdefault(role, []).append(str(rel))
    cases, skipped = [], []
    for (parent, stem), g in sorted(groups.items()):
        name = g.pop("_name") or (Path(parent).name if parent != "." else "") or "image"
        model = sorted(g.get("model", []), key=lambda n: (not re.search(r"(prob|pred)", n.lower()),
                                                             Path(n).suffix.lower() == ".png"))
        if g.get("imagej"):
            route, fl = "imagej", {"imagej": g["imagej"][0], **({"rois": g["rois"][0]} if g.get("rois") else {})}
        elif model and g.get("image"):
            route, fl = "model", {"image": g["image"][0], "model": model[0]}
        elif g.get("rois") and g.get("image"):
            route, fl = "imagej", {"imagej": g["image"][0], "rois": g["rois"][0]}
        elif g.get("overlay") or g.get("image"):
            route, fl = "screenshot", {"overlay": (g.get("overlay") or g["image"])[0]}
        else:
            skipped.append(name + " (no image to go with it)")
            continue
        cases.append({"name": name, "route": route, "files": fl, "sid": None})
    return cases, skipped


def _safe_rel(path):
    parts = [re.sub(r"[^a-zA-Z0-9._ ()-]+", "_", p) for p in str(path).replace("\\", "/").split("/")]
    parts = [p for p in parts if p and p not in (".", "..")]
    if not parts:
        raise ValueError("bad path")
    return Path(*parts)


def library_begin(name):
    lid = f"{_slug(name or 'library')}-{time.strftime('%m%d%H%M%S')}"
    (_lib_path(lid) / "files").mkdir(parents=True)
    _write_lib({"id": lid, "name": name or "Library", "created": time.strftime("%Y-%m-%d %H:%M"),
                "root": f"libraries/{lid}/files", "own_files": True, "cases": []})
    return {"id": lid}


def library_put(lid, rel, data):
    dest = _lib_path(lid) / "files" / _safe_rel(rel)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return {"ok": True}


def library_finish(lid):
    """Unpack an uploaded .zip if there is one, then recognise the files and build the case list."""
    import zipfile
    lib = _read_lib(lid)
    root = ROOT / lib["root"]
    z = root / "__library__.zip"
    if z.exists():
        with zipfile.ZipFile(z) as zf:
            for info in zf.infolist():
                if info.is_dir() or "__MACOSX" in info.filename or Path(info.filename).name.startswith("."):
                    continue
                dest = root / _safe_rel(info.filename)
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(zf.read(info))
        z.unlink()
    lib["cases"], skipped = _build_cases(root, [p for p in root.rglob("*") if p.is_file()])
    if not lib["cases"]:
        shutil.rmtree(_lib_path(lid), ignore_errors=True)
        raise ValueError("No usable images found in that folder.")
    _write_lib(lib)
    return {"id": lid, "cases": len(lib["cases"]), "skipped": skipped}


def _seed_practice():
    """The built-in practice cases, as a library. Created once; if deleted it stays deleted."""
    LIBS.mkdir(exist_ok=True)
    marker = LIBS / ".seeded"
    if marker.exists():
        return
    marker.write_text("1")
    cases = []
    for c in sorted((ROOT / "data" / "cases").glob("*")):
        if (c / "prob.tif").exists():
            cases.append({"name": c.name, "route": "model",
                          "files": {"image": f"cases/{c.name}/tissue.png", "model": f"cases/{c.name}/prob.tif"}, "sid": None})
    for f in sorted((ROOT / "data" / "real").glob("*.png")):
        cases.append({"name": f.stem, "route": "screenshot", "files": {"overlay": f"real/{f.name}"}, "sid": None})
    if cases:
        _write_lib({"id": "practice", "name": "Practice cases", "created": time.strftime("%Y-%m-%d %H:%M"),
                    "root": "data", "own_files": False, "cases": cases})


def _edited(case):
    return bool(case.get("sid")) and (SESSIONS / case["sid"] / "state.json").exists()


def list_libraries():
    _seed_practice()
    out = []
    for f in sorted(LIBS.glob("*/library.json"), key=lambda p: p.stat().st_ctime):
        lib = json.loads(f.read_text())
        out.append({"id": lib["id"], "name": lib["name"], "created": lib.get("created", ""),
                    "count": len(lib["cases"]), "edited": sum(_edited(c) for c in lib["cases"]),
                    "done": sum(bool(c.get("done")) for c in lib["cases"])})
    return {"libraries": out}


def get_library(lid):
    lib = _read_lib(lid)
    return {"id": lib["id"], "name": lib["name"],
            "cases": [{"name": c["name"], "route": c["route"], "edited": _edited(c), "done": bool(c.get("done"))}
                      for c in lib["cases"]]}


def rename_library(lid, name):
    lib = _read_lib(lid)
    lib["name"] = (name or "").strip()[:80] or lib["name"]
    _write_lib(lib)
    return {"ok": True, "name": lib["name"]}


def delete_library(lid):
    lib = _read_lib(lid)
    for c in lib["cases"]:
        if c.get("sid"):
            shutil.rmtree(_sdir(c["sid"]), ignore_errors=True)
    shutil.rmtree(_lib_path(lid), ignore_errors=True)       # practice files live in data/ and are kept
    return {"ok": True}


def open_library_case(lid, index):
    """Session for one case of a library, created on first open."""
    lib = _read_lib(lid)
    if not 0 <= index < len(lib["cases"]):
        raise ValueError("No such image in this library.")
    c = lib["cases"][index]
    if c.get("sid") and (_sdir(c["sid"]) / "meta.json").exists():
        return {"id": c["sid"]}
    root = ROOT / lib["root"]
    sid = f"{_slug(lid)[:30]}-{index:04d}"
    import_session(c["route"], {k: root / v for k, v in c["files"].items()}, name=c["name"], sid=sid)
    c["sid"] = sid
    _write_lib(lib)
    return {"id": sid}


def add_single(meta):
    """A one-off import joins the 'Single imports' library, so it can be reopened and stepped through."""
    _seed_practice()
    try:
        lib = _read_lib("single")
    except ValueError:
        lib = {"id": "single", "name": "Single imports", "created": time.strftime("%Y-%m-%d %H:%M"),
               "root": "sessions", "own_files": False, "cases": []}
    lib["cases"].append({"name": meta["name"], "route": meta["route"], "files": {}, "sid": meta["id"]})
    _write_lib(lib)
    return {"id": meta["id"], "library": "single", "index": len(lib["cases"]) - 1}


# ---------- previews ----------

def _state_rings(state, step=1.0):
    """The editor's saved curves, flattened to polygons: [[ring, ...] per region]."""
    out = []
    for r in state.get("regions", []):
        rings = []
        for p in r["paths"]:
            n, pts = p["nodes"], []
            for i, sg in enumerate(p["segs"]):
                a, b = n[i], n[(i + 1) % len(n)]
                p0, c1 = np.array([a["x"], a["y"]]), np.array([sg["c1"]["x"], sg["c1"]["y"]])
                c2, p3 = np.array([sg["c2"]["x"], sg["c2"]["y"]]), np.array([b["x"], b["y"]])
                length = np.linalg.norm(c1 - p0) + np.linalg.norm(c2 - c1) + np.linalg.norm(p3 - c2)
                t = np.linspace(0, 1, int(min(200, max(4, np.ceil(length / step)))), endpoint=False)[:, None]
                pts.append((1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * c1 + 3 * (1 - t) * t ** 2 * c2 + t ** 3 * p3)
            if pts:
                rings.append(np.vstack(pts))
        out.append(rings)
    return out


def case_preview(lid, index, size=460):
    """Small JPEG of one library case as it currently stands: saved edits if any, else the imported regions."""
    import io
    from PIL import ImageChops, ImageDraw
    lib = _read_lib(lid)
    if not 0 <= index < len(lib["cases"]):
        raise ValueError("No such image in this library.")
    c, root = lib["cases"][index], ROOT / lib["root"]
    sd = _sdir(c["sid"]) if c.get("sid") else None
    regions, mask = None, None
    if sd and (sd / "meta.json").exists():
        base = Image.open(sd / "tissue.png").convert("RGB")
        if (sd / "state.json").exists():
            regions = _state_rings(json.loads((sd / "state.json").read_text()), step=6)
        else:
            regions = [[np.asarray(r, float) for r in reg["rings"]] for reg in json.loads((sd / "meta.json").read_text())["regions"]]
    else:
        f = {k: root / v for k, v in c["files"].items()}
        if c["route"] == "model":
            base = Image.fromarray(_rgb(f["image"]))
            raw = h2.load_array(f["model"])
            is_prob = len(np.unique(raw)) > 2 and (raw.dtype.kind == "f" or not _looks_like_labels(raw))
            mask = (h2.load_prob(f["model"]) >= 0.5) if is_prob else (raw > 0)
        elif c["route"] == "imagej":
            src = f.get("imagej")
            base = Image.fromarray(_rgb(src))
            regions = [[np.asarray(o, float)] + [np.asarray(x, float) for x in hs] for _, o, hs in read_regions(f.get("rois") or src)]
        else:
            base = Image.fromarray(_rgb(f["overlay"]))       # the shading is already in the picture
    k = size / max(base.size)
    small = base.resize((max(1, round(base.width * k)), max(1, round(base.height * k))), Image.LANCZOS)
    m = Image.new("L", small.size, 0)
    if mask is not None and mask.shape == (base.height, base.width):
        m = Image.fromarray((mask * 255).astype(np.uint8)).resize(small.size, Image.BILINEAR)
    for rings in regions or []:
        rm = Image.new("1", small.size, 0)
        for ring in rings:
            if len(ring) >= 3:
                tmp = Image.new("1", small.size, 0)
                ImageDraw.Draw(tmp).polygon([(float(x) * k, float(y) * k) for x, y in ring], fill=1)
                rm = ImageChops.logical_xor(rm, tmp)       # even-odd: holes stay clear
        m = ImageChops.lighter(m, rm.convert("L"))
    out = Image.composite(Image.blend(small, Image.new("RGB", small.size, (10, 80, 235)), 0.45), small, m)
    buf = io.BytesIO()
    out.save(buf, "JPEG", quality=86)
    return buf.getvalue()


def set_done(lid, index, done):
    lib = _read_lib(lid)
    if not 0 <= index < len(lib["cases"]):
        raise ValueError("No such image in this library.")
    lib["cases"][index]["done"] = bool(done)
    _write_lib(lib)
    return {"ok": True, "done": bool(done)}


def export_library(lid, dest=None):
    """Export every image of a library as it stands (saved edits, else the imported regions) into
    exports/<library>-<time>/, sorted by file type, with a summary.csv and a .zip of the lot."""
    import csv
    lib = _read_lib(lid)
    out = (_dest(dest) if dest else ROOT / "exports") / f"{_slug(lib['name'])}-{time.strftime('%Y%m%d-%H%M%S')}"
    folders = {"mask_png": "masks", "overlay_png": "shaded", "imagej_tif": "imagej", "roiset_zip": "roisets",
               "qupath_geojson": "qupath"}
    for d in folders.values():
        (out / d).mkdir(parents=True, exist_ok=True)
    rows = []
    for i, c in enumerate(lib["cases"]):
        sid = open_library_case(lid, i)["id"]
        sd = _sdir(sid)
        edited = (sd / "state.json").exists()
        if edited:
            state = json.loads((sd / "state.json").read_text())
            regions = [{"name": r["name"], "rings": [x.tolist() for x in rings]}
                       for r, rings in zip(state["regions"], _state_rings(state))]
        else:
            regions = [{"name": r["name"], "rings": r["rings"]} for r in json.loads((sd / "meta.json").read_text())["regions"]]
        stem = f"{i + 1:03d}_{_slug(c['name'])}"
        r = export(sid, regions, stem)
        for key, url in r["files"].items():
            src = sd / "export" / Path(url).name
            shutil.copy(src, out / folders[key] / src.name)
        rows.append({"image": c["name"], "file_stem": stem, "regions": r["regions"], "mask_px": r["mask_px"],
                     "edited": "yes" if edited else "no", "done": "yes" if c.get("done") else "no",
                     "imagej_iou": r["imagej_iou"]})
    with open(out / "summary.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return {"dir": str(out), "images": len(rows),
            "done": sum(r["done"] == "yes" for r in rows), "edited": sum(r["edited"] == "yes" for r in rows),
            "min_iou": min(r["imagej_iou"] for r in rows)}
