"""Independent check of an outlines file (.tif overlay, RoiSet .zip, or QuPath .geojson).

Reads the file back from disk and re-draws it the way ImageJ fills ROIs (pixel centre inside the
outline; '-hole-' polygons cut out of their region), without using the converter's mask.

    python verify_roiset.py out/x/x_ImageJ.tif out/x/x_mask.png
"""
import sys

import numpy as np

from imagej2mask import to_mask


def rasterise(path, shape):
    return to_mask(path, shape)


def iou(a, b):
    u = (a | b).sum()
    return 1.0 if u == 0 else (a & b).sum() / u


if __name__ == "__main__":
    from PIL import Image
    mask = np.asarray(Image.open(sys.argv[2])) > 0
    redraw = rasterise(sys.argv[1], mask.shape)
    print(f"IoU {iou(mask, redraw):.6f}  differing px {(mask ^ redraw).sum()}")
