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
import contextvars
import json
import os
import sys
import re
import shutil
import time
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image
from roifile import roiwrite
from scipy import ndimage as ndi
from skimage.measure import approximate_polygon, label, regionprops
from skimage.morphology import disk, remove_small_holes, remove_small_objects
from skimage.segmentation import watershed

import coarse
import highlight2imagej as h2
from imagej2mask import _fill, read_regions, to_mask

ROOT = Path(__file__).resolve().parent
# Hosted mode (HOSTED=1): the editor runs on a server for people who only have a link. Each browser gets
# its own workspace (its own copy of the practice library, its own uploads and edits), exports come back
# as a .zip download, and nothing that touches the server's own folders or desktop is available.
HOSTED = os.environ.get("HOSTED") == "1"
DATA = Path(os.environ.get("DATA_DIR") or ROOT)                 # where sessions and libraries are kept
_workspace = contextvars.ContextVar("workspace", default="")


def set_workspace(ws):
    _workspace.set(ws or "")


def _base():
    ws = _workspace.get()
    return DATA / "workspaces" / ws if ws else DATA


def sessions():
    return _base() / "sessions"


def uploads():
    return sessions() / "_uploads"


def libs():
    return _base() / "libraries"


PSEUDO_PX = 80          # stand-in score: 0.5 at the edge, +-0.5 over +-40 px
RING_TOL = 0.75         # px; removes the pixel staircase before the page fits curves
DEFAULT_THRESHOLD = 0.675   # cut-off for probability maps when the file does not carry its own
FIT_TOL = 3             # px; how closely the page's curves follow an outline (tiled output: a quarter tile)
_cache = {}


# ---------- small helpers ----------

def _slug(s):
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", s).strip("-")[:60] or "session"


def _sdir(sid):
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", sid or ""):
        raise ValueError("bad session id")
    return sessions() / sid


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


def _write_session(sid, name, route, base, score, labels, has_prob, threshold, regions=None, extra=None):
    d = _sdir(sid)
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    Image.fromarray(base).save(d / "tissue.png")
    np.save(d / "score.npy", score.astype(np.float32))
    np.save(d / "labels.npy", labels.astype(np.int32))
    meta = {"id": sid, "name": name, "route": route, "has_prob": has_prob, "threshold": threshold,
            "width": int(base.shape[1]), "height": int(base.shape[0]), "created": time.strftime("%Y-%m-%d %H:%M"),
            "fit_tol": FIT_TOL, **(extra or {}),
            "regions": regions if regions is not None else _regions_from_labels(labels, score, has_prob)}
    (d / "meta.json").write_text(json.dumps(meta))
    _cache.pop(str(d), None)
    return meta


# ---------- import ----------

def _fit_image(base, shape):
    """The image at the model output's size. A larger original with the same proportions (a full-resolution
    scan of what the model saw scaled down) is scaled down to match; anything else is an error."""
    if base.shape[:2] == tuple(shape):
        return base, None
    (h, w), (H, W) = base.shape[:2], shape
    if abs(h / w - H / W) > 0.01 * H / W:
        raise ValueError(f"The model output is {W}x{H} but the image is {w}x{h}, a different shape.")
    small = np.asarray(Image.fromarray(base).resize((W, H), Image.LANCZOS))
    return small, f"The image ({w}x{h}) was scaled to the model output's size ({W}x{H})."


def _coarse(grid_values, shape, kind, binary, threshold, name, route, base, sid, note=None, source=None, grid_from=""):
    """Tiled model output -> a session with smooth outlines (see coarse.py)."""
    if binary:
        score, threshold = coarse.smooth_mask(grid_values, shape, kind), 0.5
    else:
        score = coarse.smooth_probability(grid_values, shape, kind)
    rows, cols = grid_values.shape
    cell = (shape[0] / rows, shape[1] / cols)
    tile = cell[0] * cell[1]
    yes = grid_values > (0.5 if binary else threshold)            # what the model said at each tile
    # the smooth outline decides only between tile centres: tidied (narrow gaps, specks, pinholes) without ever
    # changing the model's answer at a tile, and with every one-tile mark kept big enough to see
    mask = coarse.respect_tiles(score > threshold, yes, kind, close_r=max(1, round(0.6 * min(cell))), min_r=0.45 * min(cell))
    raw = coarse.expand(yes, shape, kind)
    extra = {"fit_tol": round(max(FIT_TOL, min(cell) / 3), 2), "fit": "smooth",
             "coarse": {"grid": [rows, cols], "tile_px": [round(cell[0], 3), round(cell[1], 3)], "from": grid_from,
                        "regions_as_tiles": int(label(raw, connectivity=2).max()),
                        "regions_smoothed": int(label(mask, connectivity=2).max())},
             "source_name": source, "notes": [n for n in [note] if n]}
    return _write_session(sid, name, route, base, score, _labels_by_area(mask), not binary, threshold, extra=extra)


def import_session(route, files, name=None, threshold=None, sid=None):
    """files: dict of role -> path. Roles: image, model, overlay, imagej, rois. Returns the session meta.
    route "grid": model is a numpy .npz of the model's raw, tiled output (see coarse.py)."""
    f = {k: Path(v) for k, v in files.items() if v}
    if not f:
        raise ValueError("Choose a file first.")
    threshold = DEFAULT_THRESHOLD if threshold is None else float(threshold)
    name = name or next(iter(f.values())).stem
    if route == "screenshot" and "overlay" in f and _role(f["overlay"]) == "imagej":
        route, f = "imagej", {"imagej": f["overlay"]}       # an ImageJ .tif that carries its own outlines
    if route == "model" and f.get("model") and f["model"].suffix.lower() == ".npz":
        route = "grid"
    sid = sid or f"{_slug(name)}-{time.strftime('%H%M%S')}"

    if route == "grid":
        if "image" not in f or "model" not in f:
            raise ValueError("The model's raw output (.npz) needs the image it was made from.")
        z = coarse.read_npz(f["model"])
        if z is None:
            raise ValueError(f"{f['model'].name} holds no probabilities, scores or mask the editor can use.")
        base = _rgb(f["image"])
        shape = z["shape"] or base.shape[:2]
        base, note = _fit_image(base, shape)
        t = z["threshold"] if z["threshold"] is not None else threshold
        return _coarse(z["prob"], tuple(shape), "stretch", z["binary"], t, name, "model", base, sid, note,
                       z["source"], f"{f['model'].name} ({z['from']})")

    if route == "model":
        if "image" not in f or "model" not in f:
            raise ValueError("Model output needs the original image and a probability map or mask.")
        base = _rgb(f["image"])
        raw = h2.load_array(f["model"])
        base, note = _fit_image(base, raw.shape)
        two_valued = len(np.unique(raw)) <= 2
        is_prob = not two_valued and (raw.dtype.kind == "f" or not _looks_like_labels(raw))
        g = coarse.detect_grid(raw if is_prob else raw > 0)
        if g:                                                    # tiled output enlarged as it was: smooth it
            vals = coarse.sample(h2.load_prob(f["model"]) if is_prob else raw > 0, g)
            return _coarse(vals, raw.shape, g.kind, not is_prob, threshold, name, "model", base, sid, note,
                           grid_from=f"{f['model'].name} (tiles found in the {'map' if is_prob else 'mask'})")
        if is_prob:
            score = h2.load_prob(f["model"])
            mask = h2.clean(score >= threshold, 200, 200)
        else:
            mask = h2.clean(raw > 0, 200, 200)
            score, threshold = _pseudo_score(mask), 0.5
        return _write_session(sid, name, "model", base, score, _labels_by_area(mask), bool(is_prob), threshold,
                              extra={"notes": [note] if note else []})

    if route == "screenshot":
        if "overlay" not in f:
            raise ValueError("Screenshot route needs the shaded image.")
        rgb = np.asarray(Image.open(f["overlay"]).convert("RGB"))
        mask, base = h2.shaded_mask(rgb, _rgb(f["image"]) if "image" in f else None)   # with the original: any colour
        if not mask.any():
            raise ValueError("No shading found in that image. Shading that is not blue can only be found "
                             "when the original image is given as well.")
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
        if "rois" not in f and not (tifffile.TiffFile(src).imagej_metadata or {}).get("Overlays"):
            raise ValueError("That .tif has no ImageJ outlines saved inside it. Open it with ImageJ + Outlines "
                             "and add the outlines file.")
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
        g = coarse.detect_grid(labels > 0, min_agree=0.999)       # outlines traced around tiles: smooth them
        if g:
            return _coarse(coarse.sample(labels > 0, g), shape, g.kind, True, 0.5, name, "imagej", base, sid,
                           grid_from=f"{(f.get('rois') or src).name} (tiles found in its outlines)")
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
    d = _sdir(sid)
    key = str(d)                                                # the folder, not the id: workspaces reuse ids
    if key not in _cache:
        _cache.clear()
        _cache[key] = (np.load(d / "score.npy"), np.load(d / "labels.npy"))
    return _cache[key]


def score_png(sid):
    """The score map as an 8-bit PNG (for the page's heatmap)."""
    out = _sdir(sid) / "score.png"
    if not out.exists():
        Image.fromarray((_arrays(sid)[0] * 255).round().astype(np.uint8)).save(out)
    return out


def tissue_view(sid):
    """The tissue image as a JPEG for the page to show (a 2048 px PNG is several MB; this is well under 1).
    Exports always use the original tissue.png."""
    d = _sdir(sid)
    out = d / "view.jpg"
    if not out.exists():
        Image.open(d / "tissue.png").convert("RGB").save(out, "JPEG", quality=90, subsampling=0)
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


SETTINGS = ROOT / "settings.json"


def get_settings():
    if HOSTED:
        return {"hosted": True, "export_dir": "", "root": "", "home": "", "platform": sys.platform}
    st = json.loads(SETTINGS.read_text()) if SETTINGS.exists() else {}
    d = Path(st.get("export_dir") or Path.home() / "Downloads")
    if not d.is_dir():
        d = Path.home() / "Downloads"
    return {"export_dir": str(d), "root": str(ROOT), "home": str(Path.home()), "platform": sys.platform}


def _dest(dest):
    """The folder to export into: must already exist. Remembered for next time.
    Hosted: always the workspace's own exports folder (the page then downloads a .zip of it)."""
    if HOSTED:
        d = _base() / "exports"
        d.mkdir(parents=True, exist_ok=True)
        return d
    d = Path(dest or get_settings()["export_dir"]).expanduser().resolve()
    if not d.is_dir():
        raise ValueError(f"That folder does not exist: {d}")
    SETTINGS.write_text(json.dumps({"export_dir": str(d)}))
    return d


def _zip(folder):
    """Hosted: zip an exported folder next to itself -> the file name to download. Only the .zip is kept,
    and only the newest few, so a workspace stays small."""
    shutil.make_archive(str(folder), "zip", root_dir=folder.parent, base_dir=folder.name)
    shutil.rmtree(folder, ignore_errors=True)
    for old in sorted(folder.parent.glob("*.zip"), key=lambda p: p.stat().st_mtime)[:-3]:
        old.unlink(missing_ok=True)
    return folder.name + ".zip"


def download_path(name):
    f = _base() / "exports" / Path(str(name)).name
    if f.suffix != ".zip" or not f.is_file():
        raise ValueError("That download is no longer there. Export again.")
    return f


def choose_folder():
    if HOSTED:
        raise ValueError("Not available here.")
    """The system's own folder chooser (works whatever the browser). Returns {} if cancelled.
    macOS: AppleScript. Windows: the standard folder dialog through PowerShell. Linux: zenity or kdialog.
    If none is available the page lets the path be typed instead."""
    import shutil as sh
    import subprocess
    start = get_settings()["export_dir"]
    if sys.platform == "darwin":
        q = start.replace("\\", "\\\\").replace('"', '\\"')
        cmd = ["osascript", "-e", "tell me to activate", "-e",
               f'POSIX path of (choose folder with prompt "Save the export in" default location (POSIX file "{q}"))']
    elif sys.platform.startswith("win"):
        q = start.replace("'", "''")
        cmd = ["powershell", "-NoProfile", "-STA", "-Command",
               "Add-Type -AssemblyName System.Windows.Forms; "
               "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
               f"$d.Description = 'Save the export in'; $d.SelectedPath = '{q}'; "
               "$top = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}; "
               "if ($d.ShowDialog($top) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"]
    elif sh.which("zenity"):
        cmd = ["zenity", "--file-selection", "--directory", "--title=Save the export in", f"--filename={start}/"]
    elif sh.which("kdialog"):
        cmd = ["kdialog", "--getexistingdirectory", start]
    else:
        raise ValueError("No folder chooser on this computer. Type the folder path into the box instead.")
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except FileNotFoundError:
        raise ValueError("Could not open a folder chooser. Type the folder path into the box instead.")
    path = r.stdout.strip()
    if r.returncode != 0 or not path:
        return {}
    return {"export_dir": str(_dest(path))}


def reveal(path):
    """Show an exported folder in the system's file manager (Finder, Explorer, ...)."""
    if HOSTED:
        raise ValueError("Not available here.")
    import subprocess
    p = Path(path)
    if not p.is_dir():
        raise ValueError("That folder is no longer there.")
    if sys.platform.startswith("win"):
        os.startfile(str(p))                                    # noqa: only exists on Windows
    else:
        subprocess.run(["open" if sys.platform == "darwin" else "xdg-open", str(p)], check=False)
    return {"ok": True}


FORMATS = ("corrected_mask_tif", "corrected_mask_full_tif", "mask_png", "overlay_png", "imagej_tif", "roiset_zip", "qupath_geojson")
_progress = {}                                   # job id -> {"done": n, "total": n}; polled by the page


_cancelled = set()                               # job ids the page asked to stop


class Cancelled(ValueError):
    pass


def progress(job):
    return _progress.get(job, {"done": 0, "total": 0})


def cancel(job):
    """Stop an export: it checks between steps, removes what it wrote so far, and returns "Export cancelled."."""
    if job:
        _cancelled.add(job)
    return {"ok": True}


def _stop_if_cancelled(job):
    if job and job in _cancelled:
        _cancelled.discard(job); _progress.pop(job, None)
        raise Cancelled("Export cancelled.")


def bundle_discard(bid):
    """A single-image upload the visitor cancelled: its files go at once."""
    shutil.rmtree(_bundle_dir(bid), ignore_errors=True)
    return {"ok": True}


def export(sid, regions, stem=None, dest=None, formats=None, job=None, deliver=False, tick=None):
    """regions: [{name, rings: [[[x, y], ...], ...]}] (curves already flattened by the page).
    Writes PNGs + ImageJ + QuPath files to sessions/<id>/export/ and checks the ImageJ file reads back."""
    want = set(formats or FORMATS) & set(FORMATS)
    split = "holes_split" in (formats or ())        # an option, not a file type: holes as separate ImageJ polygons
    if not want:
        raise ValueError("Choose at least one file type to export.")
    def prog(f):                                   # how far this export is, 0..1 (a library export passes its own tick)
        if tick:
            tick(f)
        elif job:
            _stop_if_cancelled(job)
            _progress[job] = {"done": round(f, 3), "total": 1}
    try:
        return _export(sid, regions, stem, dest, want, split, deliver, prog)
    except Cancelled:
        if not tick:                                # a library export tidies up its own folder
            shutil.rmtree(_sdir(sid) / "export", ignore_errors=True)
        raise


def _export(sid, regions, stem, dest, want, split, deliver, prog):
    prog(0)
    d = _sdir(sid)
    meta = json.loads((d / "meta.json").read_text())
    stem = _slug(stem or meta["name"])
    out = d / "export"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir()
    base = np.asarray(Image.open(d / "tissue.png").convert("RGB"))
    shape = base.shape[:2]
    prog(0.05)

    mask = np.zeros(shape, bool)
    rois, geoms = [], []
    for ri, reg in enumerate(regions):
        prog(0.05 + 0.3 * ri / max(len(regions), 1))
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
        depth = _depths(slim)
        outers = [i for i, dd in enumerate(depth) if dd % 2 == 0]
        for k, i in enumerate(outers):
            holes = [slim[j] for j, dd in enumerate(depth) if dd == depth[i] + 1 and _depths([slim[j], slim[i]])[0] == 1]
            geoms.append((reg["name"] if len(outers) == 1 else f"{reg['name']}.{k + 1}", slim[i], holes))
            rois += h2.imagej_rois(*geoms[-1], split=split)        # holes are true holes unless asked otherwise

    files = {}
    steps = [k for k in ("corrected_mask_tif", "corrected_mask_full_tif", "mask_png", "overlay_png", "imagej_tif",
                         "roiset_zip", "qupath_geojson") if k in want]
    done_steps = [0]
    def step():                                    # one file written
        done_steps[0] += 1
        prog(0.35 + 0.5 * done_steps[0] / max(len(steps), 1))
    prog(0.35)
    # the original image's name when the model's file gives one, otherwise this image's own name
    src = _slug(Path(meta["source_name"]).stem) if meta.get("source_name") else stem
    full = meta.get("original") if "corrected_mask_full_tif" in want else None
    if "corrected_mask_tif" in want:
        # <image>_corrected_mask.tif: the image's size, one 8-bit channel, 0 = background, 255 = inside a region.
        # <image> is the name of the image the model was run on when the model's file says so.
        name = f"{src}_corrected_mask_{shape[1]}x{shape[0]}.tif" if full else f"{src}_corrected_mask.tif"
        tifffile.imwrite(out / name, (mask * 255).astype(np.uint8), photometric="minisblack")
        files["corrected_mask_tif"] = name
        step()
    if full:
        # the same mask at the size of the original the model's image was scaled from: the curves are drawn
        # again at that size (not the small mask enlarged), so the edges stay smooth
        W0, H0 = int(full["width"]), int(full["height"])
        sx, sy = W0 / shape[1], H0 / shape[0]
        # drawn straight onto one full-size 8-bit image with PIL (outlines filled, holes cut out), so a 7040 x 5842
        # mask needs about two copies of 41 MB and a fraction of a second, even on a small server
        from PIL import ImageDraw
        big = Image.new("L", (W0, H0), 0)
        draw = ImageDraw.Draw(big)
        for reg in regions:
            rings = [np.asarray(r, float) for r in reg["rings"] if len(r) >= 3]
            depth = _depths(rings) if len(rings) > 1 else [0] * len(rings)
            for k in sorted(range(len(rings)), key=lambda k: depth[k]):       # outer first, then holes, then islands
                draw.polygon([(x * sx - 0.5, y * sy - 0.5) for x, y in rings[k]], fill=0 if depth[k] % 2 else 255)
        tifffile.imwrite(out / f"{src}_corrected_mask.tif", np.asarray(big, np.uint8), photometric="minisblack")
        files["corrected_mask_full_tif"] = f"{src}_corrected_mask.tif"
        step()
    if "mask_png" in want:
        Image.fromarray((mask * 255).astype(np.uint8)).save(out / f"{stem}_mask.png")
        files["mask_png"] = f"{stem}_mask.png"
        step()
    if "overlay_png" in want:
        shaded = base.astype(float)
        shaded[mask] = (1 - h2.BLEND_ALPHA) * shaded[mask] + h2.BLEND_ALPHA * h2.BLEND_RGB
        Image.fromarray(shaded.round().astype(np.uint8)).save(out / f"{stem}_overlay.png")
        files["overlay_png"] = f"{stem}_overlay.png"
        step()
    if "imagej_tif" in want:
        h2.write_imagej_tif(out / f"{stem}_ImageJ.tif", base, rois)
        files["imagej_tif"] = f"{stem}_ImageJ.tif"
        step()
    if "roiset_zip" in want and rois:
        roiwrite(out / f"{stem}_RoiSet.zip", rois)
        files["roiset_zip"] = f"{stem}_RoiSet.zip"
        step()
    if "qupath_geojson" in want:
        h2.write_qupath_geojson(out / f"{stem}_QuPath.geojson", geoms)
        files["qupath_geojson"] = f"{stem}_QuPath.geojson"
        step()

    prog(0.86)
    iou = None                                                     # read an ImageJ file back from disk, if one was written
    check = files.get("imagej_tif") or files.get("roiset_zip")
    if check:
        back = to_mask(out / check, shape)
        union = (back | mask).sum()
        iou = round(float((back & mask).sum() / union), 4) if union else 1.0
    download = None
    prog(0.92)
    if dest is not None or (HOSTED and deliver):                   # copy the set into the chosen folder
        target = _dest(dest) / stem
        n = 2
        while target.exists():
            target = _dest(dest) / f"{stem}-{n}"
            n += 1
        shutil.copytree(out, target)
        out = target
        if HOSTED:
            download = _zip(target)
            shutil.rmtree(d / "export", ignore_errors=True)
    prog(1)
    return {"dir": out.name if HOSTED else str(out), "download": download,
            "files": {k: f"/sessions/{sid}/export/{v}" for k, v in files.items()},
            "regions": len(regions), "mask_px": int(mask.sum()), "imagej_iou": iou}


# ---------- libraries ----------
# A library is a set of images to work through: libraries/<id>/library.json lists its cases, each with the
# files it was built from. A case's session is created the first time it is opened.

_TOKENS = (r"(mask|masks|prob|probs|probability|pred|prediction|overlay|shaded|highlighted|tissue|image|img|"
           r"original|orig|roiset|rois|roi|imagej|qupath|outlines|labels|label|seg|expert|gt|truth|model|result)")
_IGNORE = re.compile(r"(^|[_\-. ])(expert|gt|truth)$", re.I)


def _lib_path(lid):
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", lid or ""):
        raise ValueError("bad library id")
    return libs() / lid


def _read_lib(lid):
    _seed_practice()                                            # a first visit asks for the practice library straight away
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


def _lib_root(lib):
    """Where a library's files are: its own upload folder, the sessions folder (single imports), or the
    program's data folder (the practice library)."""
    if lib.get("own_files"):
        return _lib_path(lib["id"]) / "files"
    return sessions() if lib["root"] == "sessions" else ROOT / lib["root"]


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


# ---------- one image's folder: which file is what, by content ----------
# A model's output folder can hold the image several times over (the original, an ImageJ copy with outlines,
# shaded pictures, a heatmap), the model's answer in several forms (raw .npz, probability map, mask, outlines),
# and even an expert's reference outlines. Names vary between pipelines, so files are judged by what is in them;
# names only break ties.

_DERIVED = re.compile(r"(overlay|shaded|highlight|heat|gt|truth|expert|reference|prob|pred|mask|label|seg)", re.I)
_PICTURE_EXT = (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff")


def _tinted(rgb):
    """Share of strongly green-to-blue pixels: near 0 for H&E and similar stains, high for heatmaps and for
    pictures shaded cyan or blue."""
    small = np.asarray(Image.fromarray(rgb).resize((96, 96), Image.BILINEAR).convert("HSV"), float)   # shrink first: cheap
    hue, sat = small[..., 0] * 360 / 255, small[..., 1] / 255
    return float(((hue > 70) & (hue < 215) & (sat > 0.25)).mean())


def _blockiness(regs):
    """Share of outline length running exactly along x or y: 1.0 for outlines traced around pixels or tiles
    (a model's output), much lower for outlines drawn by hand."""
    along = total = 0.0
    for _, outer, holes in regs:
        for r in [outer] + list(holes):
            r = np.asarray(r, float)
            d = np.abs(np.diff(np.vstack([r, r[:1]]), axis=0))
            seg = np.hypot(d[:, 0], d[:, 1])
            along += seg[(d[:, 0] < 1e-6) | (d[:, 1] < 1e-6)].sum()
            total += seg.sum()
    return along / total if total else 0.0


# ---------- partial uploads ----------
# A big image file is first sent as its first 2 MB (a "head"): enough to read its size and any ImageJ outlines.
# Only the files then chosen are sent in full, so a model's output folder with a 123 MB original costs ~20 MB of
# upload, not 160 MB. A head is marked by a hidden file beside it, .<name>.head, holding the full size and the
# path the page sent it under.

def _head_mark(path):
    return path.parent / f".{path.name}.head"


def _is_head(path):
    return _head_mark(Path(path)).exists()


def _put(dest, data, head_of, sent):
    """Write an uploaded file, or its head (head_of = the file's full size in bytes)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    mark = _head_mark(dest)
    if head_of:
        mark.write_text(json.dumps({"size": int(head_of), "sent": sent}))
    else:
        mark.unlink(missing_ok=True)


def _needs(root, files):
    """The chosen files (paths relative to root) that so far are only heads -> what the page must send in full."""
    out = []
    for rel in files.values():
        mark = _head_mark(Path(root) / rel)
        if mark.exists():
            m = json.loads(mark.read_text())
            out.append({"path": m["sent"], "size": m["size"]})
    return out


def _probe(path):
    """What one file holds -> dict, or None if it is nothing the editor uses. Works on a head (see above): sizes and
    ImageJ outlines are read from it; anything that needs the pixels is skipped."""
    ext = path.suffix.lower()
    head = _is_head(path)
    info = {"path": path, "name": path.name, "head": head}
    try:
        if ext == ".npz":
            z = coarse.read_npz(path)
            if not z:
                return None
            return {**info, "kind": "grid", "shape": tuple(z["shape"]) if z["shape"] else None,
                    "grid": z["prob"].shape, "binary": z["binary"], "threshold": z["threshold"]}
        if ext == ".npy":
            a = np.load(path, mmap_mode="r")
            if a.ndim != 2:
                return None
            return {**info, "kind": "map", "shape": a.shape, "binary": len(np.unique(a[::7, ::7])) <= 2}
        if ext in (".zip", ".roi", ".geojson"):
            return {**info, "kind": "rois"}
        if ext in (".tif", ".tiff"):
            with tifffile.TiffFile(path) as t:
                md = t.imagej_metadata or {}
                shape = t.series[0].shape
            rgb = len(shape) == 3 and shape[-1] in (3, 4)
            has_rois = bool(md.get("Overlays") or md.get("ROI"))
            if not rgb and head:                                  # a big one-channel map: assume probabilities until sent
                return {**info, "kind": "map", "shape": tuple(shape[:2]), "binary": False}
            if not rgb:
                a = h2.load_array(path)
                return {**info, "kind": "map", "shape": a.shape[:2], "binary": len(np.unique(a)) <= 2}
            return {**info, "kind": "picture", "shape": tuple(shape[:2]), "rois": has_rois}
        if ext in _PICTURE_EXT:
            with Image.open(path) as im:
                size, mode = im.size, im.mode
                rgb = mode not in ("1", "L", "I", "I;16", "F") and (head or len(im.convert("RGB").resize((48, 48), Image.NEAREST).getcolors(2304) or range(9)) > 2)
            if not rgb:
                return {**info, "kind": "map", "shape": (size[1], size[0]), "binary": None}
            return {**info, "kind": "picture", "shape": (size[1], size[0]), "rois": False}
    except Exception:
        return None
    return None


def scan_bundle(root, paths):
    """One image's files -> {"route", "files", "picked", "notes", "reference", "options"}; raises if nothing usable.
    Outlines, best first: the model's raw output (.npz) > a probability map > a mask > ImageJ outlines that look
    like a model's (traced around pixels or tiles) > an outlines file > a shaded picture."""
    root = Path(root)
    items = [i for i in (_probe(Path(p)) for p in sorted(paths)
                         if not any(part.startswith((".", "__MACOSX")) for part in Path(p).relative_to(root).parts)) if i]
    rel = lambda i: str(i["path"].relative_to(root))
    pictures = [i for i in items if i["kind"] == "picture"]
    for p in pictures:
        if p["rois"]:
            try:
                p["regs"] = read_regions(p["path"])
                p["blocky"] = _blockiness(p["regs"])
            except Exception:
                p["rois"] = False
    for m in (i for i in items if i["kind"] == "map" and i["binary"] is None and not i.get("head")):
        m["binary"] = len(np.unique(h2.load_array(m["path"]))) <= 2
    grids = [i for i in items if i["kind"] == "grid"]
    maps = sorted((i for i in items if i["kind"] == "map"), key=lambda i: (i["binary"], bool(_DERIVED.search(i["name"])) is False))
    ij = sorted((p for p in pictures if p["rois"]), key=lambda p: -p["blocky"])
    rois = [i for i in items if i["kind"] == "rois"]

    def outline_options():
        out = [(g, "the model's raw output" + (" (yes/no tiles)" if g["binary"] else " (probabilities)")) for g in grids]
        out += [(m, "a mask" if m["binary"] else "a probability map") for m in maps]
        out += [(p, "ImageJ outlines" + (" (traced, like a model's)" if p["blocky"] > 0.95 else " (drawn by hand: possibly a reference)")) for p in ij]
        out += [(r, "an outlines file") for r in rois]
        return out

    options = outline_options()
    if not options and not pictures:
        raise ValueError("No image or model output found in that folder.")
    if not options:                                               # only pictures: a shaded picture (+ its original)
        shaded = sorted(pictures, key=lambda p: -_tinted(_rgb(p["path"])))
        files = {"overlay": rel(shaded[0])}
        if len(shaded) > 1 and shaded[1]["shape"] == shaded[0]["shape"]:
            files["image"] = rel(shaded[-1])
        return {"route": "screenshot", "files": files, "picked": [f"Shaded picture: {shaded[0]['name']}"],
                "notes": [], "reference": None, "original": None,
                "chosen": {"outlines": files["overlay"], "image": files.get("image") or files["overlay"]},
                "options": {"image": [rel(p) for p in pictures], "outlines": []}}
    src, why = options[0]
    return _bundle_choice(root, items, src, why, None, options)


def _bundle_choice(root, items, src, why, image=None, options=None):
    """Given the outline source (and optionally the image), the route, files and the notes to show."""
    rel = lambda i: str(i["path"].relative_to(root))
    pictures = [i for i in items if i["kind"] == "picture"]
    target = src.get("shape")
    if target is None:                                            # an .npz without the image size, or an outlines file
        target = max((p["shape"] for p in pictures), key=lambda s: s[0] * s[1], default=None)
    notes = []

    def image_score(p):
        s = 0.0
        if p["shape"] == target:
            s += 10
        elif target and abs(p["shape"][0] / p["shape"][1] - target[0] / target[1]) < 0.01 * target[0] / target[1]:
            s += 4                                                # same proportions: scaled to match
        else:
            return -99
        if p.get("rois") and p.get("blocky", 0) > 0.95:
            s += 2                                                # an ImageJ copy of the model's output: the clean image
        if p["path"].suffix.lower() in (".tif", ".tiff"):
            s += 1
        if _DERIVED.search(p["path"].stem):
            s -= 3
        if p["shape"] == target and not p.get("head"):             # heatmaps and shaded pictures (only pictures of the model's
            s -= 6 * _tinted(_rgb(p["path"]))                     # size are looked at: a large original is never decoded here)
        return s

    if src["kind"] == "picture" and image is None:
        image = src                                               # an ImageJ file is its own image
    if image is None:
        ranked = sorted(((image_score(p), p) for p in pictures), key=lambda t: -t[0])
        ranked = [t for t in ranked if t[0] > -99]
        if not ranked:
            raise ValueError(f"No image the size of the model output ({target[1]}x{target[0]}) was found."
                             if target else "No image found to go with the model output.")
        image = ranked[0][1]
    if src["kind"] == "grid":
        route, files = "grid", {"image": rel(image), "model": rel(src)}
        if src.get("threshold") is not None:
            notes.append(f"Cut-off: {src['threshold']:.3g}")
    elif src["kind"] == "map":
        route, files = "model", {"image": rel(image), "model": rel(src)}
    elif src["kind"] == "picture":
        route, files = "imagej", {"imagej": rel(src)} if image is src else {"imagej": rel(image), "rois": rel(src)}
    else:
        route, files = "imagej", {"imagej": rel(image), "rois": rel(src)}
    if image["shape"] != target and target:
        notes.append(f"Image scaled from {image['shape'][1]} × {image['shape'][0]} to {target[1]} × {target[0]}")
    reference = next((p for p in pictures if p.get("rois") and p is not src and p.get("blocky", 1) <= 0.95), None)
    if reference:
        notes.append(f"{reference['name']} contains outlines that were discarded")
    # a larger copy of the image with the same proportions (the original, before it was scaled for the model):
    # the corrected mask can also be exported at its size
    bigger = [p for p in pictures if target and p["shape"][0] > target[0] and
              abs(p["shape"][0] / p["shape"][1] - target[0] / target[1]) < 0.01 * target[0] / target[1]]
    original = max(bigger, key=lambda p: p["shape"][0], default=None)
    if options is None:
        options = []
    return {"route": route, "files": files, "picked": [f"Outlines: {src['name']}", f"Image: {image['name']}"],
            "notes": notes, "chosen": {"outlines": rel(src), "image": rel(image)},
            "reference": rel(reference) if reference else None,
            "original": {"file": rel(original), "width": original["shape"][1], "height": original["shape"][0]} if original else None,
            "options": {"image": [rel(p) for p in pictures],
                        "outlines": [{"file": rel(o), "what": w} for o, w in options]}}


def bundle_with(root, paths, outlines=None, image=None):
    """scan_bundle, with the person's own choice of outline file and/or image."""
    if not outlines and not image:
        return scan_bundle(root, paths)
    auto = scan_bundle(root, paths)
    root = Path(root)
    items = [i for i in (_probe(Path(p)) for p in sorted(paths)) if i]
    by = {str(i["path"].relative_to(root)): i for i in items}
    for p in by.values():
        if p["kind"] == "picture" and p["rois"] and "blocky" not in p:
            p["blocky"] = _blockiness(read_regions(p["path"]))
    opts = {o["file"]: o["what"] for o in auto["options"]["outlines"]}
    src_rel = outlines or next(iter(auto["files"].get(k) for k in ("model", "rois", "imagej") if auto["files"].get(k)))
    if src_rel not in by:
        raise ValueError("That file is not in the folder.")
    out = _bundle_choice(root, items, by[src_rel], opts.get(src_rel, "your choice"), by.get(image) if image else None)
    out["options"] = auto["options"]
    return out


def _pair_by_name(root, files):
    """Files paired by name: slide1_image.png with slide1_prob.tif. -> cases, skipped"""
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
        elif g.get("overlay") and g.get("image"):                # shaded picture + its original: any shading colour
            route, fl = "screenshot", {"overlay": g["overlay"][0], "image": g["image"][0]}
        elif g.get("overlay") or g.get("image"):
            route, fl = "screenshot", {"overlay": (g.get("overlay") or g["image"])[0]}
        else:
            skipped.append(name + " (no image to go with it)")
            continue
        cases.append({"name": name, "route": route, "files": fl, "sid": None})
    return cases, skipped


def _bundle_case(b):
    """The parts of a folder scan that a library keeps for one image."""
    return {"route": b["route"], "files": b["files"], "picked": b["picked"], "notes": b["notes"],
            "chosen": b["chosen"], "options": b["options"],
            **({"reference": b["reference"]} if b.get("reference") else {}),
            **({"original": b["original"]} if b.get("original") else {})}


def library_choose(lid, index, outlines=None, image=None):
    """Change which files one image of a library is made from (an image whose folder was read by content)."""
    lib = _read_lib(lid)
    if not 0 <= index < len(lib["cases"]):
        raise ValueError("No such image in this library.")
    c = lib["cases"][index]
    if "dir" not in c:
        raise ValueError("This image's files were paired by name; there is nothing to choose.")
    if c.get("files_cleared"):
        raise ValueError("This image has been opened, and its uploaded files were cleared to save space. Upload it again to choose other files.")
    root = _lib_root(lib)
    files = [p for p in (root / c["dir"]).iterdir() if p.is_file()]
    b = bundle_with(root, files, outlines, image)
    if c.get("sid"):                                             # made from the old choice: make it again when opened
        shutil.rmtree(_sdir(c["sid"]), ignore_errors=True)
        c["sid"] = None
    for k in ("reference", "original"):
        c.pop(k, None)
    c.update(_bundle_case(b))
    _write_lib(lib)
    return {**_case_view(c), "needs": _needs(root, c["files"])}


def _case_view(c):
    return {"name": c["name"], "route": c["route"], "edited": _edited(c), "done": bool(c.get("done")),
            **{k: c[k] for k in ("picked", "notes", "chosen", "options") if c.get(k) is not None},
            "choosable": "dir" in c}


def _build_cases(root, files):
    """A library: every folder is looked at on its own. A folder holding several images paired by name
    (slide1_image.png + slide1_prob.tif, slide2_...) gives one image per pair; any other folder is one image's
    folder, and scan_bundle works out which file is what. So a folder of image folders, a flat folder of
    named pairs, or a mix of both all work."""
    root = Path(root)
    by_dir = {}
    for f in sorted(files):
        rel = f.relative_to(root)
        if any(part.startswith((".", "__MACOSX")) for part in rel.parts):
            continue
        by_dir.setdefault(rel.parent, []).append(f)
    cases, skipped = [], []
    for d, fs in sorted(by_dir.items()):
        paired, skip = _pair_by_name(root, fs)
        complete = [c for c in paired if c["route"] != "screenshot" or "image" in c["files"]]
        stems = [c["name"].lower() for c in paired]
        nested = any(b != a and b.startswith(a) and b[len(a)] in "_-. " for a in stems for b in stems)
        # names that extend one another (S01.tif, S01_predicted_mask.tif) are one image's files, not several images
        if not nested and (len(complete) >= 2 or (len(complete) == 1 and len(fs) == len(complete[0]["files"]))):
            cases += paired
            skipped += skip
            continue
        try:
            b = scan_bundle(root, fs)
        except ValueError as e:
            skipped.append(f"{d if str(d) != '.' else 'the top folder'} ({e})")
            continue
        name = d.name if str(d) != "." else Path(b["files"].get("image") or next(iter(b["files"].values()))).stem
        cases.append({"name": name, "sid": None, "dir": str(d), **_bundle_case(b)})
    seen = []                                                     # two folders of the same name in different places
    for c in cases:
        c["name"] = _unique(c["name"], seen)
        seen.append(c["name"])
    return cases, skipped


def _safe_rel(path):
    parts = [re.sub(r"[^a-zA-Z0-9._ ()-]+", "_", p) for p in str(path).replace("\\", "/").split("/")]
    parts = [p for p in parts if p and p not in (".", "..")]
    if not parts:
        raise ValueError("bad path")
    return Path(*parts)


def _unique(name, taken):
    """name, or "name (2)", "name (3)"... whichever is not taken yet (as a file browser names copies)."""
    taken = {t.lower() for t in taken}
    if name.lower() not in taken:
        return name
    k = 2
    while f"{name} ({k})".lower() in taken:
        k += 1
    return f"{name} ({k})"


def _library_names(skip=None):
    return [l["name"] for l in list_libraries()["libraries"] if l["id"] != skip]


def library_begin(name):
    lid = base = f"{_slug(name or 'library')}-{time.strftime('%m%d%H%M%S')}"
    k = 2
    while _lib_path(lid).exists():                              # two uploads of one name in the same second
        lid, k = f"{base}-{k}", k + 1
    name = _unique(name or "Library", _library_names())
    (_lib_path(lid) / "files").mkdir(parents=True)
    _write_lib({"id": lid, "name": name, "created": time.strftime("%Y-%m-%d %H:%M"),
                "root": f"libraries/{lid}/files", "own_files": True, "cases": []})
    return {"id": lid}


# ---------- hosted: space per visitor ----------
WORKSPACE_LIMIT_GB = float(os.environ.get("WORKSPACE_LIMIT_GB", "3"))


def _space_used():
    """Bytes this visitor's workspace holds (the shared practice copies, linked in, are not counted)."""
    used = 0
    for f in _base().rglob("*"):
        try:
            st = f.lstat()
        except OSError:
            continue
        if f.is_file() and st.st_nlink == 1:
            used += st.st_size
    return used


def _space_check(incoming, cleanup=None):
    """Hosted: refuse an upload that would take this visitor past the limit, so one person cannot fill the disk."""
    if not HOSTED:
        return
    used = _space_used()
    if used + incoming > WORKSPACE_LIMIT_GB * 1e9:
        if cleanup is not None:
            shutil.rmtree(cleanup, ignore_errors=True)            # a half-uploaded library or folder is not kept
        raise ValueError(f"This upload would take you past the {WORKSPACE_LIMIT_GB:g} GB this demo server keeps per visitor "
                         f"({used / 1e9:.1f} GB used so far). Delete a library you no longer need (Open, Delete), or for "
                         "large batches run the editor on your own computer.")


def library_put(lid, rel, data, head_of=None):
    _space_check(len(data), cleanup=_lib_path(lid))
    _put(_lib_path(lid) / "files" / _safe_rel(rel), data, head_of, rel)
    return {"ok": True}


def library_needs(lid):
    """Files the library's images are made from that were sent only as heads (see _put)."""
    lib = _read_lib(lid)
    root = _lib_root(lib)
    return [n for c in lib["cases"] if not c.get("sid") for n in _needs(root, c.get("files", {}))]


def library_rescan(lid):
    """After the chosen files are sent in full, read the folders again (a file's details may have needed its pixels).
    Choices made by hand are kept where the file is still offered."""
    lib = _read_lib(lid)
    root = _lib_root(lib)
    old = {c["name"]: c for c in lib["cases"]}
    lib["cases"], skipped = _build_cases(root, [p for p in root.rglob("*") if p.is_file()])
    for c in lib["cases"]:
        o = old.get(c["name"])
        if o and o.get("chosen") and o["chosen"] != c.get("chosen") and "dir" in c:
            try:
                files = [p for p in (root / c["dir"]).iterdir() if p.is_file()]
                c.update(_bundle_case(bundle_with(root, files, o["chosen"]["outlines"], o["chosen"]["image"])))
            except ValueError:
                pass
    _write_lib(lib)
    return {"id": lid, "cases": len(lib["cases"]), "skipped": skipped, "needs": library_needs(lid)}


def _unzip_into(root, z):
    import zipfile
    with zipfile.ZipFile(z) as zf:
        for info in zf.infolist():
            if info.is_dir() or "__MACOSX" in info.filename or Path(info.filename).name.startswith("."):
                continue
            dest = root / _safe_rel(info.filename)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(info))
    z.unlink()


def _strip_single_top(root):
    """A .zip of one folder unpacks to root/<folder>/...: work from inside that folder."""
    kids = [p for p in root.iterdir() if not p.name.startswith((".", "__MACOSX"))]
    return kids[0] if len(kids) == 1 and kids[0].is_dir() else root


# ---------- one image from a folder (the "Single image" tab) ----------

def _bundle_dir(bid):
    if not re.fullmatch(r"b[0-9a-f]{12}", bid or ""):
        raise ValueError("bad upload id")
    return uploads() / "bundles" / bid


def bundle_begin():
    import uuid
    old = uploads() / "bundles"
    if old.exists():                                            # uploads removed or never opened, after a day
        for d in old.iterdir():
            if d.is_dir() and time.time() - d.stat().st_mtime > 86400:
                shutil.rmtree(d, ignore_errors=True)
    bid = "b" + uuid.uuid4().hex[:12]
    _bundle_dir(bid).mkdir(parents=True)
    return {"id": bid}


def bundle_put(bid, rel, data, head_of=None):
    _space_check(len(data), cleanup=_bundle_dir(bid))
    _put(_bundle_dir(bid) / _safe_rel(rel), data, head_of, rel)
    return {"ok": True}


def _bundle_files(bid):
    d = _bundle_dir(bid)
    if not d.exists():
        raise ValueError("That upload has expired. Add the files again.")
    for z in list(d.rglob("*.zip")):
        if zipfile_has_images(z):                                # a RoiSet .zip (only .roi files) stays as it is
            _unzip_into(z.parent, z)
    root = _strip_single_top(d)
    return root, [p for p in root.rglob("*") if p.is_file()]


def zipfile_has_images(z):
    import zipfile
    try:
        with zipfile.ZipFile(z) as zf:
            return any(Path(n).suffix.lower() in _PICTURE_EXT + (".npz", ".npy") for n in zf.namelist())
    except Exception:
        return False


def bundle_scan(bid, outlines=None, image=None):
    root, files = _bundle_files(bid)
    out = bundle_with(root, files, outlines, image)
    return {**out, "id": bid, "name": _bundle_name(root, out), "needs": _needs(root, out["files"])}


def _bundle_name(root, b):
    """The folder's own name if a folder was given, else the image's."""
    if not re.fullmatch(r"b[0-9a-f]{12}", root.name):
        return root.name
    if b["route"] == "grid":                                     # the model's file names the image it was run on
        z = coarse.read_npz(root / b["files"]["model"])
        if z and z["source"]:
            return Path(z["source"]).stem
    return Path(b["files"].get("image") or b["files"].get("imagej") or b["files"].get("overlay") or "image").stem


def bundle_open(bid, outlines=None, image=None, threshold=None):
    root, files = _bundle_files(bid)
    b = bundle_with(root, files, outlines, image)
    if _needs(root, b["files"]):
        raise ValueError("Some of the chosen files are still being sent. Try again in a moment.")
    name = _bundle_name(root, b)
    meta = import_session(b["route"], {k: root / v for k, v in b["files"].items()}, name=name, threshold=threshold)
    _patch_meta(meta, picked=b["picked"], notes=(meta.get("notes") or []) + b["notes"],
                **({"original": b["original"]} if b.get("original") else {}))
    shutil.rmtree(_bundle_dir(bid), ignore_errors=True)
    return add_single(meta)


def _patch_meta(meta, **kv):
    meta.update(kv)
    (_sdir(meta["id"]) / "meta.json").write_text(json.dumps(meta))


def library_finish(lid):
    """Unpack an uploaded .zip if there is one, then recognise the files and build the case list."""
    lib = _read_lib(lid)
    root = _lib_root(lib)
    z = root / "__library__.zip"
    if z.exists():
        _unzip_into(root, z)
    lib["cases"], skipped = _build_cases(root, [p for p in root.rglob("*") if p.is_file()])
    if not lib["cases"]:
        shutil.rmtree(_lib_path(lid), ignore_errors=True)
        raise ValueError("No usable images found in that folder.")
    _write_lib(lib)
    return {"id": lid, "cases": len(lib["cases"]), "skipped": skipped, "needs": library_needs(lid)}


PRACTICE = ("pash-low", "gynecomastoid-mid", "fibrocystic-mid", "prolif-fibrocystic-mid", "sclerosing-adenosis-mid",
            "sclerosing-adenosis-low")


def _seed_practice():
    """The built-in practice images, as a library. Always there (the tour works on them): it can be hidden, not
    deleted, and one deleted by an older version is made again.
    data/practice/ (in the repository) holds six model outputs for images in data/tissue_2k/. Without it
    (an older checkout), every case made by make_cases.py is used."""
    libs().mkdir(parents=True, exist_ok=True)
    if (_lib_path("practice") / "library.json").exists():
        return
    (libs() / ".seeded").write_text("1")
    cases = []
    if (ROOT / "data" / "practice").is_dir():
        for i, src in enumerate(PRACTICE, 1):
            if (ROOT / "data" / "practice" / f"{src}_prob.png").exists():
                cases.append({"name": f"practice-{i:02d}", "route": "model", "sid": None, "threshold": 0.5,
                              "files": {"image": f"tissue_2k/{src}.png", "model": f"practice/{src}_prob.png"}})
    else:
        for c in sorted((ROOT / "data" / "cases").glob("*")):
            if (c / "prob.tif").exists():
                cases.append({"name": c.name, "route": "model", "threshold": 0.5,
                              "files": {"image": f"cases/{c.name}/tissue.png", "model": f"cases/{c.name}/prob.tif"}, "sid": None})
    if cases:
        _write_lib({"id": "practice", "name": "Practice images", "created": time.strftime("%Y-%m-%d %H:%M"),
                    "root": "data", "own_files": False, "cases": cases})


def _edited(case):
    return bool(case.get("sid")) and (sessions() / case["sid"] / "state.json").exists()


def list_libraries():
    _seed_practice()
    out = []
    for f in sorted(libs().glob("*/library.json"), key=lambda p: p.stat().st_ctime):
        lib = json.loads(f.read_text())
        out.append({"id": lib["id"], "name": lib["name"], "created": lib.get("created", ""),
                    "count": len(lib["cases"]), "edited": sum(_edited(c) for c in lib["cases"]),
                    "done": sum(bool(c.get("done")) for c in lib["cases"]), "hidden": bool(lib.get("hidden"))})
    return {"libraries": out}


def set_hidden(lid, hidden):
    """Hide a library from the list (the practice images: kept for the tour, out of the way)."""
    lib = _read_lib(lid)
    lib["hidden"] = bool(hidden)
    _write_lib(lib)
    return {"ok": True, "hidden": lib["hidden"]}


def get_library(lid):
    lib = _read_lib(lid)
    return {"id": lib["id"], "name": lib["name"], "classes": _classes(lib), "pixel_um": lib.get("pixel_um"),
            "cases": [_case_view(c) for c in lib["cases"]]}


DEFAULT_CLASSES = [
    {"id": "tumour", "name": "Tumour", "color": [214, 69, 65], "exclude": False},
    {"id": "stroma", "name": "Stroma", "color": [38, 150, 100], "exclude": False},
    {"id": "necrosis", "name": "Necrosis", "color": [205, 140, 20], "exclude": False},
    {"id": "normal", "name": "Normal", "color": [20, 150, 170], "exclude": False},
    {"id": "exclude", "name": "Exclude", "color": [95, 100, 120], "exclude": True},
]


def _classes(lib):
    return lib["classes"] if lib.get("classes") is not None else DEFAULT_CLASSES


def set_scale(lid, um):
    """The library's pixel size in micrometres per pixel (0 or nothing = not set: measurements stay in pixels)."""
    lib = _read_lib(lid)
    um = float(um or 0)
    if um < 0 or um > 1000:
        raise ValueError("The pixel size should be between 0 and 1000 µm per pixel.")
    lib["pixel_um"] = um or None
    _write_lib(lib)
    return {"pixel_um": lib["pixel_um"]}


def reshape(sid, op, a, b=None, dist=0.0):
    """Whole-region edits as exact polygon geometry: merge, subtract, offset (grow or shrink evenly) and band.
    a, b: a region as a list of rings [[x, y], ...]; dist in image pixels. -> the outlines of the result.
    For a band only the outer edge comes back: its inner edge is the region's own outline."""
    from shapely.geometry import Polygon, box
    meta = json.loads((_sdir(sid) / "meta.json").read_text())
    dist = float(dist or 0)
    if abs(dist) > 4000:
        raise ValueError("That distance is larger than the image.")

    def geom(rings):                                     # even-odd, as the editor draws it
        g = None
        for r in rings or []:
            if len(r) < 3:
                continue
            pg = Polygon(r)
            if not pg.is_valid:
                pg = pg.buffer(0)
            g = pg if g is None else g.symmetric_difference(pg)
        return g

    def polys(g):
        return [q for q in getattr(g, "geoms", [g]) if q.geom_type == "Polygon" and q.area >= 4]

    A, B = geom(a), geom(b)
    if A is None or (op in ("merge", "subtract") and B is None):
        raise ValueError("Select a region first.")
    if op == "merge":
        out = A.union(B)
        if len(polys(out)) > 1:                          # close a hairline gap between neighbours
            out = out.buffer(0.75, join_style="mitre").buffer(-0.75, join_style="mitre")
        if len(polys(out)) > 1:
            raise ValueError("Those two regions do not touch, so they cannot be merged into one.")
    elif op == "subtract":
        out = A.difference(B)
    elif op == "offset":
        out = A.buffer(dist, quad_segs=24)
    elif op == "band":
        from shapely.ops import unary_union
        out = unary_union([Polygon(q.exterior) for q in polys(A)]).buffer(abs(dist), quad_segs=24)
    else:
        raise ValueError("Unknown shape change.")
    out = out.intersection(box(0, 0, meta["width"], meta["height"]))
    rings = []
    for q in polys(out):
        rings.append([[round(x, 2), round(y, 2)] for x, y in q.exterior.coords[:-1]])
        if op != "band":
            rings += [[[round(x, 2), round(y, 2)] for x, y in h.coords[:-1]] for h in q.interiors if Polygon(h).area >= 4]
    if not rings:
        raise ValueError("Nothing would be left of the region.")
    return {"rings": rings, "area": float(out.area)}


def library_measurements(lid):
    """One row per region for every image of a library, as CSV text: class, area, perimeter, circularity."""
    import csv
    import io
    lib = _read_lib(lid)
    um, classes = lib.get("pixel_um") or None, {c["id"]: c for c in _classes(lib)}
    rows = []
    for i, c in enumerate(lib["cases"]):
        sd = _sdir(open_library_case(lid, i)["id"])
        if (sd / "state.json").exists():
            state = json.loads((sd / "state.json").read_text())
            regs = list(zip(state["regions"], _state_rings(state)))
        else:
            regs = [({"name": r["name"], "meanProb": r.get("mean_prob")}, [np.asarray(x, float) for x in r["rings"]])
                    for r in json.loads((sd / "meta.json").read_text())["regions"]]
        for r, rings in regs:
            rings = [np.asarray(x, float) for x in rings if len(x) >= 3]
            if not rings:
                continue
            depth = _depths(rings)
            area = sum((-1 if d % 2 else 1) * abs(_shoelace(x)) for x, d in zip(rings, depth))
            perim = sum(float(np.linalg.norm(np.roll(x, -1, axis=0) - x, axis=1).sum()) for x, d in zip(rings, depth) if d == 0)
            cl = classes.get(r.get("cls") or "")
            rows.append({
                "image": c["name"], "region": r["name"], "class": cl["name"] if cl else "",
                "left_out": "yes" if cl and cl.get("exclude") else "no", "unsure": "yes" if r.get("unsure") else "no",
                "note": r.get("note", ""), "model_confidence": "" if r.get("meanProb") is None else round(r["meanProb"], 3),
                "area_px": round(area, 1), "perimeter_px": round(perim, 1),
                "circularity": round(4 * np.pi * area / perim ** 2, 3) if perim else "",
                "area_um2": round(area * um * um, 2) if um else "", "perimeter_um": round(perim * um, 2) if um else "",
                "pixel_um": um or "", "image_done": "yes" if c.get("done") else "no"})
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()) if rows else ["image", "region"])
    w.writeheader()
    w.writerows(rows)
    return {"name": f"{_slug(lib['name'])}_measurements.csv", "csv": buf.getvalue(), "rows": len(rows)}


def _shoelace(xy):
    x, y = xy[:, 0], xy[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def set_classes(lid, classes):
    """The library's class list (what a region can be labelled as). At most nine, one per number key."""
    lib, out = _read_lib(lid), []
    for c in (classes or [])[:9]:
        name = str(c.get("name", "")).strip()[:24]
        if not name:
            continue
        cid = re.sub(r"[^a-z0-9_-]", "", str(c.get("id", "")).lower())[:24] or f"c{len(out) + 1}"
        col = [max(0, min(255, int(v))) for v in list(c.get("color") or [79, 91, 213])[:3]]
        out.append({"id": cid, "name": name, "color": col, "exclude": bool(c.get("exclude"))})
    lib["classes"] = out
    _write_lib(lib)
    return {"classes": out}


def rename_library(lid, name):
    lib = _read_lib(lid)
    lib["name"] = _unique((name or "").strip()[:80], _library_names(skip=lid)) if (name or "").strip() else lib["name"]
    _write_lib(lib)
    return {"ok": True, "name": lib["name"]}


def delete_library(lid):
    if lid == "practice":
        raise ValueError("The practice images can be hidden but not deleted: the tour uses them.")
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
    root = _lib_root(lib)
    sid = f"{_slug(lid)[:30]}-{index:04d}"
    t = c.get("threshold", 0.5 if lid == "practice" else None)   # the practice maps were made around 0.5
    if _needs(root, c.get("files", {})):
        raise ValueError("This image's files are still being sent. Try again in a moment.")
    if not _from_template(lid, index, sid):
        meta = import_session(c["route"], {k: root / v for k, v in c["files"].items()}, name=c["name"], sid=sid, threshold=t)
        if c.get("original"):
            _patch_meta(meta, original=c["original"])
        if HOSTED and lib.get("own_files"):
            _clear_case_files(root, c)
    c["sid"] = sid
    _write_lib(lib)
    return {"id": sid}


def _clear_case_files(root, c):
    """Hosted: once an image of an uploaded library is opened, the editor works from its own copy (image, model
    output, outlines); the uploaded files are deleted to save the server's disk. A folder's other files go too."""
    try:
        if c.get("dir") is not None:
            d = root / c["dir"]
            for f in d.iterdir():
                if f.is_file():
                    f.unlink()
        for v in c.get("files", {}).values():
            (root / v).unlink(missing_ok=True)
        c["files_cleared"] = True
    except OSError:
        pass


def add_single(meta):
    """A one-off import joins the 'Single imports' library, so it can be reopened and stepped through."""
    _seed_practice()
    try:
        lib = _read_lib("single")
    except ValueError:
        lib = {"id": "single", "name": "Single imports", "created": time.strftime("%Y-%m-%d %H:%M"),
               "root": "sessions", "own_files": False, "cases": []}
    name = _unique(meta["name"], [c["name"] for c in lib["cases"]])
    if name != meta["name"]:
        _patch_meta(meta, name=name)
    lib["cases"].append({"name": name, "route": meta["route"], "files": {}, "sid": meta["id"]})
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
    c, root = lib["cases"][index], _lib_root(lib)
    if c["route"] == "grid" and not (c.get("sid") and (_sdir(c["sid"]) / "meta.json").exists()):
        c = dict(c, sid=open_library_case(lid, index)["id"])    # raw tiled output: preview the smoothed outlines
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


def _display_regions(sid):
    """An unedited image's regions as the editor draws them (its curves are fitted in the page and not stored):
    the page's own code, geom.js, run with Node (viewer/editor/fit_cli.js), so the export matches the screen.
    Without Node, the outline the curves are fitted to (within the fitting tolerance of the screen)."""
    import subprocess
    meta_path = _sdir(sid) / "meta.json"
    try:
        r = subprocess.run(["node", str(ROOT / "viewer" / "editor" / "fit_cli.js"), str(meta_path)],
                           capture_output=True, text=True, timeout=120, check=True)
        return json.loads(r.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        print("fit_cli.js not used:", e, flush=True)
        return [{"name": r["name"], "rings": r["rings"]} for r in json.loads(meta_path.read_text())["regions"]]


def export_library(lid, dest=None, formats=None, job=None):
    """Export every image of a library as it stands (saved edits, else the imported regions) into
    exports/<library>-<time>/, sorted by file type, with a summary.csv and a .zip of the lot."""
    import csv
    lib = _read_lib(lid)
    out = (_dest(dest) if dest or HOSTED else ROOT / "exports") / f"{_slug(lib['name'])}-{time.strftime('%Y%m%d-%H%M%S')}"
    folders = {"mask_png": "masks", "overlay_png": "shaded", "imagej_tif": "imagej", "roiset_zip": "roisets",
               "qupath_geojson": "qupath", "corrected_mask_tif": "corrected_masks", "corrected_mask_full_tif": "corrected_masks"}
    want = [f for f in FORMATS if f in set(formats or FORMATS)]
    opts = [f for f in (formats or ()) if f == "holes_split"]
    if not want:
        raise ValueError("Choose at least one file type to export.")
    for key in want:
        (out / folders[key]).mkdir(parents=True, exist_ok=True)
    rows = []
    if job:
        _progress[job] = {"done": 0, "total": len(lib["cases"])}
    n_cases = len(lib["cases"])
    def at(x):                                         # x images done (fractions too), for the page's progress bar
        if job:
            _stop_if_cancelled(job)
            _progress[job] = {"done": round(x, 3), "total": n_cases}
    try:
        return _export_cases(lid, lib, out, folders, want, opts, job, at, n_cases)
    except Cancelled:
        shutil.rmtree(out, ignore_errors=True)
        for c in _read_lib(lid)["cases"]:
            if c.get("sid"):
                shutil.rmtree(_sdir(c["sid"]) / "export", ignore_errors=True)
        raise


def _export_cases(lid, lib, out, folders, want, opts, job, at, n_cases):
    import csv
    rows = []
    for i, c in enumerate(lib["cases"]):
        at(i)
        sid = open_library_case(lid, i)["id"]                   # an image not opened yet is made first
        at(i + 0.25)
        sd = _sdir(sid)
        edited = (sd / "state.json").exists()
        if edited:
            state = json.loads((sd / "state.json").read_text())
            regions = [{"name": r["name"], "rings": [x.tolist() for x in rings]}
                       for r, rings in zip(state["regions"], _state_rings(state))]
        else:
            regions = _display_regions(sid)
        stem = f"{i + 1:03d}_{_slug(c['name'])}"
        r = export(sid, regions, stem, formats=want + opts, tick=lambda f, i=i: at(i + 0.25 + 0.75 * f))
        if job:
            _progress[job] = {"done": i + 1, "total": len(lib["cases"])}
        for key, url in r["files"].items():
            src = sd / "export" / Path(url).name
            # a corrected mask is named after the original image, which two images of a library can share:
            # number it like every other file so one never overwrites another
            name = src.name if src.name.startswith(stem) else f"{i + 1:03d}_{src.name}"
            shutil.copy(src, out / folders[key] / name)
        rows.append({"image": c["name"], "file_stem": stem, "regions": r["regions"], "mask_px": r["mask_px"],
                     "edited": "yes" if edited else "no", "done": "yes" if c.get("done") else "no",
                     "imagej_iou": r["imagej_iou"]})
    with open(out / "summary.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    if HOSTED:                                                   # the per-image working copies are not needed again
        for c in _read_lib(lid)["cases"]:
            if c.get("sid"):
                shutil.rmtree(_sdir(c["sid"]) / "export", ignore_errors=True)
    at(n_cases - 0.02)                                          # packing the .zip (hosted)
    if job:
        _cancelled.discard(job)
    return {"dir": out.name if HOSTED else str(out), "download": _zip(out) if HOSTED else None, "images": len(rows),
            "done": sum(r["done"] == "yes" for r in rows), "edited": sum(r["edited"] == "yes" for r in rows),
            "min_iou": min((r["imagej_iou"] for r in rows if r["imagej_iou"] is not None), default=None)}


# ---------- hosted housekeeping ----------

TEMPLATE = "_practice"                     # hosted: the practice sessions, built once per server and shared


def warm_practice():
    """Hosted: build the practice images' sessions once, when the server starts, so a new visitor's first image
    (and the tour) opens at once instead of being built for them (a few seconds on a small server)."""
    set_workspace(TEMPLATE)
    try:
        lib = _read_lib("practice")
        for i in range(len(lib["cases"])):
            sid = open_library_case("practice", i)["id"]
            d = _sdir(sid)
            tissue_view(sid)
            if json.loads((d / "meta.json").read_text()).get("has_prob"):
                score_png(sid)
            (d / ".ready").write_text("1")
    finally:
        set_workspace("")


def _from_template(lid, index, sid):
    """Hosted: a visitor's practice session from the shared one, if it is built. Large files that never change are
    linked, not copied (instant, no extra disk); files a session rewrites are copied."""
    if not HOSTED or lid != "practice" or _workspace.get() in ("", TEMPLATE):
        return False
    t = DATA / "workspaces" / TEMPLATE / "sessions" / f"practice-{index:04d}"
    if not (t / ".ready").exists():
        return False
    d = _sdir(sid)
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    for f in t.iterdir():
        if f.name in ("tissue.png", "score.npy", "labels.npy", "view.jpg", "score.png"):
            try:
                os.link(f, d / f.name)
            except OSError:
                shutil.copy(f, d / f.name)
        elif f.name == "meta.json":
            meta = json.loads(f.read_text())
            meta["id"] = sid
            (d / "meta.json").write_text(json.dumps(meta))
    return True


def sweep_workspaces(days=14):
    """Hosted: delete workspaces nobody has touched for a while."""
    root = DATA / "workspaces"
    if not root.is_dir():
        return 0
    old, n = time.time() - days * 86400, 0
    for d in root.iterdir():
        if d.name == TEMPLATE:
            continue
        if d.is_dir() and max((p.stat().st_mtime for p in d.rglob("*") if p.is_file()), default=d.stat().st_mtime) < old:
            shutil.rmtree(d, ignore_errors=True)
            n += 1
    return n
