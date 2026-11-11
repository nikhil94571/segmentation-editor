"""Round-trip stress test (exact mode, --tolerance 0): mask -> RoiSet.zip -> re-drawn with ImageJ fill rule -> must match exactly."""
import os, sys, tempfile
import numpy as np
from roifile import roiwrite
from highlight2imagej import region_rois
from verify_roiset import rasterise

rng = np.random.default_rng(0)
tests = {}
m = np.zeros((60, 60), bool); m[5:40, 5:40] = 1; m[12:30, 12:30] = 0; m[18:24, 18:24] = 1; m[15, 33] = 0; tests["nested holes + 1px hole"] = m
m = np.zeros((30, 30), bool); m[5, 5] = m[6, 6] = m[7, 7] = 1; m[10:20, 10:20] = 1; m[20, 20] = 1; tests["diagonal touches"] = m
m = np.zeros((30, 30), bool); m[0:10, :] = 1; m[:, 0] = 1; tests["touching image edges"] = m
m = np.zeros((30, 30), bool); m[5, 2:28] = 1; m[2:28, 15] = 1; tests["1px strands"] = m
m = np.zeros((20, 20), bool); m[5:15, 5:15] = 1; m[9, 9] = 0; m[10, 10] = 0; tests["diagonal hole pixels"] = m
tests["empty"] = np.zeros((10, 10), bool)
tests["full"] = np.ones((10, 10), bool)
for k in range(500):
    tests[f"noise{k}"] = rng.random((40, 40)) < rng.uniform(0.2, 0.8)

fails = 0
path = os.path.join(tempfile.mkdtemp(), "t.zip")
for name, m in tests.items():
    rois, _ = region_rois(m, tolerance=0)
    if os.path.exists(path): os.remove(path)
    redraw = np.zeros(m.shape, bool)
    if rois:
        roiwrite(path, rois); redraw = rasterise(path, m.shape)
    if (redraw ^ m).any():
        fails += 1; print("FAIL", name, int((redraw ^ m).sum()), "px")
print(f"{len(tests)} cases, {fails} failures")
sys.exit(1 if fails else 0)
