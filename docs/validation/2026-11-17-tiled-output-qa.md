# Validation: tiled model output, 17 Nov 2026

**Status: QA pass.** Reviewed by hand, image by image, on the comparison page (`/compare`), and passed.

| | |
|---|---|
| Code that was reviewed | commit `47130ea` (git tag `segmentation-qa-pass-2026-11-17`), branch `v2-dev` |
| Segmentation code since | unchanged as of `2907c87` (`coarse.py`, `viewer/editor/geom.js` and the import in `editor_backend.py` identical) |
| Automated checks | `dev/check_coarse.py`: 47 of 47 pass; editor self-test: 56 results, no errors, console clean |
| Environment | Python 3.12.13, numpy 2.5.4, scipy 1.18.1, scikit-image 0.26.0, Pillow 13.0.0, tifffile 2026.11.8, shapely 2.2.0; Node 26.7.0 |

## What was validated

How the editor turns a model's tiled output (one answer per 16 x 16 px tile) into editable outlines:

1. **Reading the output by content** (`editor_backend.scan_bundle`): the model's raw `.npz` is preferred, then a
   probability map, then a mask, then ImageJ outlines that look traced. Hand-drawn outlines in the folder (a
   reference) are never used as the model's output. Shown: outlines are byte-identical with or without the
   reference file in the folder.
2. **Smoothing** (`coarse.py`): tiles stretched evenly over the image (tile j covers pixels [j*W/w, (j+1)*W/w));
   each tile's value placed at its centre; logits interpolated with a cubic spline; cut at the model's own threshold
   (from the `.npz`; default 0.675). No blur.
3. **Keeping the model's answers** (`coarse.respect_tiles`): at every tile centre the outline gives the model's own
   yes or no (all 19,712 on the checked image). Gaps and notches narrower than 0.6 tile are closed and specks the
   smoothing makes between tiles removed, but never against the model; one-tile regions and holes are kept,
   0.45 tile in radius at least.
4. **Fitting curves** (`G.fitSmoothClosed`): a first fit, then nodes removed one at a time (least error first)
   while the bent segment that replaces two stays within a third of a tile (5.33 px); sharp corners kept as one
   node; stretches along the image's edge straight, with one node at an image corner. No outline leaves the image.

## The test images

Eleven synthetic folders made by `dev/make_coarse_cases.py` in the same format as a real tiled pipeline's output
(2048 x 2467 image, 128 x 154 tiles, cut-off 0.675, raw `.npz`, mask TIF, ImageJ TIF, pictures, and a 7040 x 5842
original holding hand-drawn reference outlines). Tissue from `data/tissue_2k/`; targets are the simulated expert
masks from `make_cases.py`. Regenerating gives byte-identical files (checked):

```bash
.venv/bin/python make_cases.py                  # the simulated expert masks, if data/cases/ is missing
.venv/bin/python dev/make_coarse_cases.py       # -> data/synthetic/
.venv/bin/python dev/compare.py                 # -> the comparison page's data (outside the repository)
```

| Folder | `.npz` sha256 (first 16) | Nodes, old import -> now | Area change | Overlap with reference, before -> after | Furthest move (px) |
|---|---|---|---|---|---|
| S01-fibrocystic-low | 5800de8524ed33ed | 190 -> 57 | -2.03% | 0.838 -> 0.866 | 12 |
| S02-fibrocystic-mid | 9785b225579e1f7d | 189 -> 42 | -1.39% | 0.869 -> 0.900 | 8 |
| S03-gynecomastoid-low | cc6ce4d92b41e499 | 388 -> 91 | -0.37% | 0.897 -> 0.905 | 8 |
| S04-gynecomastoid-mid | 6551a5af58dc33ba | 181 -> 49 | -0.37% | 0.894 -> 0.928 | 9 |
| S05-idc-mid | ea6f140eddddc7ff | 218 -> 55 | -1.18% | 0.895 -> 0.927 | 17 |
| S06-pash-low | e9fbde29076a8579 | 218 -> 42 | -1.45% | 0.931 -> 0.952 | 8 |
| S07-prolif-fibrocystic-low | 1478e886a7700752 | 118 -> 33 | -0.59% | 0.936 -> 0.944 | 8 |
| S08-prolif-fibrocystic-mid | 8ff7ce302f3ef39e | 411 -> 103 | -0.89% | 0.864 -> 0.886 | 9.9 |
| S09-sclerosing-adenosis-2 | a642bb8cc359a093 | 239 -> 70 | -1.78% | 0.892 -> 0.907 | 19.4 |
| S10-sclerosing-adenosis-low | 330f2f4c74d4900f | 158 -> 36 | -0.40% | 0.896 -> 0.923 | 9 |
| S11-sclerosing-adenosis-mid | bd098ad9e0f7e0bd | 266 -> 55 | -0.77% | 0.908 -> 0.939 | 8 |
| **Total** | | **2,576 -> 633** | | rose in all 11 | |

One further image, a real model output, was reviewed the same way and passed; it is not in the repository.

## Tried and dropped

- Blurring the tile values before smoothing: fewer nodes, but thin structures shrank and overlap with the reference
  fell (0.895 -> 0.826 at one tile of blur).
- Dropping blobs under two tiles and filling sub-tile holes: removed marks the model made. Replaced by keeping the
  model's answer at every tile centre.

## To go back to this version

```bash
git checkout segmentation-qa-pass-2026-11-17     # the code as reviewed
```
