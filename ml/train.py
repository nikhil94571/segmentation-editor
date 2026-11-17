"""Train the model behind the practice images: a U-Net on 8 BCSS regions, scored on 12 regions it never sees.

  .venv-ml/bin/python ml/train.py            # a few minutes on an Apple M-series Mac -> models/base.pt
  .venv-ml/bin/python ml/predict.py --practice

Retraining from experts' corrections is not done here yet: the editor exports the corrections as training data
(Export -> Training data), in a layout any training pipeline can read."""
import argparse
import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=600)
    ap.add_argument("--out", default=str(C.ROOT / "models" / "base.pt"))
    a = ap.parse_args()
    sp = C.splits()
    init = [C.load_roi(n) for n in sp["initial"]]
    log("training on", len(init), "regions")
    C.seed_all(0)
    model = C.train(C.build(), init, a.steps, lr=3e-4, seed=0, log=log)
    C.save(model, a.out, {"trained_on": sp["initial"], "steps": a.steps})
    d = [C.dice(C.predict(model, rgb), y) for rgb, y in (C.load_roi(n) for n in sp["test"])]
    log(f"test Dice on {len(d)} unseen regions: {np.mean(d):.4f}")
    log("model:", a.out)


if __name__ == "__main__":
    torch.set_num_threads(4)
    main()
