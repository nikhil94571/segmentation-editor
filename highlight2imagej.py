"""Turn a segmentation model's output on an H&E image into editable ImageJ outlines (+ QuPath).

    Model-output route (what a segmentation model really produces):
        python highlight2imagej.py out/ --image tissue.png --prob prob.tif      # probability map
        python highlight2imagej.py out/ --image tissue.png --mask mask.png      # thresholded mask
    Screenshot route (fallback: only a picture of the shaded result exists):
        python highlight2imagej.py out/ --overlay shaded.png --image tissue.png   # any shading colour
        python highlight2imagej.py out/ --overlay shaded.png                      # blue shading only

Writes to out_dir/:
    <name>_ImageJ.tif       THE MAIN FILE: the clean tissue image with each region as an editable ImageJ
                            shape filled translucent blue. The outline IS the shading: edit the shape and the
                            blue moves with it. Open in ImageJ/Fiji; to edit: Image > Overlay > To ROI Manager,
                            click a region, drag handles (or Shift-draw to add / Alt-draw to cut), Update;
                            then Image > Overlay > From ROI Manager and File > Save.
    <name>_tissue.png       the clean base image (--image, or on the screenshot route the blue un-blended)
    <name>_QuPath.geojson   the same outlines for QuPath (drag the file onto the open image)
    <name>_RoiSet.zip       the same outlines as a separate ImageJ ROI set (ROI Manager > More > Open)
    <name>_mask.png         the binary mask the outlines were traced from
    <name>_regions.csv      region name, area (px), handles, centroid, bounding box (+ mean model probability)
    (imagej2mask.py turns an edited .tif / RoiSet.zip / .geojson back into a mask.)

How it works (three steps; step 1 differs by route):
  1. Mask.  Model-output route: threshold the probability map (default 0.5) or read the mask directly.
     Screenshot route, with the original image: the shading is wherever the two pictures differ, so any
     colour works (overlay_detect.pair_mask). Without it, the shading must be blue:
     the highlight is blue (hue ~190-262 deg); H&E tissue is pink/purple (hue ~270-345 deg).
     Some violet nuclei reach the edge of the blue band, so a loosely-blue region is kept only if it
     contains a solid core where smoothed (blue - red) is high: shading raises it everywhere it covers,
     stain only on scattered nuclei (hysteresis).
  2. Clean. Drop specks smaller than --min-area pixels and fill holes smaller than --min-hole pixels.
     Screenshot route only: larger holes are filled if their colour matches the image's shaded pixels
     better than its unshaded ones (tissue that turned magenta under the blue). On the model-output
     route the mask is authoritative, so its holes are kept.
  3. Trace. Each region's outline is traced along pixel boundaries, then simplified (Douglas-Peucker,
     --tolerance px, default 2) to a few dozen vertices, and written as an editable ImageJ polygon with a
     translucent blue fill. A real (unshaded) hole is its own editable polygon, outlined in cyan and named
     <region>-hole-K. --tolerance 0 = exact pixel trace (hundreds of vertices).
"""
import argparse
import csv
import json
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image
from roifile import ImagejRoi, ROI_TYPE, roiwrite
from scipy import ndimage as ndi
from skimage.color import rgb2hsv
from skimage.measure import approximate_polygon, find_contours, label, regionprops
from skimage.morphology import disk, opening, remove_small_holes, remove_small_objects

from overlay_detect import pair_mask

LOOSE = dict(hue=(190, 262), sat=0.20)   # anything that might be highlight (incl. its darker/edge pixels)
CORE_BLUE_EXCESS, CORE_SMOOTH_PX = 85, 3   # solid core: smoothed (blue - red) > 85
CORE_OPEN_PX, CORE_MIN_FRAC = 3, 0.0001  # a core must be thicker than ~6 px and >0.01% of the image


def _band(hsv, hue, sat):
    h = hsv[..., 0] * 360
    return (h >= hue[0]) & (h <= hue[1]) & (hsv[..., 1] >= sat)


def highlight_mask(rgb):
    """Boolean mask of highlighted pixels. Accepts an RGB highlight image or a ready-made binary mask.

    Hysteresis: keep a loosely-blue region only if it contains a solid core. Blending towards blue pulls
    red down and blue up across the WHOLE shaded area (stroma too), so blue-minus-red, smoothed over a
    few pixels, is high and contiguous there; stain raises it only on scattered nuclei, which smoothing
    averages away with the pink stroma between them. Works whatever the underlying tissue hue.
    """
    if len(np.unique(rgb)) <= 2:  # already a mask
        return rgb.max(axis=2) > 0 if rgb.ndim == 3 else rgb > 0
    hsv = rgb2hsv(rgb[..., :3])
    loose = label(_band(hsv, **LOOSE), connectivity=2)
    blue_excess = ndi.gaussian_filter(rgb[..., 2].astype(float) - rgb[..., 0], CORE_SMOOTH_PX)
    core = opening(blue_excess > CORE_BLUE_EXCESS, disk(CORE_OPEN_PX))
    core = remove_small_objects(core, max_size=int(CORE_MIN_FRAC * core.size))
    keep = np.unique(loose[core])
    return np.isin(loose, keep[keep > 0])


def clean(mask, min_area, min_hole, rgb=None):
    mask = remove_small_objects(mask, max_size=min_area - 1)
    mask = remove_small_holes(mask, max_size=min_hole - 1)
    return mask if rgb is None else fill_shaded_holes(mask, rgb)


def fill_shaded_holes(mask, rgb):
    """Fill enclosed gaps that are really shaded tissue whose colour fell outside the blue band
    (e.g. red/pink lumen contents turn magenta under the blue). Each gap is compared with this image's
    own shaded and unshaded colours and filled if it is closer to shaded. Real unshaded holes stay."""
    filled = ndi.binary_fill_holes(mask)
    holes = label(filled & ~mask, connectivity=1)
    if holes.max() == 0 or not mask.any():
        return mask
    shaded, unshaded = np.median(rgb[mask], axis=0), np.median(rgb[~filled], axis=0)
    out = mask.copy()
    for k in range(1, holes.max() + 1):
        c = np.median(rgb[holes == k], axis=0)
        if np.linalg.norm(c - shaded) < np.linalg.norm(c - unshaded):
            out |= holes == k
    return out


def _ring(region_mask, connectivity, tolerance):
    """Closed outline of a single blob (no holes), in ImageJ x,y coordinates (pixel centre = +0.5).
    connectivity "high" = 8-connected (regions), "low" = 4-connected (holes).
    tolerance = max distance (px) the simplified outline may stray from the pixel boundary;
    0 keeps every corner (exact), ~2 gives a few dozen draggable handles per region."""
    padded = np.pad(region_mask, 1).astype(float)
    contours = find_contours(padded, 0.5, fully_connected=connectivity)
    assert len(contours) == 1, f"expected one outline, got {len(contours)}"
    ring = approximate_polygon(contours[0], tolerance=tolerance)   # Douglas-Peucker (0 = lossless)
    xy = ring[:, ::-1] - 1 + 0.5                      # (row,col) -> (x,y); undo pad; pixel centre
    return xy[:-1] if np.allclose(xy[0], xy[-1]) else xy


# The outline IS the shading: each region is drawn as a translucent blue fill in the example's blend
# (45% towards RGB 10,80,235), so dragging a handle moves the blue with it. ARGB.
FILL = bytes([115, 10, 80, 235])
STROKE = b"\xff\xff\xe6\x00"                                   # yellow, shown while a region is selected
BLEND_ALPHA, BLEND_RGB = 0.45, np.array([10, 80, 235], float)


def region_geometry(mask, tolerance=2.0):
    """-> list of (name, outer_xy, [hole_xy...]), largest region first, plus a summary row per region."""
    lab = label(mask, connectivity=2)
    props = sorted(regionprops(lab), key=lambda r: -r.area)
    geoms, rows = [], []
    for i, r in enumerate(props, 1):
        name = f"region-{i:02d}"
        r0, c0, r1, c1 = r.bbox
        off = [c0 - 1, r0 - 1]
        blob = np.pad(lab[r0:r1, c0:c1] == r.label, 1)        # local crop, 1px border
        filled = ndi.binary_fill_holes(blob)
        outer = _ring(filled, "high", tolerance) + off
        holes_lab = label(filled & ~blob, connectivity=1)       # background is 4-connected
        holes = [_ring(holes_lab == k, "low", tolerance) + off for k in range(1, holes_lab.max() + 1)]
        holes = [h for h in holes if len(h) >= 3]               # a hole simplified to nothing is dropped
        geoms.append((name, outer, holes))
        rows.append({"name": name, "area_px": int(r.area), "holes": len(holes), "vertices": len(outer),
                     "centroid_x": round(r.centroid[1], 1), "centroid_y": round(r.centroid[0], 1),
                     "bbox_x": c0, "bbox_y": r0, "bbox_w": c1 - c0, "bbox_h": r1 - r0})
    return geoms, rows


def _signed_area(xy):
    x, y = xy[:, 0], xy[:, 1]
    return 0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)


HOLE_STROKE = b"\xff\x00\xc8\xff"                              # cyan outline for holes


def imagej_rois(name, outer, holes):
    """Every outline is a plain polygon, so ImageJ gives each one draggable handles.
    The region is a blue-filled polygon; each hole is its own unfilled cyan polygon named
    <region>-hole-K (ImageJ's composite shape would keep the hole unshaded but has no handles).
    imagej2mask.py cuts the '-hole-' polygons back out of their region."""
    region = ImagejRoi.frompoints(outer.astype(np.float32), name=name)
    region.roitype = ROI_TYPE.POLYGON
    region.fill_color, region.stroke_color, region.stroke_width = FILL, STROKE, 1
    out = [region]
    for k, h in enumerate(holes, 1):
        hole = ImagejRoi.frompoints(h.astype(np.float32), name=f"{name}-hole-{k}")
        hole.roitype = ROI_TYPE.POLYGON
        hole.stroke_color, hole.stroke_width = HOLE_STROKE, 2
        out.append(hole)
    return out


def region_rois(mask, tolerance=2.0):
    geoms, rows = region_geometry(mask, tolerance)
    return [r for g in geoms for r in imagej_rois(*g)], rows


def unshade(rgb, mask):
    """Approximately undo the model's blue blend inside the mask (when the original tissue image is not
    available), so the base image is clean tissue and the only blue is the editable fill."""
    out = rgb.astype(float)
    out[mask] = (out[mask] - BLEND_ALPHA * BLEND_RGB) / (1 - BLEND_ALPHA)
    return out.clip(0, 255).round().astype(np.uint8)


def write_imagej_tif(path, base_rgb, rois):
    """Clean tissue image + regions stored as an ImageJ overlay: one file; regions show as blue on open."""
    tifffile.imwrite(path, base_rgb, imagej=True, photometric="rgb",
                     metadata={"Overlays": [r.tobytes() for r in rois]} if rois else {})


def write_qupath_geojson(path, geoms):
    """QuPath annotations: one Polygon per region (holes as interior rings), class 'Model prediction'."""
    ring = lambda xy: [[round(float(x), 2), round(float(y), 2)] for x, y in np.vstack([xy, xy[:1]])]
    feats = [{"type": "Feature", "id": n,
              "geometry": {"type": "Polygon", "coordinates": [ring(o)] + [ring(h) for h in hs]},
              "properties": {"objectType": "annotation", "name": n,
                             "classification": {"name": "Model prediction", "color": [10, 80, 235]}}}
             for n, o, hs in geoms]
    Path(path).write_text(json.dumps({"type": "FeatureCollection", "features": feats}))


def load_array(path):
    """Read a model output file: .npy, .tif/.tiff (any dtype), or PNG/JPG. Returns a 2-D array."""
    path = Path(path)
    if path.suffix.lower() == ".npy":
        a = np.load(path)
    elif path.suffix.lower() in (".tif", ".tiff"):
        a = tifffile.imread(path)
    else:
        a = np.asarray(Image.open(path))
    a = np.squeeze(a)
    if a.ndim == 3:                               # e.g. an RGB-saved mask: any non-zero channel counts
        a = a.max(axis=2)
    return a


def load_prob(path):
    """Probability map -> float 0..1 (float files as-is; 8/16-bit integer files scaled by their max)."""
    a = load_array(path)
    if a.dtype.kind in "ui":
        a = a / np.iinfo(a.dtype).max
    return a.astype(np.float32)


def shaded_mask(rgb, original=None, min_area=200, min_hole=200):
    """Screenshot route -> (mask, clean base image). With the original image the shading is found by
    comparing the two (any colour); without it, by its blue colour."""
    if original is not None:
        if original.shape != rgb.shape:
            raise ValueError(f"The original image ({original.shape[1]}x{original.shape[0]}) and the shaded image "
                             f"({rgb.shape[1]}x{rgb.shape[0]}) are different sizes.")
        m, blend = pair_mask(rgb, original)
        if blend is not None:
            return clean(m, min_area, min_hole), original
    m = clean(highlight_mask(rgb), min_area, min_hole, rgb)
    return m, (original if original is not None else unshade(rgb, m))


def convert(out_dir, image=None, mask=None, prob=None, overlay=None, threshold=0.5,
            min_area=200, min_hole=200, tolerance=2.0, stem=None):
    """Two routes to the same editable ImageJ file:

    Model-output route (the real one):  image + mask, or image + prob (thresholded at `threshold`).
        The mask is authoritative: only specks < min_area and holes < min_hole are tidied.
    Screenshot route (fallback):         overlay (a picture of the shaded result), optionally + image.
        With the image, the shading is wherever the two differ (any colour). Without it, blue shading is
        found by colour and un-blended to recover the tissue.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    p = None
    if mask is not None or prob is not None:
        if image is None:
            raise SystemExit("--mask/--prob need --image (the original tissue the model was given)")
        base = np.asarray(Image.open(image).convert("RGB"))
        if prob is not None:
            p = load_prob(prob)
            m = p >= threshold
        else:
            m = load_array(mask) > 0                # binary 0/1, 0/255, or a label image (one id per object)
        if m.shape != base.shape[:2]:
            raise SystemExit(f"mask/prob size {m.shape[::-1]} does not match image size {base.shape[1::-1]}")
        m = clean(m, min_area, min_hole)
        route, stem = "model-output", stem or Path(prob or mask).stem
    elif overlay is not None:
        rgb = np.asarray(Image.open(overlay).convert("RGB"))
        m, base = shaded_mask(rgb, np.asarray(Image.open(image).convert("RGB")) if image else None, min_area, min_hole)
        route, stem = "screenshot", stem or Path(overlay).stem
    else:
        raise SystemExit("give --image with --mask or --prob (model output), or --overlay (screenshot)")

    geoms, rows = region_geometry(m, tolerance)
    if p is not None:                              # model confidence per region: useful for the expert
        lab = label(m, connectivity=2)
        for row, r in zip(rows, sorted(regionprops(lab, intensity_image=p), key=lambda r: -r.area)):
            row["mean_prob"] = round(float(r.intensity_mean), 3)
    rois = [r for g in geoms for r in imagej_rois(*g)]
    roi_path = out_dir / f"{stem}_RoiSet.zip"
    roi_path.unlink(missing_ok=True)
    if rois:
        roiwrite(roi_path, rois)
    write_imagej_tif(out_dir / f"{stem}_ImageJ.tif", base, rois)
    write_qupath_geojson(out_dir / f"{stem}_QuPath.geojson", geoms)
    Image.fromarray(base).save(out_dir / f"{stem}_tissue.png")
    Image.fromarray((m * 255).astype(np.uint8)).save(out_dir / f"{stem}_mask.png")
    with open(out_dir / f"{stem}_regions.csv", "w", newline="") as f:
        fields = ["name", "area_px", "holes", "vertices", "centroid_x", "centroid_y",
                  "bbox_x", "bbox_y", "bbox_w", "bbox_h"] + (["mean_prob"] if p is not None else [])
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    return {"route": route, "stem": stem, "mask": m, "rows": rows, "roiset": roi_path,
            "tif": out_dir / f"{stem}_ImageJ.tif", "qupath": out_dir / f"{stem}_QuPath.geojson",
            "tissue": out_dir / f"{stem}_tissue.png"}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out_dir")
    ap.add_argument("--image", help="original tissue image (what the model was given)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--mask", help="model mask: PNG/TIFF/NPY, binary or label image")
    g.add_argument("--prob", help="model probability map: TIFF/NPY float 0-1, or 8/16-bit")
    g.add_argument("--overlay", help="screenshot of the shaded result (fallback route)")
    ap.add_argument("--threshold", type=float, default=0.5, help="probability cut-off for --prob")
    ap.add_argument("--min-area", type=int, default=200, help="drop regions smaller than this (px)")
    ap.add_argument("--min-hole", type=int, default=200, help="fill holes smaller than this (px)")
    ap.add_argument("--tolerance", type=float, default=2.0,
                    help="max outline simplification in px (0 = exact pixel trace, many vertices)")
    a = ap.parse_args()
    r = convert(a.out_dir, a.image, a.mask, a.prob, a.overlay, a.threshold, a.min_area, a.min_hole, a.tolerance)
    print(f"[{r['route']}] {len(r['rows'])} regions, {int(r['mask'].sum())} px -> {r['tif']}")
