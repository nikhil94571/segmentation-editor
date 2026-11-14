# Segmentation editor: correct a model's tissue masks, export to ImageJ

Tools for turning a segmentation model's output on H&E tissue images into editable regions, correcting them in a
browser editor, and exporting to ImageJ, QuPath and plain masks. Public test data only.

Setup: `python -m venv .venv && .venv/bin/pip install -r requirements.txt`
(on Windows: `py -m venv .venv` then `.venv\Scripts\pip install -r requirements.txt`, and use `.venv\Scripts\python` wherever
this page says `.venv/bin/python`).

## Hosting it (a link anyone can open)

`HOSTED=1 .venv/bin/python serve.py` runs the editor for people who only have a link:

- the link opens the editor with six practice images loaded and the tutorial open on a first visit;
- every browser gets its own private workspace (a cookie), so visitors never see each other's edits or uploads;
- Export downloads a .zip instead of writing to a folder; the folder chooser and other desktop-only parts are off;
- workspaces untouched for 14 days are deleted when the server starts. There are no accounts and no database.

With Fly.io (`fly.toml` and `Dockerfile` are in the repository; change the app name in `fly.toml` first):

```bash
fly auth login
fly launch --copy-config --no-deploy     # accept the settings, pick the app name
fly deploy                               # the link is https://<app name>.fly.dev
```

Any host that runs a Dockerfile works the same way (Render, Railway, a lab server): it listens on `$PORT`
(8080 in the container) and needs about 1 GB of memory. Data lives in `$DATA_DIR` (`/data`), which is lost
on a redeploy unless a disk is attached there; for a demo that is fine.

It is a demo server, not a secure one: there is no login, and anyone with the link can upload images. The
Open dialog says so and asks people not to upload confidential or patient images.

## Two routes, one output

A segmentation model outputs a **probability map** (0–1 per pixel), thresholded to a **mask**. The blue
"shaded" image is only a visualisation made from the mask for humans. So:

```bash
# 1. Model-output route (the real one): original image + probability map or mask
.venv/bin/python highlight2imagej.py out/ --image tissue.png --prob prob.tif      # [--threshold 0.5]
.venv/bin/python highlight2imagej.py out/ --image tissue.png --mask mask.png      # PNG/TIFF/NPY, binary or labels

# 2. Screenshot route (fallback): only a picture of the shaded result
.venv/bin/python highlight2imagej.py out/ --overlay shaded.png --image tissue.png   # any shading colour
.venv/bin/python highlight2imagej.py out/ --overlay shaded.png                      # blue shading only

# Back from the expert's edited file to a mask (retraining / measurement)
.venv/bin/python imagej2mask.py out/x_ImageJ.tif corrected_mask.png
```

Both routes write `<name>_ImageJ.tif`: the **clean tissue image with each region as an editable ImageJ shape
filled translucent blue**, so the outline *is* the shading and edits move the blue. Also written:
`_QuPath.geojson`, `_RoiSet.zip`, `_tissue.png`, `_mask.png`, `_regions.csv` (incl. mean model probability on
the model route).

Editing in ImageJ: Image › Overlay › **To** ROI Manager → click region → drag handles, or Shift-draw to add /
Alt-draw to cut → Update → Image › Overlay › **From** ROI Manager → Save. Every outline is a plain polygon with
handles; a hole is its own cyan polygon named `<region>-hole-K`. `--min-hole N` fills holes under N px.

## Segmentation editor (the custom UI)

```bash
.venv/bin/python serve.py        # then open http://127.0.0.1:8765/editor
```

An easier alternative to correcting outlines in ImageJ.

- **Libraries:** Open → Libraries. Import a folder (or a .zip of it) and each file is recognised and grouped into
  one case per image: image + probability map or mask, a shaded image, an ImageJ .tif, or an image + RoiSet. Step
  through with the previous/next buttons in the top bar (`[` and `]`); each image is saved as you leave it. Libraries
  can be renamed, deleted, or switched ("Work on this"). Six practice images (`data/practice/`, model outputs for
  images in `data/tissue_2k/`) are the built-in "Practice images" library, opened by default on a first visit.
- **Preview, done, export all:** in the library list, one click previews an image beside the dialog and a second
  click (or Enter) opens it. "Mark done" (D, at the foot of the side panel) marks the image finished. Export opens a
  menu: this image or the whole library, and the folder to save in (a Finder folder chooser; the last folder is
  remembered). You tick which file types to write, and a progress bar shows how far it has got. A library export writes
  a folder per chosen type (`masks/`, `shaded/`, `imagej/`, `roisets/`, `qupath/`) and `summary.csv`.
- **ImageJ output:** every outline is a plain polygon, so each one has draggable handles in ImageJ. A hole is its
  own unfilled cyan polygon named `<region>-hole-K` (so the hole area looks shaded in ImageJ; `imagej2mask.py`
  cuts it back out).
- **Single file:** Open → Single file takes an ImageJ .tif with its outlines inside, a shaded image **with its
  original** (required: the shading is found by comparing the two, so any colour works), an image + separate
  outlines, or model output; it joins the "Single imports" library. A library folder may still hold a lone shaded
  image, which is read only if the shading is blue.
- **Shapes:** each region is a few nodes joined by lines you bend by dragging the line itself (cubic Béziers,
  fitted with Schneider's algorithm; corners kept).
- **Edit (V):** drag a node, drag the line to bend it, drag inside a region to move all of it, double-click a line
  to add a node or a node to remove it, Delete removes the region. Clicking inside a hole selects just the hole
  (Delete removes it, dragging moves it).
- **Draw (P):** press-drag-release draws; press the open end to continue; finish on the first node to close; drag back
  along your line to un-draw; Backspace removes the last node. A shape drawn **inside** a region cuts a hole in it.
  A stroke that starts and ends on an outline **reroutes** that stretch (grows or shrinks the region, or a hole).
- **Region panel:** regions listed least-confident first (N steps through them), a **grow/shrink slider** that
  re-cuts the region from the model's probability map (even grow/shrink by distance when there is no map), delete.
  There is no accept/reject: the exported mask against the model's mask already records what was removed.
- **Also:** undo/redo, zoom/pan, fill opacity, model's original outline, probability heatmap, autosave per image.
- **Tutorial:** opens by itself on a first visit, and from the Tutorial button after that. A quick start (eight
  steps, enough to correct an image) comes first, then more tools for later. Every step has a short clip recorded
  from the real editor; see `tutorial/README.md`.
- **Exports:** mask PNG, shaded PNG, ImageJ .tif with editable regions, RoiSet .zip, QuPath .geojson
  (the ImageJ file is read back and its IoU against the mask is reported).

Files: `viewer/editor.html`, `viewer/editor/app.js` (canvas app), `viewer/editor/geom.js` (geometry, no DOM),
`editor_backend.py` (import, libraries, slider re-cut, export), `libraries/` (one folder per library), `sessions/` (one folder per opened image).
Self-test: `viewer/editor/selftest.js` drives the real page with synthetic pointer events
(`/editor?lib=practice&i=3&selftest=1`, results in `scratch/selftest.json`); last run 11 Nov: all steps passed, console clean.
The folder/zip picker itself was not exercised by the self-test (the grouping behind it was, on a mixed test folder).
Not yet tested by a person with a real mouse/trackpad.

## How it works (`highlight2imagej.py`)

1. **Mask.** Model route: threshold the probability map, or read the mask (authoritative). Screenshot route
   with the original image: the shading is wherever the two pictures differ, so its colour does not matter
   (`overlay_detect.py`). Screenshot route without it (blue shading only):
   a pixel is a candidate if its hue is blue (190–262°); a candidate region is kept only if it contains a solid
   core where **smoothed blue-minus-red > 85**. Blending towards blue raises that everywhere the shading covers,
   while stain raises it only on scattered nuclei. This works whatever the underlying tissue hue; an earlier
   hue-only core failed on deep-magenta tissue (IoU 0.20). Holes whose colour matches the shading are filled.
   The blue is then un-blended (45% towards RGB 10,80,235) to recover a clean base image.
2. **Tidy.** Drop specks < `--min-area` (200 px); fill holes < `--min-hole` (200 px).
3. **Outline.** Trace, simplify (`--tolerance 2` px, Douglas-Peucker) and write editable ImageJ polygons with a
   blue fill; regions with holes are composite shapes.

## Realistic test data

- `prepare_tissue.py`: 11 pink breast H&E images (Wikimedia Commons) matched to the real example's look and
  cropped to 2048×2048 (2 CC0 ones only exist at 1532×1532; not upscaled). Licences: `data/tissue/SOURCES.json`.
- `make_cases.py`, per tile: `expert.png` (ground truth); `prob.tif`, a float32 **probability map** like a
  segmentation head's output (soft edges, ~0.95 inside, a lower-confidence false positive, sub-threshold
  "maybe" areas, noise); `mask.png` = prob ≥ 0.5; `overlay.png` = mask rendered in blue (the "screenshot").
  The model is deliberately imperfect: **model vs expert Dice 0.83** (a realistic "about 80% right" model). Every third tile also has a
  **grid** variant (mean probability per 100 px cell).

## QA viewer

`run_all.py` runs every case through **both routes** (31 entries incl. the real example), then
`serve.py` → http://127.0.0.1:8765. Left: the route's actual input (probability heatmap or screenshot).
Right: outlines with handles · ImageJ mask · conversion check (vs the model's mask) · vs expert.
Approve/Decline + comment → `qa/decisions.json`.

## Results (11 Nov 2026; measured on regions read back from the saved .tif)

| Check | Result |
|---|---|
| Model-output route: regions vs model mask (IoU) | mean **0.984**, min 0.954 (grid cases exact) |
| Screenshot route: regions vs model mask (IoU) | mean **0.975**, min 0.870 (bluish-stain slide) |
| Exact mode (`--tolerance 0`) stress test, 507 masks | **507/507 pixel-exact** |
| .tif overlay vs RoiSet vs QuPath GeoJSON | identical masks |
| Regions with holes (no handles) at `--min-hole` 200 / 1000 / 2000 | 20 / 11 / 4 of 46 (IoU cost ≈ 0 / 1% / 2%) |
| Real ImageJ (by hand) | single .tif opens with outlines; editing worked; the earlier baked-in blue did not move (fixed) |

Known limit (screenshot route only): on a bluish-stained slide, a cluster of bluish nuclei touching or near the
shading can be included. The model route has no such issue.

## Shading colour, and Windows

- **Any colour needs the original image.** `tests_overlay.py` re-shades the 11 tissue images in ten colours at three
  opacities and compares shaded against original: mean IoU 0.985 (0.999 for every colour except faint pink, purple
  and white, where tissue of nearly the overlay's own colour barely changes). Both pictures JPEG-compressed, or a
  soft-edged overlay: 0.93 to 0.97. In a library, name the pair `x_image.png` + `x_overlay.png` (or `_shaded`).
- **Without the original, only blue shading is found.** A colour-free detector (the overlay's edge as one consistent
  colour step) was tried on 11-13 Nov and dropped: it worked on crisp synthetic overlays, but not on compressed or
  resized pictures or the real example, and needed thresholds tuned to these images.
- **Windows and Linux:** the folder chooser uses the system dialog (PowerShell on Windows, zenity or kdialog on Linux),
  the export folder can also be typed, "Show folder" opens the file manager, and shortcuts read Ctrl instead of ⌘
  (Ctrl+Y also redoes). Checked in a browser pretending to be Windows; not yet run on a real Windows machine.
  The tutorial clips were recorded on a Mac, so their key badges show ⌘.

## Still to confirm

- In Fiji: the filled shapes follow edits (To ROI Manager → edit → Update → From ROI Manager → save → `imagej2mask.py`).
- QuPath import of the GeoJSON.

## Data and licences

`data/tissue_2k/` holds 11 H&E images from Wikimedia Commons, cropped to squares. Authors, source pages and
licences (CC0, CC BY-SA 3.0, CC BY-SA 4.0) are listed in `data/tissue_2k/SOURCES.json`; the crops are shared under
the same licences. Everything else under `data/`, `out/`, `sessions/` and `libraries/` is generated locally
(`make_cases.py`, `run_all.py`, the editor) and is not in the repository.
