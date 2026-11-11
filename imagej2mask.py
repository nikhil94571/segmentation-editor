"""Turn (expert-edited) outlines back into a binary mask: the return leg of the workflow.

    python imagej2mask.py edited_ImageJ.tif  mask.png          # overlay saved in ImageJ
    python imagej2mask.py RoiSet.zip         mask.png --like image.png
    python imagej2mask.py annotations.geojson mask.png --like image.png   # exported from QuPath

Pixels are filled the way ImageJ fills ROIs (a pixel is inside when its centre is inside the outline).
A polygon named '<region>-hole-K' is cut out of '<region>'. In QuPath GeoJSON, interior rings are holes.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image
from roifile import ImagejRoi, roiread
from skimage.draw import polygon2mask


def _fill(xy, shape):
    # ImageJ pixel centre (x+.5, y+.5) == skimage pixel centre (row, col) => shift by -0.5
    return polygon2mask(shape, np.c_[np.asarray(xy)[:, 1] - 0.5, np.asarray(xy)[:, 0] - 0.5])


def read_regions(path):
    """-> list of (name, outer_xy, [hole_xy, ...]) from a .tif overlay, RoiSet .zip/.roi, or .geojson."""
    path = Path(path)
    if path.suffix.lower() == ".geojson":
        out = []
        for f in json.loads(path.read_text())["features"]:
            g = f["geometry"]
            polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]   # MultiPolygon
            for k, rings in enumerate(polys):
                name = f.get("properties", {}).get("name") or f.get("id") or "region"
                out.append((f"{name}.{k}" if len(polys) > 1 else name,
                            np.array(rings[0])[:-1], [np.array(r)[:-1] for r in rings[1:]]))
        return out
    if path.suffix.lower() in (".tif", ".tiff"):
        with tifffile.TiffFile(path) as t:
            ov = (t.imagej_metadata or {}).get("Overlays", [])
        rois = [ImagejRoi.frombytes(b) for b in (ov if isinstance(ov, list) else [ov])]
    else:
        rois = roiread(path)
        rois = rois if isinstance(rois, list) else [rois]
    regions, holes = {}, {}
    for r in rois:
        if r.multi_coordinates is not None and r.shape_roi_size:      # composite: rings, even-odd fill
            rings = r.path2coords(r.multi_coordinates)
            regions[r.name] = ("evenodd", rings)
        elif "-hole-" in r.name:                                       # older files: separate hole polygons
            holes.setdefault(r.name.split("-hole-")[0], []).append(r.coordinates())
        else:
            regions[r.name] = ("polygon", [r.coordinates()])
    return [(n, rings[0], rings[1:] + holes.get(n, [])) for n, (_, rings) in regions.items()]


def to_mask(path, shape):
    """Outer ring minus hole rings per region (even-odd within a region), union over regions."""
    out = np.zeros(shape, bool)
    for _, outer, holes in read_regions(path):
        region = _fill(outer, shape)
        for h in holes:
            region ^= _fill(h, shape)
        out |= region
    return out


def image_shape(path):
    path = Path(path)
    if path.suffix.lower() in (".tif", ".tiff"):
        return tifffile.TiffFile(path).pages[0].shape[:2]
    return Image.open(path).size[::-1]


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("outlines", help=".tif with overlay, RoiSet .zip, or QuPath .geojson")
    ap.add_argument("mask_out")
    ap.add_argument("--like", help="image giving the size (not needed for .tif)")
    a = ap.parse_args()
    shape = image_shape(a.like or a.outlines)
    m = to_mask(a.outlines, shape)
    Image.fromarray((m * 255).astype(np.uint8)).save(a.mask_out)
    print(f"{len(read_regions(a.outlines))} regions, {int(m.sum())} px -> {a.mask_out}")
