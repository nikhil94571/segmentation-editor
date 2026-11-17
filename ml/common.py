"""Shared pieces of the model work: data loading, the network, training, prediction and scoring.

The task is binary: tumour (BCSS codes 1 tumor, 19 angioinvasion, 20 dcis) against all other tissue.
BCSS code 0 means "outside the annotated region" and is ignored in training and scoring.
The network sees tissue at MODEL_MPP micrometres per pixel (BCSS is scanned at 0.25)."""
import json
import random
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parent.parent
BCSS = ROOT / "data" / "bcss"
SRC_MPP = 0.25
MODEL_MPP = 1.0
TUMOUR = (1, 19, 20)
IGNORE = 255
TILE = 384


def device():
    return torch.device("mps" if torch.backends.mps.is_available() else "cpu")


def seed_all(seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


# ---------------- data ----------------

def _down(img, factor, resample):
    w, h = img.size
    return img.resize((max(1, round(w / factor)), max(1, round(h / factor))), resample)


def load_roi(name, mpp=MODEL_MPP):
    """One BCSS region at `mpp`: (rgb uint8 HxWx3, target uint8 HxW with 1 tumour, 0 other, 255 ignore).
    Cached under data/bcss/cache/."""
    cache = BCSS / "cache" / f"{Path(name).stem}@{mpp}.npz"
    if cache.exists():
        z = np.load(cache)
        return z["rgb"], z["y"]
    f = mpp / SRC_MPP
    src = BCSS / "rgbs_colorNormalized" / name                    # as ml/fetch_bcss.py saves it
    rgb = _down(Image.open(src if src.exists() else BCSS / "rgb" / name).convert("RGB"), f, Image.Resampling.LANCZOS)
    m = Image.open(BCSS / "masks" / name)
    m = _down(m, f, Image.Resampling.NEAREST).resize(rgb.size, Image.Resampling.NEAREST)
    m = np.asarray(m)
    y = np.where(np.isin(m, TUMOUR), 1, 0).astype(np.uint8)
    y[m == 0] = IGNORE
    rgb = np.asarray(rgb)
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache, rgb=rgb, y=y)
    return rgb, y


def splits(seed=7):
    """Fixed split of the 64 downloaded regions (each from a different patient, checked below): 12 test, 8 to train
    the first model, and 44 not used yet."""
    names = [n for n in (ROOT / "ml" / "bcss_picked.txt").read_text().split() if n]
    names = sorted(names)
    assert len({n[:12] for n in names}) == len(names), "two regions from one patient: the split would leak"
    random.Random(seed).shuffle(names)
    return {"test": names[:12], "initial": names[12:20], "pool": names[20:]}


# ---------------- model ----------------

def build(pretrained=True):
    import segmentation_models_pytorch as smp
    return smp.Unet("resnet34", encoder_weights="imagenet" if pretrained else None, classes=1)


MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def to_tensor(rgb):
    x = (rgb.astype(np.float32) / 255 - MEAN) / STD
    return torch.from_numpy(x.transpose(2, 0, 1).copy())


def save(model, path, meta):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state": model.state_dict(), "meta": dict(meta, mpp=MODEL_MPP, task="tumour vs other (BCSS 1,19,20)")}, path)


def load(path):
    ck = torch.load(path, map_location="cpu", weights_only=False)
    m = build(pretrained=False)
    m.load_state_dict(ck["state"])
    return m, ck["meta"]


# ---------------- training ----------------

def _crop(rgb, y, rng):
    H, W = y.shape
    if H < TILE or W < TILE:                                     # pad small regions with "ignore"
        ph, pw = max(0, TILE - H), max(0, TILE - W)
        rgb = np.pad(rgb, ((0, ph), (0, pw), (0, 0)), mode="reflect")
        y = np.pad(y, ((0, ph), (0, pw)), constant_values=IGNORE)
        H, W = y.shape
    for _ in range(10):                                          # avoid crops that are almost all "ignore"
        r, c = rng.integers(0, H - TILE + 1), rng.integers(0, W - TILE + 1)
        yy = y[r:r + TILE, c:c + TILE]
        if (yy != IGNORE).mean() > 0.3:
            break
    x, yy = rgb[r:r + TILE, c:c + TILE], yy
    k = rng.integers(0, 4)
    x, yy = np.rot90(x, k), np.rot90(yy, k)
    if rng.random() < 0.5:
        x, yy = x[:, ::-1], yy[:, ::-1]
    x = x.astype(np.float32)                                     # mild stain and brightness jitter
    x = np.clip(x * rng.uniform(0.9, 1.1, 3) + rng.uniform(-12, 12), 0, 255).astype(np.uint8)
    return x, yy


def loss_fn(logits, y):
    valid = (y != IGNORE).float()
    t = (y == 1).float()
    bce = (F.binary_cross_entropy_with_logits(logits, t, reduction="none") * valid).sum() / valid.sum().clamp(min=1)
    p = torch.sigmoid(logits) * valid
    dice = 1 - (2 * (p * t).sum() + 1) / (p.sum() + (t * valid).sum() + 1)
    return bce + dice


def train(model, data, steps, lr=3e-4, batch=8, seed=0, log=None):
    """data: list of (rgb, y). Random crops, AdamW, cosine schedule."""
    dev = device()
    model.to(dev).train()
    rng = np.random.default_rng(seed)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps, pct_start=0.1)
    t0 = time.time()
    for s in range(steps):
        xs, ys = zip(*(_crop(*data[rng.integers(len(data))], rng) for _ in range(batch)))
        x = torch.stack([to_tensor(np.ascontiguousarray(v)) for v in xs]).to(dev)
        y = torch.from_numpy(np.stack([np.ascontiguousarray(v) for v in ys]).astype(np.int64)).to(dev)
        loss = loss_fn(model(x)[:, 0], y)
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        if log and (s + 1) % 100 == 0:
            log(f"  step {s + 1}/{steps} loss {loss.item():.3f} ({time.time() - t0:.0f}s)")
    model.eval()
    return model


# ---------------- prediction and scoring ----------------

@torch.no_grad()
def predict(model, rgb, tile=512, overlap=96):
    """Tumour probability for every pixel, by overlapping tiles blended with a soft window."""
    dev = device()
    model.to(dev).eval()
    H, W = rgb.shape[:2]
    ph, pw = max(0, tile - H), max(0, tile - W)
    img = np.pad(rgb, ((0, ph), (0, pw), (0, 0)), mode="reflect") if ph or pw else rgb
    Hp, Wp = img.shape[:2]
    step = tile - overlap
    ys = list(range(0, max(Hp - tile, 0) + 1, step)) + ([Hp - tile] if (Hp - tile) % step else [])
    xs = list(range(0, max(Wp - tile, 0) + 1, step)) + ([Wp - tile] if (Wp - tile) % step else [])
    w1 = np.minimum(np.arange(tile) + 1, np.arange(tile)[::-1] + 1).astype(np.float32)
    win = np.minimum(np.minimum.outer(w1, w1), overlap) / overlap        # fades out towards every tile edge
    acc = np.zeros((Hp, Wp), np.float32)
    wsum = np.zeros((Hp, Wp), np.float32)
    for r in sorted(set(ys)):
        for c in sorted(set(xs)):
            x = to_tensor(np.ascontiguousarray(img[r:r + tile, c:c + tile]))[None].to(dev)
            p = (torch.sigmoid(model(x)) + torch.sigmoid(model(x.flip(3))).flip(3))[0, 0].cpu().numpy() / 2   # + mirror
            acc[r:r + tile, c:c + tile] += p * win
            wsum[r:r + tile, c:c + tile] += win
    return (acc / np.maximum(wsum, 1e-6))[:H, :W]


def dice(prob, y, t=0.5):
    """Dice of the thresholded prediction against the target, over annotated pixels only."""
    v = y != IGNORE
    p, g = (prob >= t) & v, (y == 1) & v
    s = p.sum() + g.sum()
    return 1.0 if s == 0 else float(2 * (p & g).sum() / s)


def uncertainty(prob, y=None):
    """How unsure the model is about a region: mean of 4p(1-p) over annotated (or all) pixels."""
    u = 4 * prob * (1 - prob)
    return float(u[y != IGNORE].mean()) if y is not None else float(u.mean())


def write_json(path, obj):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(obj, indent=1))
