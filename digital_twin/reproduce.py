"""
reproduce.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Every table and figure of the report from one command: `make eval` (or python -m
digital_twin.reproduce).

It runs, in parallel over the machine's cores:
- the seeded evaluation, seeds 1 to 6, with the measurement-model receiver;
- the same with the sample-level (IQ) receiver;
- the adaptive attacker, seed 1;
then draws the figures and writes results/tables.md: every number the report quotes, in a
canonical form (counts, rates and areas rounded; no timings, no memory figures), and its
SHA-256. With the pinned environment (requirements-lock.txt) the hash matches
results/EXPECTED_SHA256, which says the run reproduced the report exactly.

--quick runs seeds 1 and 2 and a lighter attacker (results/EXPECTED_SHA256_QUICK).

Everything is seeded and offline: the built-in element set, no network.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import statistics
import sys
import time
from concurrent.futures import ProcessPoolExecutor

from . import adaptive_attacker
from .evaluate import ATTACKS, EVASION, HELD_OUT, HOLDOVER, OUTCOMES, TIERS, UPLINK, _plain
from .evaluate import run_seed as _run_seed

SEEDS = (1, 2, 3, 4, 5, 6)
QUICK_SEEDS = (1, 2)


def _job(args: tuple) -> tuple:
    kind, receiver, seed, trials = args
    if kind == "eval":
        return kind, receiver, _run_seed(seed, receiver=receiver)
    return kind, receiver, adaptive_attacker.run(seed, trials, receiver)


def _pct(k: int, n: int) -> str:
    return f"{100 * k / n:.2f}" if n else "-"


def tables(results: dict[str, list[dict]], attacker: dict) -> str:
    """The report's numbers, in a form that depends only on the seeds and the code."""
    out = ["# Reproduced tables", ""]
    for receiver, runs in results.items():
        runs = sorted(runs, key=lambda r: r["seed"])
        out.append(f"## Evaluation, {receiver} receiver, seeds {[r['seed'] for r in runs]}")
        out.append("")
        if receiver == "iq":
            sig = runs[0]["chi_square_sigmas"]
            out.append(
                "chi-square sigmas (seed 1): "
                + ", ".join(f"{k} {v:.4f}" for k, v in sorted(sig.items()))
            )
            out.append("")
        head = ["traffic", "n", *TIERS, *[o.lower() for o in OUTCOMES], "rekey"]
        out.append("| " + " | ".join(head) + " |")
        out.append("|" + "---|" * len(head))
        for name in ("NONE", HOLDOVER, *ATTACKS, *EVASION):
            rows = [r["counts"][name] for r in runs]
            n = sum(c["n"] for c in rows)
            cells = [name + (" (held out)" if name in HELD_OUT else ""), str(n)]
            cells += [_pct(sum(c[k] for c in rows), n) for k in (*TIERS, *OUTCOMES)]
            cells.append(str(sum(c["rekey"] for c in rows)))
            out.append("| " + " | ".join(cells) + " |")
        out.append("")
        out.append(
            "| traffic | AUC forest | AUC chi-square | unflagged without data / stat / phys |"
        )
        out.append("|---|---|---|---|")
        for name in (*ATTACKS, *EVASION):
            rows = [r["counts"][name] for r in runs]
            n = sum(c["n"] for c in rows)
            f = statistics.fmean(c["auc"]["forest"] for c in rows)
            ch = statistics.fmean(c["auc"]["chi"] for c in rows)
            abl = " / ".join(_pct(sum(c["unflagged_without"][t] for c in rows), n) for t in TIERS)
            out.append(f"| {name} | {f:.3f} | {ch:.3f} | {abl} |")
        out.append("")
        clean = [r["counts"]["NONE"] for r in runs]
        n = sum(c["n"] for c in clean)
        both = sum(c["stat_and_phys"] for c in clean)
        s = sum(c["statistical"] for c in clean)
        p = sum(c["physical"] for c in clean)
        out.append(f"genuine: statistical {s}, physical {p}, both {both}, of {n}")
        for threat in UPLINK:
            ex = sum(r["uplink"][threat]["executed"] for r in runs)
            cm = sum(r["uplink"][threat]["commands"] for r in runs)
            out.append(f"uplink {threat}: {ex}/{cm} executed")
        out.append("")

    out.append(f"## Adaptive attacker, seed {attacker['seed']}, {attacker['receiver']} receiver")
    out.append("")
    for key in ("capture_curve", "power_curve", "doppler_curve", "timing_curve"):
        out.append(f"{key}:")
        for pt in attacker[key]:
            where = f"{pt['power_db']:g} dB, {pt['doppler_hz']:g} Hz, {pt['timing_us']:g} us"
            rates = ", ".join(
                f"{k} {pt[k]['rate']:.3f}" for k in ("physical", "statistical", "data", "decoded")
            )
            out.append(f"- {where}: {rates}")
        out.append("")
    for name, pt in attacker["under_gate"].items():
        out.append(f"under the gate, {name}: {pt[name]:.4g} (RF tiers {pt['rf']['rate']:.3f})")
    c = attacker["combined"]
    out.append(f"all three at once: RF tiers {c['rf']['rate']:.3f}, data {c['data']['rate']:.3f}")
    out.append("")
    return "\n".join(out)


def main() -> None:
    parser = argparse.ArgumentParser(description="Every table and figure of the report.")
    parser.add_argument("--quick", action="store_true", help="seeds 1 and 2, lighter attacker")
    parser.add_argument("--out", default="results")
    parser.add_argument("--figures", default="docs/figures")
    parser.add_argument("--workers", type=int, default=os.cpu_count() or 2)
    args = parser.parse_args()

    seeds = QUICK_SEEDS if args.quick else SEEDS
    trials = 30 if args.quick else 100
    jobs = [("eval", rx, seed, 0) for rx in ("model", "iq") for seed in seeds]
    jobs.insert(0, ("attacker", "iq", 1, trials))
    started = time.time()
    results: dict[str, list[dict]] = {"model": [], "iq": []}
    attacker: dict = {}
    with ProcessPoolExecutor(max(1, args.workers)) as pool:
        for kind, receiver, r in pool.map(_job, jobs):
            if kind == "eval":
                results[receiver].append(r)
            else:
                attacker = r
            print(f"  {kind} {receiver} done at {time.time() - started:.0f} s", flush=True)

    os.makedirs(args.out, exist_ok=True)
    suffix = "-quick" if args.quick else ""
    for receiver, runs in results.items():
        with open(os.path.join(args.out, f"eval-{receiver}{suffix}.json"), "w") as f:
            json.dump(sorted(runs, key=lambda r: r["seed"]), f, indent=1, default=_plain)
    with open(os.path.join(args.out, f"attacker{suffix}.json"), "w") as f:
        json.dump(attacker, f, indent=1, default=_plain)

    text = tables(results, attacker)
    path = os.path.join(args.out, f"tables{suffix}.md")
    with open(path, "w") as f:
        f.write(text)
    digest = hashlib.sha256(text.encode()).hexdigest()
    print(text)
    print(f"{path}: sha256 {digest}  ({time.time() - started:.0f} s)")

    if not args.quick:
        try:
            from . import figures
        except ImportError:
            print("matplotlib not installed: figures skipped (pip install matplotlib)")
        else:
            figures._style()
            os.makedirs(args.figures, exist_ok=True)
            iq = sorted(results["iq"], key=lambda r: r["seed"])
            figures.roc_figure(
                sorted(results["model"], key=lambda r: r["seed"]),
                os.path.join(args.figures, "roc_curves.png"),
            )
            figures.constellation_figure(iq[0], os.path.join(args.figures, "constellations.png"))
            figures.attacker_figures(
                attacker,
                os.path.join(args.figures, "adaptive_capture.png"),
                os.path.join(args.figures, "adaptive_alone.png"),
            )
            print(f"figures written to {args.figures}")

    expected = os.path.join(args.out, f"EXPECTED_SHA256{suffix.upper().replace('-', '_')}")
    if os.path.exists(expected):
        with open(expected) as f:
            want = f.read().split()[0]
        if want == digest:
            print("matches the expected hash: the report's numbers are reproduced")
        else:
            print(f"differs from the expected hash {want}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
