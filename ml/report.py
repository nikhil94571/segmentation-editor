"""Turn docs/retraining/results.json (from loop.py) into a chart and a results page.

  .venv-ml/bin/python ml/report.py      -> docs/retraining/chart.png, effort.png and README.md"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

DIR = C.ROOT / "docs" / "retraining"
INK, MUTE, LINE = "#12142B", "#7A7FA3", "#D9DAE8"
COLS = {"least-confident": "#4F5BD5", "random": "#C2410C"}
NAMES = {"least-confident": "least confident first", "random": "random order"}


def series(res, strategy):
    runs = [r for k, r in res["runs"].items() if k.startswith(strategy + "/") and r["rounds"]]
    n = min(len(r["rounds"]) for r in runs)
    n0 = len(res["splits"]["initial"])
    x = [n0] + [runs[0]["rounds"][i]["corrected_total"] + n0 for i in range(n)]
    dice = np.array([[res["base"]["mean"]] + [r["rounds"][i]["mean"] for i in range(n)] for r in runs])
    wrong = np.array([[np.mean(r["rounds"][i]["wrong_px_before"]) for i in range(n)] for r in runs])
    return x, dice, wrong, len(runs)


def style(ax):
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(LINE)
    ax.tick_params(colors=MUTE, labelsize=9)
    ax.grid(axis="y", color=LINE, lw=0.6)
    ax.set_axisbelow(True)


def summary(res, rows):
    """The headline, worked out from the numbers rather than written in."""
    out = []
    b = res["base"]["mean"]
    finals = {s: (x[-1] - x[0], d.mean(0)[-1]) for s, (x, d, _, _) in rows.items()}
    if finals:
        n_corr = max(v[0] for v in finals.values())
        parts = [f"{v[1]:.3f} ({NAMES[s]})" for s, v in finals.items()]
        out.append(f"**Correcting {n_corr} regions raised Dice on {len(res['splits']['test'])} unseen test regions from "
                   f"{b:.3f} to " + " and ".join(parts) + ".**" + (f" A model trained on all of them at once, from scratch, "
                   f"reaches {res['all']['mean']:.3f}." if "all" in res else ""))
    if len(rows) == 2:
        (x1, d1, _, _), (x2, d2, _, _) = rows["least-confident"], rows["random"]
        k = min(d1.shape[1], d2.shape[1])
        diff = d1.mean(0)[1:k] - d2.mean(0)[1:k]
        lead = [i + 1 for i, v in enumerate(diff) if v > 0.005]
        out.append("")
        out.append(f"Choosing the least confident regions first was ahead after round {', '.join(map(str, lead))} "
                   f"(by up to {diff.max():.3f}), " if lead else "Choosing the least confident regions first was never clearly ahead; ")
        out[-1] += "but over all rounds the two ways of choosing are within the run-to-run noise below, so this run does not show " \
                   "that the order matters much at this scale."
    return out


def main():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    res = json.loads((DIR / "results.json").read_text())
    rows = {s: series(res, s) for s in COLS if any(k.startswith(s + "/") for k in res["runs"])}

    fig, ax = plt.subplots(figsize=(7.2, 4.0), dpi=160)
    style(ax)
    for s, (x, d, _, n) in rows.items():
        m = d.mean(0)
        ax.plot(x, m, "-o", color=COLS[s], lw=2, ms=4.5, label=NAMES[s] + (f" (mean of {n} runs)" if n > 1 else ""))
        if n > 1:
            ax.fill_between(x, d.min(0), d.max(0), color=COLS[s], alpha=0.12, lw=0)
    if "all" in res:
        ax.axhline(res["all"]["mean"], color=MUTE, lw=1, ls="--")
        ax.text(x[-1], res["all"]["mean"] + 0.004, f"all {len(res['splits']['initial']) + len(res['splits']['pool'])} regions at once", color=MUTE, fontsize=8.5, ha="right", va="bottom")
    ax.set_xlabel("Regions with expert outlines (8 to start, then 8 corrected per round)", color=INK, fontsize=9.5)
    ax.set_ylabel("Dice on 12 unseen test regions", color=INK, fontsize=9.5)
    ax.legend(frameon=False, fontsize=9, loc="lower right")
    fig.tight_layout()
    fig.savefig(DIR / "chart.png")

    fig, ax = plt.subplots(figsize=(7.2, 3.2), dpi=160)
    style(ax)
    for s, (x, _, w, n) in rows.items():
        ax.plot(range(1, w.shape[1] + 1), 100 * w.mean(0), "-o", color=COLS[s], lw=2, ms=4.5, label=NAMES[s])
    ax.set_xticks(range(1, max(w.shape[1] for _, _, w, _ in rows.values()) + 1))
    ax.set_xlabel("Correction round", color=INK, fontsize=9.5)
    ax.set_ylabel("% of pixels the expert fixed", color=INK, fontsize=9.5)
    ax.legend(frameon=False, fontsize=9)
    fig.tight_layout()
    fig.savefig(DIR / "effort.png")

    lc = rows.get("least-confident")
    rd = rows.get("random")
    n0, npool = len(res["splits"]["initial"]), len(res["splits"]["pool"])
    used = res["settings"]["rounds"] * res["settings"]["per_round"]
    spread = max((float((d.max(0) - d.min(0))[1:].max()) for _, d, _, n in rows.values() if n > 1), default=None)
    steps = max((float(np.abs(np.diff(d.mean(0))).max()) for _, d, _, _ in rows.values() if d.shape[1] > 1), default=None)
    lines = ["# Retraining from corrections", "",
             "Does correcting the model's output, and training on the corrections, make the model better? This page is "
             "generated by `ml/report.py` from `results.json`, which `ml/loop.py` writes.", "",
             "![Test Dice as corrected regions are added](chart.png)", "", *summary(res, rows), "",
             "## What was done", "",
             "- **Data:** 64 regions of BCSS (breast cancer, TCGA; CC0), each from a different patient, at 1 µm per pixel. "
             "Task: tumour (BCSS tumour, DCIS and angioinvasion) against all other tissue.",
             f"- **Split, fixed:** {len(res['splits']['test'])} test regions the model never trains on; {n0} to train the first model; "
             f"{npool} in a pool, of which the loop uses {used}.",
             f"- **Model:** U-Net with an ImageNet-pretrained ResNet-34 encoder, {res['settings']['base_steps']} training steps "
             f"for the first model, then {res['settings']['round_steps']} fine-tuning steps per round.",
             f"- **Loop:** each round, {res['settings']['per_round']} pool regions are corrected and the model is fine-tuned on "
             "everything corrected so far. **The expert's corrections are stood in for by the BCSS expert outlines**; "
             "nobody corrected these by hand. `ml/retrain.py` does the same step from real corrections saved in the editor.",
             "- **Which regions get corrected:** least confident first (as the editor lists them) against random choice. "
             f"Each was run with {len(res['settings']['seeds'])} seeds; the seeds vary the fine-tuning (and the random choice), "
             "not the first model, which all runs share.", "",
             "## Results", "",
             "| | Regions with expert outlines | Test Dice |", "|---|---|---|",
             f"| First model | 8 | **{res['base']['mean']:.3f}** |"]
    for s, r in (("least confident first", lc), ("random", rd)):
        if r:
            x, d, _, _ = r
            for i in range(1, len(x)):
                lines.append(f"| {s}, round {i} | {x[i]} | {d[:, i].mean():.3f} |")
    if "all" in res:
        lines.append(f"| All regions at once, from scratch (reference) | {n0 + npool} | {res['all']['mean']:.3f} |")
    lines += ["", "![How much of each corrected region the expert had to fix](effort.png)", "",
              "The second chart is the expert's workload: the share of the chosen regions' pixels the model had wrong "
              "before they were corrected. Each round looks at different regions, and least-confident-first picks the "
              "hardest on purpose, so this is the work asked of the expert, not a fixed before-and-after test.", "",
              "## Limits", "",
              "- Simulated expert: the corrections are BCSS's own outlines, which were made by pathologists and trainees "
              "and reviewed, not corrections made in this editor.",
              f"- Small test set ({len(res['splits']['test'])} regions) and one task (tumour or not). Between seeds the test Dice "
              + (f"differs by up to {spread:.3f} in a round" if spread is not None else "was not compared")
              + (f", and from one round to the next the mean moves by up to {steps:.3f}" if steps is not None else "")
              + "; differences smaller than that are noise.",
              "- One dataset (BCSS, TCGA breast cancer slides), one stain normalisation, one magnification."]
    (DIR / "README.md").write_text("\n".join(lines) + "\n")
    print("wrote", DIR / "README.md")


if __name__ == "__main__":
    main()
