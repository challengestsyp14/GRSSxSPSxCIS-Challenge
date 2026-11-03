"""Standard scenario: every attack against both defensive layers, one command.

Trains the link detector on one clean pass, calibrates it on a second, then attacks a third
and reports which layer caught what, plus the security and compute overhead.

Set ``GROUNDLINK_KEY`` to a 64-character hex string to use a fixed link key; otherwise a
fresh random key is drawn for each run. Results do not depend on the key's value.
"""

from __future__ import annotations

import argparse
import json
import os
import pickle
import time
from dataclasses import replace
from typing import Any

import numpy as np

from .attacks import ATTACKS, CRYPTO_VISIBLE, Window
from .audit import ObservationLog
from .detector import LinkAnomalyDetector
from .evaluate import roc_auc
from .frames import HEADER_SIZE, TAG_SIZE
from .simulate import LinkConfig, simulate_pass
from .station import GroundStation, crypto_alarms, feature_matrix, labels


def load_key(variable: str = "GROUNDLINK_KEY") -> bytes:
    value = os.environ.get(variable)
    if not value:
        return os.urandom(32)
    key = bytes.fromhex(value)
    if len(key) != 32:
        raise SystemExit(f"{variable} must be 64 hex characters (32 bytes)")
    return key


def _rate(alarms: np.ndarray, mask: np.ndarray) -> float:
    return float(alarms[mask].mean()) if mask.any() else float("nan")


def run(
    attacks: list[str],
    window: Window,
    target_pfa: float = 0.01,
    seed: int = 0,
    key: bytes | None = None,
) -> dict[str, Any]:
    unknown = sorted(set(attacks) - set(ATTACKS))
    if unknown:
        raise SystemExit(f"unknown attack(s) {unknown}; choose from {sorted(ATTACKS)}")

    key = key or load_key()
    station = GroundStation(key)

    # Three independent clean passes: train, calibrate, and the one we attack.
    train = feature_matrix(station.process(simulate_pass(key, config=LinkConfig(seed=seed + 1))))
    calibration = feature_matrix(
        station.process(simulate_pass(key, config=LinkConfig(seed=seed + 2)))
    )
    clean = simulate_pass(key, config=LinkConfig(seed=seed))

    fit_started = time.perf_counter()
    detector = LinkAnomalyDetector(target_pfa=target_pfa, seed=seed).fit(train, calibration)
    fit_seconds = time.perf_counter() - fit_started

    results = []
    crypto_seconds = ml_seconds = 0.0
    frames_seen = 0

    for name in attacks:
        received = ATTACKS[name](clean, window)

        started = time.perf_counter()
        reports = station.process(received)
        crypto_seconds += time.perf_counter() - started

        features = feature_matrix(reports)
        started = time.perf_counter()
        scores = detector.score(features)
        ml_seconds += time.perf_counter() - started
        frames_seen += len(reports)

        truth = labels(reports)
        arrivals = np.array([r.arrival_s for r in reports])
        # False alarms are measured on the quiet period only. Genuine frames inside the
        # attack window have their context disturbed by the attacker and are excluded
        # from both rates.
        attacked = truth == 1
        quiet = (truth == 0) & ~((arrivals >= window.start_s) & (arrivals < window.end_s))

        crypto = crypto_alarms(reports)
        ml = (scores >= detector.threshold).astype(int)
        combined = crypto | ml

        crypto_pd, ml_pd = _rate(crypto, attacked), _rate(ml, attacked)
        caught_by = [layer for layer, pd in (("crypto", crypto_pd), ("ml", ml_pd)) if pd >= 0.5]

        driver = "—"
        if ml_pd >= 0.5:
            middle = np.flatnonzero(attacked)[attacked.sum() // 2]
            driver = detector.explain(features[middle])

        results.append(
            {
                "attack": name,
                "frames_attacked": int(attacked.sum()),
                "crypto_pd": round(crypto_pd, 4),
                "ml_pd": round(ml_pd, 4),
                "combined_pd": round(_rate(combined, attacked), 4),
                "combined_pfa": round(_rate(combined, quiet), 4),
                "ml_roc_auc": round(roc_auc(scores[attacked | quiet], truth[attacked | quiet]), 4),
                "caught_by": "+".join(caught_by) or "none",
                "expected_layer": "crypto" if name in CRYPTO_VISIBLE else "ml",
                "ml_driver": driver,
            }
        )

    # Seal the station's record of the last pass and prove edits to it are caught.
    audit = ObservationLog(os.urandom(32))
    for report in reports:
        audit.append(
            report.arrival_s,
            {
                "status": report.status.value,
                "sequence": report.sequence,
                "features": [round(float(v), 6) for v in report.features],
            },
        )
    chain_ok, _ = audit.verify()
    forged = list(audit.records)
    forged[len(forged) // 2] = replace(forged[len(forged) // 2], payload_digest="0" * 64)
    forged_ok, forged_reason = audit.verify(forged)

    payload_bytes = LinkConfig().payload_bytes
    return {
        "scenario": {
            "window_s": [window.start_s, window.end_s],
            "target_pfa": target_pfa,
            "seed": seed,
        },
        "results": results,
        "overhead": {
            "auth_tag_bytes_per_frame": TAG_SIZE,
            "security_bytes_share_of_frame": round(
                TAG_SIZE / (HEADER_SIZE + payload_bytes + TAG_SIZE), 4
            ),
            "crypto_us_per_frame": round(crypto_seconds / frames_seen * 1e6, 2),
            "ml_us_per_frame": round(ml_seconds / frames_seen * 1e6, 2),
            "ml_training_s": round(fit_seconds, 3),
            "ml_model_bytes": len(pickle.dumps(detector)),
        },
        "audit_log": {
            "records_sealed": len(audit),
            "chain_valid": chain_ok,
            "edit_detected": not forged_ok,
            "edit_located": forged_reason,
        },
    }


def format_table(result: dict[str, Any]) -> str:
    header = (
        f"{'attack':<9} {'crypto Pd':>9} {'ML Pd':>7} {'both Pd':>8} "
        f"{'both Pfa':>9} {'ML AUC':>7}  {'caught by':<10} driver"
    )
    lines = [header, "-" * len(header)]
    for r in result["results"]:
        lines.append(
            f"{r['attack']:<9} {r['crypto_pd']:>9.3f} {r['ml_pd']:>7.3f} "
            f"{r['combined_pd']:>8.3f} {r['combined_pfa']:>9.3f} {r['ml_roc_auc']:>7.3f}  "
            f"{r['caught_by']:<10} {r['ml_driver']}"
        )
    o, a = result["overhead"], result["audit_log"]
    lines += [
        "",
        f"overhead: {o['auth_tag_bytes_per_frame']} B tag/frame "
        f"({o['security_bytes_share_of_frame']:.1%} of frame), "
        f"crypto {o['crypto_us_per_frame']} µs/frame, ML {o['ml_us_per_frame']} µs/frame, "
        f"model {o['ml_model_bytes'] / 1024:.0f} KiB, trained in {o['ml_training_s']} s",
        f"audit log: {a['records_sealed']} records, chain valid={a['chain_valid']}, "
        f"edit detected={a['edit_detected']} ({a['edit_located']})",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--attack",
        action="append",
        choices=sorted(ATTACKS),
        help="attack to run; repeat for several (default: all)",
    )
    parser.add_argument("--start", type=float, default=200.0, help="attack start, seconds")
    parser.add_argument("--end", type=float, default=260.0, help="attack end, seconds")
    parser.add_argument("--pfa", type=float, default=0.01, help="target false-alarm rate")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--json", help="also write the full result to this path")
    args = parser.parse_args(argv)

    result = run(
        attacks=args.attack or list(ATTACKS),
        window=Window(args.start, args.end),
        target_pfa=args.pfa,
        seed=args.seed,
    )
    print(format_table(result))

    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(result, handle, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
