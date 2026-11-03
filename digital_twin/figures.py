"""
figures.py
TSYP 14 Track 1: Secure Ground-Link Testbed
The report's figures, drawn from the JSON the evaluation and the adaptive attacker write:
- roc_curves.png: detection rate against false-alarm rate, forest and chi-square, per attack;
- constellations.png: one frame's received QPSK constellation per traffic class (IQ receiver);
- adaptive_capture.png and adaptive_alone.png: what each tier flags as the attacker's signal
  moves away from the prediction.

Run: python -m digital_twin.figures --eval results-iq.json --attacker attacker.json
     [--out docs/figures]
Needs matplotlib (pip install matplotlib).
"""

from __future__ import annotations

import argparse
import json
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from .evaluate import ATTACKS, EVASION  # noqa: E402

SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_2 = "#52514e"
GRID = "#e4e3de"
SERIES = ("#2a78d6", "#eb6834", "#1baf7a")

LABEL = {
    "NONE": "Genuine",
    "FREQUENCY_HIJACKING": "Frequency hijack",
    "STEALTH_SPOOFING": "Stealth spoofing",
    "NOISE_JAMMING": "Noise jamming",
    "DATA_TAMPERING": "Data tampering",
    "RELAY": "Relay (meaconing)",
    "PHASE_SLIP": "Phase slip *",
    "INJECTION": "Sequence injection",
    "REPLAY": "Replay",
    "DELAY": "Delay",
    "CO_CHANNEL_CAPTURE": "Co-channel capture *",
    "JAM_BELOW_GATE_DEMO": "Jam, J/N −12.8 dB",
    "JAM_AT_STEALTH_LIMIT": "Jam, J/N −5.3 dB",
    "JAM_AT_MASK_LIMIT": "Jam, J/N −3.1 dB",
}


def _style():
    plt.rcParams.update(
        {
            "figure.facecolor": SURFACE,
            "axes.facecolor": SURFACE,
            "savefig.facecolor": SURFACE,
            "font.family": "DejaVu Sans",
            "font.size": 8.5,
            "text.color": INK,
            "axes.labelcolor": INK_2,
            "axes.edgecolor": GRID,
            "axes.linewidth": 0.8,
            "xtick.color": INK_2,
            "ytick.color": INK_2,
            "axes.grid": True,
            "grid.color": GRID,
            "grid.linewidth": 0.6,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.titlesize": 9,
            "axes.titleweight": "bold",
            "axes.titlecolor": INK,
            "legend.frameon": False,
        }
    )


FPR_GRID = [10 ** (-4 + 4 * i / 80) for i in range(81)]


def _mean_roc(results: list[dict], name: str, score: str) -> list[float]:
    """Each seed's detection rate at the same false-alarm rates (step interpolation), averaged."""
    curves = []
    for r in results:
        pts = sorted(r["counts"][name]["roc"][score])
        tprs = []
        for fpr in FPR_GRID:
            tprs.append(max((t for f, t in pts if f <= fpr), default=0.0))
        curves.append(tprs)
    return [sum(c[i] for c in curves) / len(curves) for i in range(len(FPR_GRID))]


def roc_figure(results: list[dict], path: str) -> None:
    names = [*ATTACKS, *EVASION]
    cols = 5
    rows = -(-len(names) // cols)
    fig, axes = plt.subplots(rows, cols, figsize=(10.5, 2.4 * rows + 0.6), sharex=True, sharey=True)
    for ax, name in zip(axes.flat, names, strict=False):
        for i, (score, label) in enumerate((("forest", "Isolation Forest"), ("chi", "Chi-square"))):
            ys = _mean_roc(results, name, score)
            ax.plot(
                FPR_GRID,
                ys,
                color=SERIES[i],
                lw=2,
                label=label,
                solid_capstyle="round",
            )
        auc_f = sum(r["counts"][name]["auc"]["forest"] for r in results) / len(results)
        auc_c = sum(r["counts"][name]["auc"]["chi"] for r in results) / len(results)
        ax.plot(FPR_GRID, FPR_GRID, color=GRID, lw=1, ls="--", zorder=0)
        ax.set_xscale("log")
        ax.set_title(LABEL[name], loc="left", pad=13)
        ax.text(
            0.0,
            1.025,
            f"AUC forest {auc_f:.3f} · χ² {auc_c:.3f}",
            ha="left",
            va="bottom",
            transform=ax.transAxes,
            color=INK_2,
            fontsize=7.5,
        )
        ax.set_xlim(1e-4, 1)
        ax.set_ylim(0, 1.02)
    for ax in axes.flat[len(names) :]:
        ax.set_visible(False)
    for ax in axes[-1]:
        ax.set_xlabel("false-alarm rate (log)")
    for ax in axes[:, 0]:
        ax.set_ylabel("detection rate")
    handles, labels = axes.flat[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper left", ncol=2, bbox_to_anchor=(0.01, 1.0))
    fig.text(
        0.99,
        0.995,
        "* held out: added after the gates and the rule were fixed. Tampering and injection "
        "carry no RF signature: the data tier rejects them.",
        ha="right",
        va="top",
        color=INK_2,
        fontsize=7.5,
    )
    fig.tight_layout(rect=(0, 0, 1, 0.965))
    fig.savefig(path, dpi=200)
    plt.close(fig)


def constellation_figure(result: dict, path: str) -> None:
    names = [n for n in ("NONE", *ATTACKS, *EVASION) if n in result["constellations"]]
    cols = 5
    rows = -(-len(names) // cols)
    fig, axes = plt.subplots(rows, cols, figsize=(10.5, 2.15 * rows), sharex=True, sharey=True)
    for ax, name in zip(axes.flat, names, strict=False):
        pts = result["constellations"][name]
        # Scaled to unit RMS, so every frame is drawn on the same axes whatever its power.
        rms = (sum(p[0] ** 2 + p[1] ** 2 for p in pts) / len(pts)) ** 0.5 or 1.0
        ax.scatter(
            [p[0] / rms for p in pts],
            [p[1] / rms for p in pts],
            s=3,
            color=SERIES[0],
            alpha=0.55,
            linewidths=0,
        )
        ax.set_title(LABEL[name], loc="left")
        ax.set_xlim(-1.6, 1.6)
        ax.set_ylim(-1.6, 1.6)
        ax.set_aspect("equal")
        ax.axhline(0, color=GRID, lw=0.8, zorder=0)
        ax.axvline(0, color=GRID, lw=0.8, zorder=0)
    for ax in axes.flat[len(names) :]:
        ax.set_visible(False)
    fig.text(
        0.01,
        0.995,
        "Received QPSK symbols after the phase-locked loop, one frame each "
        "(the sixth of a burst), scaled to unit RMS; the spread follows that frame's SNR",
        va="top",
        color=INK_2,
    )
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    fig.savefig(path, dpi=200)
    plt.close(fig)


def _rate_lines(ax, curve, x_key, series):
    """One line per tier with its 95 % band; labels at the line ends, pushed apart."""
    xs = [p[x_key] for p in curve]
    ends = []
    for i, (keys, label) in enumerate(series):
        keys = keys if isinstance(keys, tuple) else (keys,)
        key = keys[0]
        ys = [100 * p[key]["rate"] for p in curve]
        lo = [100 * p[key]["ci95"][0] for p in curve]
        hi = [100 * p[key]["ci95"][1] for p in curve]
        color = INK_2 if key == "decoded" else SERIES[i]
        ls = (0, (4, 3)) if key == "decoded" else "-"
        ax.fill_between(xs, lo, hi, color=color, alpha=0.12, linewidth=0)
        ax.plot(xs, ys, color=color, lw=2, ls=ls, marker="o", ms=4.5, label=label)
        ends.append([ys[-1], label])
    ends.sort()
    for j in range(1, len(ends)):
        ends[j][0] = max(ends[j][0], ends[j - 1][0] + 9)
    for y, label in ends:
        ax.annotate(
            label,
            (xs[-1], y),
            xytext=(6, 0),
            textcoords="offset points",
            va="center",
            color=INK_2,
            fontsize=7.5,
        )
    ax.axhline(5, color=INK_2, lw=0.8, ls=":", zorder=0)
    ax.set_ylim(-3, 112)
    ax.set_ylabel("% of the attacker's frames")


def _same(curve, a, b) -> bool:
    return all(p[a]["rate"] == p[b]["rate"] for p in curve)


def attacker_figures(att: dict, capture_path: str, alone_path: str) -> None:
    fig, ax = plt.subplots(figsize=(6.8, 3.4))
    cap = att["capture_curve"]
    tiers = (
        [("physical", "physical and statistical tiers flag")]
        if _same(cap, "physical", "statistical")
        else [("physical", "physical tier flags"), ("statistical", "statistical tier flags")]
    )
    _rate_lines(ax, cap, "power_db", (*tiers, ("decoded", "frames the decoder delivers")))
    ax.set_xlabel("attacker's margin over the genuine carrier, dB")
    ax.set_title("Capturing the receiver while the satellite transmits", loc="left")
    ax.set_xlim(0, max(p["power_db"] for p in cap) * 1.6)
    ax.text(
        0.01,
        -0.34,
        "No key: the data tier rejects every frame that decodes.\nBelow a 4 dB margin the genuine "
        "carrier underneath stops the decoder.",
        transform=ax.transAxes,
        color=INK_2,
        fontsize=7.5,
    )
    fig.tight_layout()
    fig.savefig(capture_path, dpi=200)
    plt.close(fig)

    fig, axes = plt.subplots(1, 3, figsize=(10.5, 3.0), sharey=True)
    for ax, (key, x, unit, title) in zip(
        axes,
        (
            ("power_curve", "power_db", "dB", "Power above the link budget"),
            ("doppler_curve", "doppler_hz", "Hz", "Carrier off the predicted Doppler"),
            ("timing_curve", "timing_us", "µs", "Arrival off the predicted light time"),
        ),
        strict=True,
    ):
        _rate_lines(ax, att[key], x, (("physical", "physical"), ("statistical", "statistical")))
        ax.set_xlabel(f"offset, {unit}")
        ax.set_title(title, loc="left")
        ax.set_xlim(0, max(p[x] for p in att[key]) * 1.35)
    for ax in axes[1:]:
        ax.set_ylabel("")
    fig.text(
        0.01,
        0.01,
        "Attacker alone on the channel, no key: the data tier rejects every "
        "frame. Dotted line: 5 %. Bands: 95 % Wilson intervals.",
        color=INK_2,
        fontsize=7.5,
    )
    fig.tight_layout(rect=(0, 0.05, 1, 1))
    fig.savefig(alone_path, dpi=200)
    plt.close(fig)


def main() -> None:
    parser = argparse.ArgumentParser(description="The report's figures.")
    parser.add_argument(
        "--eval", help="evaluate.py --json output (the IQ receiver's for the constellations)"
    )
    parser.add_argument("--attacker", help="adaptive_attacker.py --json output")
    parser.add_argument("--out", default="docs/figures")
    args = parser.parse_args()
    _style()
    os.makedirs(args.out, exist_ok=True)
    if args.eval:
        with open(args.eval) as f:
            results = json.load(f)
        roc_figure(results, os.path.join(args.out, "roc_curves.png"))
        if results[0].get("constellations"):
            constellation_figure(results[0], os.path.join(args.out, "constellations.png"))
    if args.attacker:
        with open(args.attacker) as f:
            att = json.load(f)
        attacker_figures(
            att,
            os.path.join(args.out, "adaptive_capture.png"),
            os.path.join(args.out, "adaptive_alone.png"),
        )


if __name__ == "__main__":
    main()
