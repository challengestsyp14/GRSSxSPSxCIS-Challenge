"""
adaptive_attacker.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin: an attacker that knows the orbit, the link budget and the gates, and tunes its
signal to stay under them. It has no key.

It controls three things: its power, its carrier against the predicted Doppler, and its timing
against the predicted light time. Each trial is one forged frame on a clean link (ten genuine
frames before it, so the station's memory of failures is empty), received through the
sample-level receiver (iq_receiver.py) and judged by the same station as the evaluation.

Two situations:
- the satellite is still transmitting: to capture the receiver the attacker must be louder than
  the genuine carrier, which stays on the channel underneath it (capture_curve);
- the attacker is alone on the channel, the genuine carrier gone (power_curve, doppler_curve,
  timing_curve): what it can hide in each dimension.
Then a search for the strongest signal under the gate: the largest power, Doppler and timing
offsets at which the physical and statistical tiers flag at most 5 % of its frames.

None of this tuned any gate or rule: the attacker was written after they were fixed, and its
results are reported apart from the evaluation's.

Run: python -m digital_twin.adaptive_attacker [--seed 1] [--trials 100] [--json out.json]
"""

from __future__ import annotations

import argparse
import json
import logging
import math

from .datasets import Record
from .evaluate import (
    Station,
    TwinSource,
    _plain,
    _training_rows,
    _unsealed,
    calibrate_sigmas,
    wilson_interval,
)
from .fec import frame_error_rate
from .isolation_forest_detector import RATE_WINDOW, SiteFrameForest

SPEED_OF_LIGHT_KM_US = 0.299792458
#: At most this share of frames flagged by the RF tiers counts as "under the gate".
UNDER_GATE = 0.05

CAPTURE_MARGINS_DB = (0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 6.0, 8.0)
POWER_OFFSETS_DB = (0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0)
DOPPLER_OFFSETS_HZ = (0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 40.0, 60.0)
TIMING_OFFSETS_US = (0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 6.0)


class AdaptiveAttacker:
    def __init__(self, seed: int = 1, receiver: str = "iq", n_train: int = 3000):
        logging.disable(logging.CRITICAL)
        self.source = TwinSource(seed, receiver)
        train = self.source.training(n_train)
        engine = self.source.v.physics_engine
        if receiver == "iq":
            engine.sigmas = calibrate_sigmas(train, engine)
        forest = SiteFrameForest().fit(_training_rows(train))
        self.station = Station(self.source.v.crypto, engine, forest)

    def _frame(self, power_db, doppler_hz, timing_us, genuine_present) -> Record:
        src, v = self.source, self.source.v
        t, vis, true_link = next(src.ticks)
        sealed = v.crypto.seal_packet(
            v.framer.build_telemetry_packet(v.sequence % 16384, v.telemetry_payload(t), t)
        )
        v.sequence += 1
        genuine = v.measure(true_link, vis["elevation_deg"])
        channel = dict(genuine)
        channel["snr_db"] += power_db
        channel["rssi_dbm"] += power_db
        channel["doppler_shift_hz"] += doppler_hz
        channel["slant_range_km"] += timing_us * SPEED_OF_LIGHT_KM_US
        channel["light_time_us"] += timing_us
        forged = _unsealed(sealed)
        forged["payload"] = {**forged["payload"], "mode": "SAFE_HOLD"}
        pkt = src.attacker.seal_packet(v.framer.rebuild(forged))
        sinr = channel["snr_db"]
        interferer = None
        if genuine_present:
            # The genuine carrier stays on the channel, power_db under the captor.
            lin = 1.0 / (10 ** (-channel["snr_db"] / 10) + 10 ** (-power_db / 10))
            sinr = 10 * math.log10(lin)
            interferer = {"below_db": power_db, "offset_hz": doppler_hz}
        if src.rng.random() < frame_error_rate(sinr):
            pkt = None
        link = src._receive(channel, true_link, "ADAPTIVE", interferer)
        return Record(t, vis["elevation_deg"], "ADAPTIVE", link, true_link, pkt)

    def trial(
        self,
        n: int,
        power_db: float = 0.0,
        doppler_hz: float = 0.0,
        timing_us: float = 0.0,
        genuine_present: bool = False,
    ) -> dict:
        """n forged frames, each after RATE_WINDOW genuine ones; the share each tier flags."""
        keys = ("physical", "statistical", "data", "rf", "any", "decoded")
        hits = dict.fromkeys(keys, 0)
        for _ in range(n):
            for _ in range(RATE_WINDOW):
                self.station.judge(self.source.record("NONE", 0))
            r = self.station.judge(self._frame(power_db, doppler_hz, timing_us, genuine_present))
            f = r["flags"]
            hits["physical"] += bool(f.physical)
            hits["statistical"] += bool(f.statistical)
            hits["data"] += bool(f.data)
            hits["rf"] += bool(f.physical or f.statistical)
            hits["any"] += r["outcome"] != "DELIVERED"
            hits["decoded"] += bool(r["decoded"])
        out = {
            "power_db": power_db,
            "doppler_hz": doppler_hz,
            "timing_us": timing_us,
            "genuine_present": genuine_present,
            "n": n,
        }
        for k in keys:
            lo, hi = wilson_interval(hits[k], n)
            out[k] = {"rate": hits[k] / n, "ci95": [lo, hi]}
        return out

    def curve(self, n: int, name: str, values, genuine_present=False) -> list[dict]:
        return [self.trial(n, genuine_present=genuine_present, **{name: x}) for x in values]

    def strongest_under_gate(self, n: int, name: str, hi: float, steps: int = 6) -> dict:
        """Bisection for the largest offset in one dimension that the RF tiers still miss."""
        lo, best = 0.0, self.trial(n, **{name: 0.0})
        for _ in range(steps):
            mid = 0.5 * (lo + hi)
            r = self.trial(n, **{name: mid})
            if r["rf"]["rate"] <= UNDER_GATE:
                lo, best = mid, r
            else:
                hi = mid
        return best

    def combined_search(self, n: int, power_db: float, doppler_hz: float, timing_us: float):
        """All three at their single-dimension limits at once: they add up in the chi-square."""
        return self.trial(n, power_db=power_db, doppler_hz=doppler_hz, timing_us=timing_us)


def run(seed: int = 1, trials: int = 100, receiver: str = "iq") -> dict:
    attacker = AdaptiveAttacker(seed, receiver)
    result = {
        "seed": seed,
        "receiver": receiver,
        "trials_per_point": trials,
        "chi_square_sigmas": dict(attacker.station.physics.sigmas),
        "capture_curve": attacker.curve(trials, "power_db", CAPTURE_MARGINS_DB, True),
        "power_curve": attacker.curve(trials, "power_db", POWER_OFFSETS_DB),
        "doppler_curve": attacker.curve(trials, "doppler_hz", DOPPLER_OFFSETS_HZ),
        "timing_curve": attacker.curve(trials, "timing_us", TIMING_OFFSETS_US),
    }
    limits = {
        "power_db": attacker.strongest_under_gate(trials, "power_db", 3.0),
        "doppler_hz": attacker.strongest_under_gate(trials, "doppler_hz", 60.0),
        "timing_us": attacker.strongest_under_gate(trials, "timing_us", 6.0),
    }
    result["under_gate"] = limits
    result["combined"] = attacker.combined_search(
        trials,
        limits["power_db"]["power_db"],
        limits["doppler_hz"]["doppler_hz"],
        limits["timing_us"]["timing_us"],
    )
    return result


def print_summary(r: dict) -> None:
    def row(p, label):
        return (
            f"  {label:>10}  physical {p['physical']['rate']:6.1%}  statistical "
            f"{p['statistical']['rate']:6.1%}  data {p['data']['rate']:6.1%}  decoded "
            f"{p['decoded']['rate']:6.1%}"
        )

    print(
        f"adaptive attacker, seed {r['seed']}, {r['receiver']} receiver, {r['trials_per_point']}"
        " forged frames a point"
    )
    print("capturing the receiver while the satellite transmits (margin over the genuine):")
    for p in r["capture_curve"]:
        print(row(p, f"+{p['power_db']:.1f} dB"))
    for key, unit, name in (
        ("power_curve", "dB", "power_db"),
        ("doppler_curve", "Hz", "doppler_hz"),
        ("timing_curve", "us", "timing_us"),
    ):
        print(f"alone on the channel, {name}:")
        for p in r[key]:
            print(row(p, f"{p[name]:g} {unit}"))
    print("strongest single offset the RF tiers miss (at most 5 % flagged):")
    for name, p in r["under_gate"].items():
        print(
            f"  {name}: {p[name]:.3g}, RF tiers flag {p['rf']['rate']:.1%}, "
            f"data {p['data']['rate']:.0%}"
        )
    c = r["combined"]
    print(
        f"all three at once: RF tiers flag {c['rf']['rate']:.1%}, data tier "
        f"{c['data']['rate']:.0%}, reaching the analyst {1 - c['any']['rate']:.1%}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="The adaptive attacker (upgrade U3).")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--trials", type=int, default=100)
    parser.add_argument("--receiver", choices=("model", "iq"), default="iq")
    parser.add_argument("--json")
    args = parser.parse_args()
    r = run(args.seed, args.trials, args.receiver)
    if args.json:
        with open(args.json, "w") as out:
            json.dump(r, out, indent=1, default=_plain)
    print_summary(r)


if __name__ == "__main__":
    main()
