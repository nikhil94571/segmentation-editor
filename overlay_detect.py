"""Find shading of any colour by comparing the shaded picture with the original image.

A shaded pixel is the tissue underneath mixed with one overlay colour:

    shaded = g * tissue + s          g = 1 - opacity,  s = opacity * overlay colour

With the original image to hand there is nothing to guess: the shading is wherever the two pictures
differ, and g and s (so the overlay's colour and opacity) follow from a straight-line fit of shaded
against original. No colour is assumed.

Without the original, highlight2imagej.highlight_mask() looks for blue shading only. A colour-free
version of that was tried (11-13 Nov 2026: the overlay's edge as one consistent colour step) and not kept:
it worked on crisp synthetic overlays but not on compressed or resized pictures or the real example,
because a real model's overlay edge follows a tissue edge, so the tissue is not the same on both sides.
"""
import numpy as np
from scipy import ndimage as ndi


def pair_mask(shaded, original, thresh=12):
    """-> (mask, blend). blend = dict(g, s, alpha, colour), or None if the pictures barely differ."""
    a, b = shaded[..., :3].astype(np.float32), original[..., :3].astype(np.float32)
    diff = ndi.median_filter(np.abs(a - b).max(-1), 3)          # ignores single-pixel compression noise
    mask = diff > thresh
    if mask.sum() < 50:
        return mask, None
    x, y = b[mask], a[mask]
    dx, dy = x - x.mean(0), y - y.mean(0)
    g = float(np.clip((dx * dy).sum() / max((dx ** 2).sum(), 1e-6), 0.03, 0.97))
    s = y.mean(0) - g * x.mean(0)
    # tissue that already has the overlay's colour does not change, so it leaves pin-holes: close them
    mask = ndi.binary_closing(mask, np.ones((3, 3), bool)) | mask
    return mask, {"g": g, "s": s.astype(float), "alpha": 1 - g, "colour": np.clip(s / (1 - g), 0, 255)}
