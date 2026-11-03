"""
validator.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Red-Team Adversarial Attack Simulation & Validator Module

`run_red_team_audit()` walks one packet per scenario through the full pipeline.
`measure()` produces the evaluation-report numbers: it trains the detector on nominal passes,
then streams held-out nominal traffic interleaved with bursts of each attack, and scores every
layer against the ground-truth label. Everything is seeded, so a run is reproducible.

Run: python -m testbed.validator [--seed 14]
"""

from __future__ import annotations

import argparse
import statistics
import time

from .detector import TelemetryDetector
from .ingester import ATTACK_MODES, TelemetryIngester
from .trust_anchor import TrustAnchorLedger
from .zero_trust import ZeroTrustPolicyEngine

SCENARIOS = [
    ("normal", "Nominal Baseline (No Attack)"),
    ("frequency_hijacking", "Red-Team Vector 1: Frequency Hijacking (+14.2 MHz Sweep)"),
    ("stealth_spoofing", "Red-Team Vector 2: Stealth Spoofing (Forged Nonce 0x99A2)"),
    ("noise_jamming", "Red-Team Vector 3: Broadband Noise Jamming (-96.5 dBm Drop)"),
    ("data_tampering", "Red-Team Vector 4: Data Tampering (Payload Bit Flip in Transit)"),
]


class Pipeline:
    """Ingester → detector → trust anchor → zero-trust decision."""

    def __init__(self, seed: int, n_train: int):
        self.ingester = TelemetryIngester(seed=seed)
        self.detector = TelemetryDetector()
        self.detector.train_baseline(
            [self.ingester.generate_packet("normal") for _ in range(n_train)]
        )
        self.ledger = TrustAnchorLedger(self.ingester.key)
        self.zta = ZeroTrustPolicyEngine()

    def process(self, mode: str) -> dict:
        packet = self.ingester.generate_packet(mode)
        t0 = time.perf_counter()
        detection = self.detector.evaluate_packet(packet)
        t1 = time.perf_counter()
        block, authentic, reason = self.ledger.ingest(packet)
        t2 = time.perf_counter()
        decision = self.zta.evaluate_access_request(packet, detection, (authentic, reason))
        if decision["access_granted"]:
            self.detector.accept(packet)
        t3 = time.perf_counter()
        return {
            "packet": packet,
            "detection": detection,
            "block": block,
            "authentic": authentic,
            "auth_reason": reason,
            "decision": decision,
            "detector_ms": (t1 - t0) * 1e3,
            "ledger_ms": (t2 - t1) * 1e3,
            "total_ms": (t3 - t0) * 1e3,
        }


def run_red_team_audit(seed: int = 14) -> None:
    print("==================================================")
    print("TSYP 14: RED-TEAM ATTACK & SECURITY VALIDATION")
    print("==================================================")
    print("[*] Training the detector on nominal baseline telemetry...")
    pipe = Pipeline(seed, n_train=1200)
    print(f"[*] Genesis root: {pipe.ledger.genesis_root}")
    print("\n[+] Executing red-team adversarial injections...\n")
    for mode, description in SCENARIOS:
        # A few nominal packets between scenarios, as on a real link.
        for _ in range(5):
            pipe.process("normal")
        r = pipe.process(mode)
        p = r["packet"]
        print(f"--- Scenario: {description} ---")
        print(f" -> Packet seq: {p['sequence']} | token {p['hw_token']}")
        print(f" -> Carrier: {p['carrier_frequency_mhz']} MHz | RSSI: {p['rssi_dbm']} dBm")
        print(
            f" -> Detector: anomaly={r['detection']['anomaly']} "
            f"(physics gate={r['detection']['physics_gate']}, "
            f"isolation forest={r['detection']['isolation_forest']})"
        )
        print(f" -> Trust anchor: {r['auth_reason']}")
        print(f" -> Zero trust: {r['decision']['policy_action']}")
        print(f" -> Ledger block #{r['block']['index']}: {r['block']['hash'][:16]}...\n")
    ok, msg = pipe.ledger.verify_chain()
    print("==================================================")
    print(f"Final cryptographic ledger audit: {msg}")
    print("==================================================")


def _p95(values: list[float]) -> float:
    return statistics.quantiles(values, n=20)[18]


def measure(
    seed: int = 14,
    n_train: int = 3000,
    n_nominal: int = 6000,
    bursts: int = 50,
    burst_len: int = 30,
) -> dict:
    """Scores every layer on held-out nominal traffic and on bursts of each attack."""
    pipe = Pipeline(seed, n_train)
    attacks = [m for m in ATTACK_MODES if m != "normal"]
    counts = {
        m: {"n": 0, "detector": 0, "gate": 0, "forest": 0, "anchor": 0, "denied": 0}
        for m in ATTACK_MODES
    }
    first_flag: dict[str, list[int]] = {m: [] for m in attacks}
    detector_ms: list[float] = []
    ledger_ms: list[float] = []
    total_ms: list[float] = []

    def score(mode: str) -> dict:
        r = pipe.process(mode)
        c = counts[mode]
        c["n"] += 1
        c["detector"] += r["detection"]["anomaly"]
        c["gate"] += r["detection"]["physics_gate"]
        c["forest"] += r["detection"]["isolation_forest"]
        c["anchor"] += not r["authentic"]
        c["denied"] += not r["decision"]["access_granted"]
        detector_ms.append(r["detector_ms"])
        ledger_ms.append(r["ledger_ms"])
        total_ms.append(r["total_ms"])
        return r

    nominal_per_gap = n_nominal // (bursts * len(attacks))
    for _ in range(bursts):
        for mode in attacks:
            for _ in range(nominal_per_gap):
                score("normal")
            flagged_at = None
            for i in range(burst_len):
                r = score(mode)
                if flagged_at is None and not r["decision"]["access_granted"]:
                    flagged_at = i + 1
            first_flag[mode].append(flagged_at if flagged_at is not None else burst_len + 1)

    chain_ok, chain_msg = pipe.ledger.verify_chain()
    t0 = time.perf_counter()
    pipe.ledger.verify_chain()
    verify_ms = (time.perf_counter() - t0) * 1e3

    # Tamper test: flip one recorded verdict in the middle of the chain.
    victim = pipe.ledger.chain[len(pipe.ledger.chain) // 2]
    original = victim["payload"]["verdict"]
    victim["payload"]["verdict"] = "AUTHENTIC" if original != "AUTHENTIC" else "MAC_MISMATCH"
    tamper_caught, tamper_msg = pipe.ledger.verify_chain()
    victim["payload"]["verdict"] = original

    rate = {m: {k: v / counts[m]["n"] for k, v in c.items() if k != "n"} for m, c in counts.items()}
    return {
        "seed": seed,
        "n_train": n_train,
        "counts": {m: c["n"] for m, c in counts.items()},
        "rates": rate,
        "packets_to_first_flag": {m: statistics.mean(v) for m, v in first_flag.items()},
        "detector_ms": {"mean": statistics.mean(detector_ms), "p95": _p95(detector_ms)},
        "ledger_ms": {"mean": statistics.mean(ledger_ms), "p95": _p95(ledger_ms)},
        "total_ms": {"mean": statistics.mean(total_ms), "p95": _p95(total_ms)},
        "chain": {
            "blocks": len(pipe.ledger.chain),
            "intact": chain_ok,
            "message": chain_msg,
            "verify_ms": verify_ms,
            "tamper_detected": not tamper_caught,
            "tamper_message": tamper_msg,
        },
    }


def print_metrics(m: dict) -> None:
    pct = lambda v: f"{100 * v:5.1f}%"  # noqa: E731
    print(f"\nMeasured over seed {m['seed']} ({m['n_train']} training packets)")
    print(
        f"{'traffic':<22}{'packets':>8}{'physics':>9}{'forest':>9}{'detector':>10}"
        f"{'anchor':>9}{'denied':>9}"
    )
    for mode, r in m["rates"].items():
        print(
            f"{mode:<22}{m['counts'][mode]:>8}{pct(r['gate']):>9}{pct(r['forest']):>9}"
            f"{pct(r['detector']):>10}{pct(r['anchor']):>9}{pct(r['denied']):>9}"
        )
    print("\npackets from attack onset to first denial:")
    for mode, v in m["packets_to_first_flag"].items():
        print(f"  {mode:<22}{v:.2f}")
    for key in ("detector_ms", "ledger_ms", "total_ms"):
        print(f"{key:<12} mean {m[key]['mean']:.3f} ms  p95 {m[key]['p95']:.3f} ms")
    c = m["chain"]
    print(
        f"ledger: {c['blocks']} blocks, {c['message']} (verify {c['verify_ms']:.1f} ms); "
        f"tamper test: {'detected' if c['tamper_detected'] else 'MISSED'} ({c['tamper_message']})"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[3])
    parser.add_argument("--seed", type=int, default=14)
    args = parser.parse_args()
    run_red_team_audit(args.seed)
    print_metrics(measure(args.seed))


if __name__ == "__main__":
    main()
