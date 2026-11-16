"""The correction -> retraining loop, measured.

A first model is trained on 8 regions. Then, round by round, 8 more regions are "corrected" and added, and the
model is fine-tuned on everything corrected so far. The expert's corrections are stood in for by the BCSS expert
outlines (as in published human-in-the-loop studies that simulate the expert); `retrain.py` takes real corrections
from the editor instead.

Two ways of choosing which regions the expert corrects next are compared:
  least-confident: the regions the current model is least sure about (as the editor's list does), and
  random: any regions.
Every model is scored on the same 12 test regions it never trains on.

  .venv-ml/bin/python ml/loop.py            # about an hour on an Apple M-series Mac; resumes if stopped
Writes models/loop/*.pt and docs/retraining/results.json."""
import argparse
import copy
import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

OUT = C.ROOT / "docs" / "retraining" / "results.json"
MODELS = C.ROOT / "models" / "loop"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def score(model, items):
    return [C.dice(C.predict(model, rgb), y) for rgb, y in items]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--per-round", type=int, default=8)
    ap.add_argument("--base-steps", type=int, default=600)
    ap.add_argument("--round-steps", type=int, default=300)
    ap.add_argument("--seeds", type=int, nargs="+", default=[0, 1])
    a = ap.parse_args()

    sp = C.splits()
    test = [C.load_roi(n) for n in sp["test"]]
    init = [C.load_roi(n) for n in sp["initial"]]
    pool = {n: C.load_roi(n) for n in sp["pool"]}
    res = C.json.loads(OUT.read_text()) if OUT.exists() else {"splits": sp, "settings": vars(a), "runs": {}}

    # ---- the first model: 8 regions ----
    base_path = MODELS / "v1-base.pt"
    if base_path.exists():
        base, _ = C.load(base_path)
    else:
        log("training the first model on", len(init), "regions")
        C.seed_all(0)
        base = C.train(C.build(), init, a.base_steps, lr=3e-4, seed=0, log=log)
        C.save(base, base_path, {"trained_on": sp["initial"], "steps": a.base_steps})
    if "base" not in res:
        d = score(base, test)
        res["base"] = {"test_dice": d, "mean": float(np.mean(d))}
        C.write_json(OUT, res)
    log("first model: test Dice", round(res["base"]["mean"], 4))

    # ---- the loop ----
    for strategy in ("least-confident", "random"):
        for seed in a.seeds:
            key = f"{strategy}/{seed}"
            run = res["runs"].setdefault(key, {"rounds": []})
            model = copy.deepcopy(base)
            corrected = []
            for k, rd in enumerate(run["rounds"]):                 # resume: replay what is already done
                corrected += rd["chosen"]
            if run["rounds"]:
                model, _ = C.load(MODELS / f"{strategy}-s{seed}-r{len(run['rounds'])}.pt")
            for k in range(len(run["rounds"]), a.rounds):
                left = [n for n in sp["pool"] if n not in corrected]
                if strategy == "least-confident":
                    preds = {n: C.predict(model, pool[n][0]) for n in left}
                    left.sort(key=lambda n: -C.uncertainty(preds[n]))
                    chosen = left[:a.per_round]
                else:
                    rng = np.random.default_rng(1000 * seed + k)
                    chosen = list(rng.choice(left, a.per_round, replace=False))
                    preds = {n: C.predict(model, pool[n][0]) for n in chosen}
                # how much the expert had to change: share of annotated pixels the model got wrong, and Dice
                wrong = [float(((preds[n] >= .5) != (pool[n][1] == 1))[pool[n][1] != C.IGNORE].mean()) for n in chosen]
                before = [C.dice(preds[n], pool[n][1]) for n in chosen]
                corrected += chosen
                log(f"{key} round {k + 1}: correcting {len(chosen)} regions (model was wrong on {np.mean(wrong):.1%} of their pixels)")
                C.seed_all(100 + 10 * seed + k)
                model = C.train(model, init + [pool[n] for n in corrected], a.round_steps, lr=1e-4, seed=100 + 10 * seed + k, log=None)
                d = score(model, test)
                C.save(model, MODELS / f"{strategy}-s{seed}-r{k + 1}.pt", {"trained_on": sp["initial"] + corrected, "round": k + 1})
                run["rounds"].append({"chosen": chosen, "corrected_total": len(corrected), "wrong_px_before": wrong,
                                      "dice_before_on_chosen": before, "test_dice": d, "mean": float(np.mean(d))})
                C.write_json(OUT, res)
                log(f"{key} round {k + 1}: test Dice {np.mean(d):.4f}")

    # ---- reference: everything corrected at once, trained from scratch ----
    if "all" not in res:
        log("reference: training on all", len(init) + len(pool), "regions")
        C.seed_all(0)
        ref = C.train(C.build(), init + list(pool.values()), a.base_steps + a.rounds * a.round_steps, lr=3e-4, seed=0, log=log)
        C.save(ref, MODELS / "all-regions.pt", {"trained_on": sp["initial"] + sp["pool"]})
        d = score(ref, test)
        res["all"] = {"test_dice": d, "mean": float(np.mean(d))}
        C.write_json(OUT, res)
    log("done:", OUT)


if __name__ == "__main__":
    torch.set_num_threads(4)
    main()
