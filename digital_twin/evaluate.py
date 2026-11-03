"""
evaluate.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin, the seeded evaluation: the three tiers and the decision rule against ten downlink
attacks, three below-the-gate jams and three uplink threats, on TerraSAR-X passes over Zaghouan.

Protocol, per seed (the report uses seeds 1 to 6):
- train the statistical tier on 3,000 nominal frames, one a second over the first passes after
  the element set's epoch;
- stream the passes that follow, one packet a second while the link is up: 6,000 held-out
  nominal packets interleaved with 500 attack bursts (50 per attack, 30 packets each);
- then 50 bursts of each below-the-gate jam, with nominal packets between them, and 50
  telecommands under each uplink threat.

Every packet is read through the dataset adapter (datasets.py), so `--dataset official --path`
runs the same tiers and rule on the official reference data. Each packet goes through:
- the decoder: the CCSDS rate-1/2 convolutional code (fec.py) loses the frame below its
  threshold, so a jammed frame is lost, never delivered with flipped bits;
- data: HMAC-SHA256 tag and SHA-256 digest (crypto_hash_verifier.py), then the anti-replay
  window on the CCSDS sequence count (trust_anchor.py's ReplayWindow), which marks every count
  that authenticates as seen, whatever the other tiers decide;
- statistical: the site's per-frame Isolation Forest (isolation_forest_detector.SiteFrameForest:
  the same four features, 256 trees, 1 % contamination as linkDetector.ts);
- physical: the chi-square against SGP4 and the ITU-R P.618 link budget, and the kinematic
  coupling of range and Doppler (security_detector.py);
then the decision (decision.py): delivered, degraded, held, rejected or quarantined.

Attacks and where each comes from:
- FREQUENCY_HIJACKING, STEALTH_SPOOFING, NOISE_JAMMING, DATA_TAMPERING: the live dashboard's
  four (dashboard/src/sim/signals.ts), with its constants;
- RELAY, PHASE_SLIP, INJECTION: the twin's DELAY_SPOOFING_MEACONING, COHERENT_PHASE_SLIP and
  CCSDS_SEQUENCE_HIJACK (attack_injector.AerospaceAttackInjector.inject_threat);
- REPLAY, DELAY: groundlink/attacks.py's replay and delay, with its constants;
- CO_CHANNEL_CAPTURE: a louder transmitter on the channel itself, a few kHz off the Doppler
  track, the realistic version of the hijack.
PHASE_SLIP and CO_CHANNEL_CAPTURE were added after the gates and the rule were fixed, and are
reported apart as held-out attacks. Every gate is set from clean traffic only.

Everything is seeded and offline (the built-in element set), so a run is reproducible.

Run: python -m digital_twin.evaluate [--seeds 1 2 3 4 5 6] [--workers 3] [--json results.json]
     python -m digital_twin.evaluate --dataset official --path data/official.jsonl
"""

from __future__ import annotations

import argparse
import copy
import json
import logging
import math
import os
import resource
import statistics
import sys
import time
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from dataclasses import replace
from functools import partial

import numpy as np

from testbed.ingester import ROGUE_NODE_TOKEN, SAT_TOKEN
from testbed.trust_anchor import ReplayWindow

from .attack_injector import AerospaceAttackInjector
from .ccsds_framing import SEQUENCE_MODULO
from .crypto_hash_verifier import KEY_ENV, CryptoIntegrityVerifier
from .datasets import Record, read_records, write_records
from .decision import OUTCOMES, BurstMonitor, TierFlags, decide, power_only
from .ephemeris_loader import EphemerisLoader, parse_tle
from .fec import frame_error_rate
from .iq_receiver import IqReceiver
from .isolation_forest_detector import RATE_WINDOW, SiteFrameForest, evm_from_snr
from .physics_validator import MasterTelemetryValidator
from .security_detector import (
    DEFAULT_RANGE_JERK_BOUND_KM_S3,
    PhysicsSecurityEngine,
    elevation_spread_factor,
)

SPEED_OF_LIGHT_KM_S = 299_792.458

ATTACKS = (
    "FREQUENCY_HIJACKING",
    "STEALTH_SPOOFING",
    "NOISE_JAMMING",
    "DATA_TAMPERING",
    "RELAY",
    "PHASE_SLIP",
    "INJECTION",
    "REPLAY",
    "DELAY",
    "CO_CHANNEL_CAPTURE",
)
#: Added after the gates and the decision rule were fixed: reported apart.
HELD_OUT = ("PHASE_SLIP", "CO_CHANNEL_CAPTURE")
#: Where each attack comes from, for the report.
ATTACK_SOURCE = {
    "FREQUENCY_HIJACKING": "dashboard/src/sim/signals.ts (hijack)",
    "STEALTH_SPOOFING": "dashboard/src/sim/signals.ts (spoof)",
    "NOISE_JAMMING": "dashboard/src/sim/signals.ts (jam)",
    "DATA_TAMPERING": "dashboard/src/sim/engine.ts (tamper)",
    "RELAY": "digital_twin/attack_injector.py DELAY_SPOOFING_MEACONING",
    "PHASE_SLIP": "digital_twin/attack_injector.py COHERENT_PHASE_SLIP",
    "INJECTION": "digital_twin/attack_injector.py CCSDS_SEQUENCE_HIJACK",
    "REPLAY": "groundlink/attacks.py (replay)",
    "DELAY": "groundlink/attacks.py (delay)",
    "CO_CHANNEL_CAPTURE": "digital_twin/evaluate.py (co-channel capture)",
}
#: Noise below the chi-square gate: the dashboard's demo jam, the budget overhead, at the mask.
EVASION = {
    "JAM_BELOW_GATE_DEMO": -12.8,
    "JAM_AT_STEALTH_LIMIT": -5.334,
    "JAM_AT_MASK_LIMIT": -3.1,
}
UPLINK = ("COMMAND_TAMPERING", "COMMAND_INJECTION", "COMMAND_REPLAY")
#: Genuine packets whose 10-slot look-back still holds an attack frame: the statistical tier's
#: rate features remember the attack. Counted apart from the false-alarm set.
HOLDOVER = "NONE_HOLDOVER"
TIERS = ("data", "statistical", "physical")

#: Dashboard constants (dashboard/src/sim/signals.ts, linkFacts.ts).
HIJACK_OFFSET_HZ = 14.2e6
HIJACK_SWEEP_HZ = 0.35e6
HIJACK_EXCESS_DB = 9.0
SPOOF_POWER_DROP_DB = 3.2
SPOOF_DOPPLER_ERROR_HZ = 30.0
JAM_TO_NOISE_DB = 9.1
JAMMED_POWER_DBM = -96.5
JAM_LOCK_LOSS_HZ = 0.8e6
#: groundlink/attacks.py: replayed frames recorded at least this long before, frames held back.
REPLAY_AGE_S = (60.0, 180.0)
DELAY_S = 0.080
#: Co-channel capture: on the channel, this far off the Doppler track, this much louder.
CAPTURE_OFFSET_HZ = 4.0e3
CAPTURE_EXCESS_DB = 6.0
#: The measurement model (noise added to the link figures) or the sample-level receiver.
RECEIVERS = ("model", "iq")
#: Which frame of a burst gives the constellation figure, and how many of its symbols.
CONSTELLATION_FRAME = 5
CONSTELLATION_POINTS = 480
#: Relative spread of the EVM estimate on one frame (the site's 4 %).
EVM_SPREAD = 0.04
#: Digests of the frames received with a valid tag, kept to tell a replay from a key holder.
SEEN_DIGESTS = 4096


def snr_loss_db(jam_to_noise_db: float) -> float:
    """SNR lost when noise J/N dB above the thermal floor is added: 10 log10(1 + J/N)."""
    return 10.0 * math.log10(1.0 + 10.0 ** (jam_to_noise_db / 10.0))


def wilson_interval(k: int, n: int, z: float = 1.959964) -> tuple[float, float]:
    """95 % Wilson score interval of a rate k / n."""
    if n == 0:
        return 0.0, 1.0
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return max(0.0, centre - half), min(1.0, centre + half)


def auc(negatives: list[float], positives: list[float]) -> float:
    """Area under the ROC curve: P(score of an attack packet > score of a clean one)."""
    if not negatives or not positives:
        return float("nan")
    ranked = sorted([(s, 0) for s in negatives] + [(s, 1) for s in positives])
    rank_sum, i = 0.0, 0
    while i < len(ranked):
        j = i
        while j < len(ranked) and ranked[j][0] == ranked[i][0]:
            j += 1
        mean_rank = (i + j + 1) / 2.0
        rank_sum += mean_rank * sum(label for _, label in ranked[i:j])
        i = j
    n_pos, n_neg = len(positives), len(negatives)
    return (rank_sum - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


class SequenceFreshness:
    """trust_anchor.py's anti-replay window on the 14-bit CCSDS sequence count, unwrapped."""

    def __init__(self, size: int = 64):
        self.window = ReplayWindow(size)
        self.high: int | None = None

    def unwrap(self, count: int) -> int:
        if self.high is None:
            return count
        delta = (count - self.high) % SEQUENCE_MODULO
        if delta > SEQUENCE_MODULO // 2:
            delta -= SEQUENCE_MODULO
        return self.high + delta

    def fresh(self, count: int) -> bool:
        """Read-only check; the count is marked as seen only once its frame authenticates."""
        seq = self.unwrap(count)
        w = self.window
        return not (seq <= w.high - w.size or seq in w.seen)

    def accept(self, count: int) -> None:
        seq = self.unwrap(count)
        self.window.accept(seq)
        self.high = self.window.high


# ---------------------------------------------------------------------- the station


class Station:
    """The receiving station: the decoder's output through the three tiers and the rule."""

    def __init__(
        self,
        crypto: CryptoIntegrityVerifier,
        physics: PhysicsSecurityEngine,
        forest,
        token: str = SAT_TOKEN,
    ):
        self.crypto = crypto
        self.physics = physics
        self.forest = forest
        self.token = token
        self.freshness = SequenceFreshness()
        self.burst = BurstMonitor()
        self.seen: deque[str] = deque(maxlen=SEEN_DIGESTS)
        self.seen_set: set[str] = set()

    def _remember(self, digest: str) -> None:
        if digest in self.seen_set:
            return
        if len(self.seen) == self.seen.maxlen:
            self.seen_set.discard(self.seen[0])
        self.seen.append(digest)
        self.seen_set.add(digest)

    def judge(self, rec: Record) -> dict:
        t0 = time.perf_counter()
        pkt = rec.packet
        decoded = pkt is not None
        tag_ok = token_ok = fresh = key_holder = False
        if decoded:
            tag_ok = self.crypto.verify_packet_integrity(pkt)["integrity_passed"]
            token_ok = pkt["payload"].get("hw_token", self.token) == self.token
            fresh = self.freshness.fresh(pkt["ccsds_header"]["sequence_count"])
            if tag_ok:
                # A valid tag on a foreign token, or on new content under a stale count: only a
                # key holder can do that. A replay repeats content already received.
                digest = pkt["sha256_hash"]
                key_holder = not token_ok or (not fresh and digest not in self.seen_set)
                self._remember(digest)
        authentic = decoded and tag_ok and token_ok and fresh
        ml = self.forest.evaluate(rec.t, rec.link, rec.predicted, decoded)
        physics = self.physics.evaluate_telemetry_physics(
            rec.link, rec.predicted, rec.elevation_deg, rec.t
        )
        physical = physics["physical_breach_detected"]
        flags = TierFlags(
            data=not authentic,
            statistical=ml["threat_detected"],
            physical=physical,
            power_only=physical and power_only(physics),
            auth_failure=decoded and not authentic,
            key_holder=key_holder,
        )
        burst = self.burst.observe(flags.auth_failure)
        outcome, _ = decide(flags, burst)
        self.forest.observe(rec.t, rec.link, rec.predicted, decoded, flags.auth_failure)
        if authentic:
            self.freshness.accept(pkt["ccsds_header"]["sequence_count"])
        if outcome == "DELIVERED":
            self.forest.accept(rec.link, rec.predicted)
        return {
            "flags": flags,
            "burst": burst,
            "outcome": outcome,
            "ms": (time.perf_counter() - t0) * 1e3,
            "decoded": decoded,
            "verified": authentic,
            "chi_square": physics["chi_square_breach"],
            "kinematic": physics["kinematic_coupling"]["kinematic_breach"],
            # Scores that grow with suspicion, for the ROC curves.
            "forest_score": -ml["anomaly_score"],
            "chi_ratio": physics["chi_square_value"] / physics["adaptive_threshold"],
            "snr_loss_db": float(rec.extra.get("snr_loss_db", 0.0)),
        }


# ---------------------------------------------------------------------- the synthetic source


class TwinSource:
    """The twin flying TerraSAR-X over Zaghouan: what the station receives, packet by packet."""

    def __init__(self, seed: int, receiver: str = "model"):
        logging.disable(logging.CRITICAL)
        if receiver not in RECEIVERS:
            raise ValueError(f"receiver {receiver!r}: expected one of {RECEIVERS}")
        self.seed = seed
        self.receiver = receiver
        self.tle = EphemerisLoader().builtin()
        self.v = MasterTelemetryValidator(seed=seed, tle=self.tle, training_passes=1)
        self.injector: AerospaceAttackInjector = self.v.injector
        self.rng = np.random.default_rng(1000 + seed)
        self.attacker = CryptoIntegrityVerifier(self.rng.bytes(32))
        self.recorded: deque = deque(maxlen=400)
        self.iq = (
            IqReceiver(5000 + seed, self.v.link_calc.noise_floor_dbm) if receiver == "iq" else None
        )
        #: One frame's constellation per traffic class, when the receiver works on samples.
        self.constellations: dict[str, list[list[float]]] = {}
        self.clock = self.tle["epoch_unix"]
        self.ticks = self._ticks()

    def _ticks(self):
        """Every second the link is up, pass after pass."""
        while True:
            found = self.v.next_pass(self.clock)
            for t in np.arange(found["aos_unix"], found["los_unix"], 1.0):
                vis, link = self.v.true_link(float(t))
                if vis["is_above_horizon"]:
                    yield float(t), vis, link
            self.clock = found["los_unix"] + 60.0

    def training(self, n: int) -> list[Record]:
        out = []
        for _ in range(n):
            t, vis, true_link = next(self.ticks)
            channel = self.v.measure(true_link, vis["elevation_deg"])
            decoded = bool(self.rng.random() >= frame_error_rate(channel["snr_db"]))
            measured = self._receive(channel, true_link, "TRAINING")
            out.append(
                Record(
                    t,
                    vis["elevation_deg"],
                    "NONE",
                    measured,
                    true_link,
                    None,
                    split="train",
                    extra={"decoded": decoded},
                )
            )
        return out

    def _with_evm(self, link: dict, interference_db: float | None = None) -> dict:
        """The EVM the receiver reads off the constellation: set by the SNR, and by the
        signal-to-interference ratio when a second carrier shares the channel."""
        sinr = 10.0 ** (link["snr_db"] / 10.0)
        if interference_db is not None:
            sinr = 1.0 / (1.0 / sinr + 10.0 ** (-interference_db / 10.0))
        evm = evm_from_snr(10.0 * math.log10(sinr))
        link["evm_pct"] = evm * (1.0 + EVM_SPREAD * float(self.rng.normal()))
        return link

    def record(self, attack: str, k: int, jam_to_noise_db: float | None = None) -> Record:
        v = self.v
        t, vis, true_link = next(self.ticks)
        el = vis["elevation_deg"]
        sealed = v.crypto.seal_packet(
            v.framer.build_telemetry_packet(v.sequence % SEQUENCE_MODULO, v.telemetry_payload(t), t)
        )
        v.sequence += 1
        measured = v.measure(true_link, el)
        if attack == "NONE":
            self.recorded.append((t, sealed, dict(measured)))
        channel, pkt = self._attack(attack, k, t, measured, sealed, jam_to_noise_db)
        # The decoder: below its threshold the frame is lost, never delivered corrupted.
        if self.rng.random() < frame_error_rate(channel["snr_db"]):
            pkt = None
        interferer = None
        if attack == "CO_CHANNEL_CAPTURE":
            # The genuine carrier is still on the channel, 6 dB under the captor.
            interferer = {
                "below_db": CAPTURE_EXCESS_DB,
                "offset_hz": channel["doppler_shift_hz"] - measured["doppler_shift_hz"],
            }
        link = self._receive(channel, true_link, attack, interferer, k)
        extra = {"snr_loss_db": float(measured["snr_db"] - channel["snr_db"])}
        return Record(t, el, attack, link, true_link, pkt, extra=extra)

    def _receive(self, channel, predicted, label, interferer=None, k: int = 0) -> dict:
        """What the station measures of what reached the antenna."""
        if self.iq is None:
            return self._with_evm(
                dict(channel), None if interferer is None else interferer["below_db"]
            )
        link = self.iq.measure(channel, predicted, interferer)
        wanted = label == "NONE" or k == CONSTELLATION_FRAME
        if wanted and label != "TRAINING" and label not in self.constellations:
            z = self.iq.last_constellation[-CONSTELLATION_POINTS:]
            self.constellations[label] = [
                [round(float(v.real), 4), round(float(v.imag), 4)] for v in z
            ]
        return link

    def _attack(self, attack, k, t, measured, sealed, jam_to_noise_db):
        link = dict(measured)
        pkt = sealed
        if attack == "FREQUENCY_HIJACKING":
            # A rogue carrier 14.2 MHz up, sweeping, louder; its frames under its own key.
            link["doppler_shift_hz"] += HIJACK_OFFSET_HZ + HIJACK_SWEEP_HZ * math.sin(0.9 * k)
            link["rssi_dbm"] += HIJACK_EXCESS_DB
            link["snr_db"] += HIJACK_EXCESS_DB
            pkt = self.attacker.seal_packet(_unsealed(sealed))
        elif attack == "STEALTH_SPOOFING":
            # Node 0x99A2 on the Doppler track, 3.2 dB low, reusing recent sequence counts.
            link["doppler_shift_hz"] += float(
                self.rng.uniform(-SPOOF_DOPPLER_ERROR_HZ, SPOOF_DOPPLER_ERROR_HZ)
            )
            link["rssi_dbm"] -= SPOOF_POWER_DROP_DB
            link["snr_db"] -= SPOOF_POWER_DROP_DB
            forged = _unsealed(sealed)
            forged["payload"] = {**forged["payload"], "hw_token": ROGUE_NODE_TOKEN}
            forged["ccsds_header"] = {
                **forged["ccsds_header"],
                "sequence_count": (
                    forged["ccsds_header"]["sequence_count"] - int(self.rng.integers(1, 21))
                )
                % SEQUENCE_MODULO,
            }
            pkt = self.attacker.seal_packet(self.v.framer.rebuild(forged))
        elif attack == "NOISE_JAMMING" or jam_to_noise_db is not None:
            jn = JAM_TO_NOISE_DB if jam_to_noise_db is None else jam_to_noise_db
            loss = snr_loss_db(jn)
            link["snr_db"] -= loss
            if attack == "NOISE_JAMMING":
                # The front end saturates: the carrier power estimate collapses. Where the
                # SNR left is below the decoder's threshold the carrier loop loses lock too.
                link["rssi_dbm"] = JAMMED_POWER_DBM + float(self.rng.uniform(-0.5, 0.5))
                if frame_error_rate(link["snr_db"]) > 0.5:
                    link["doppler_shift_hz"] += float(self.rng.normal(0.0, JAM_LOCK_LOSS_HZ))
            else:
                # Below the gate: the carrier power estimate (noise floor + SNR) dips by the loss.
                link["rssi_dbm"] -= loss
        elif attack == "DATA_TAMPERING":
            # One payload bit flipped by a relay after the satellite sealed the frame.
            pkt = copy.deepcopy(sealed)
            mode = pkt["payload"]["mode"]
            pkt["payload"]["mode"] = chr(ord(mode[0]) ^ 1) + mode[1:]
        elif attack == "RELAY":
            link, pkt = self.injector.inject_threat(link, sealed, "DELAY_SPOOFING_MEACONING")
        elif attack == "PHASE_SLIP":
            link, pkt = self.injector.inject_threat(link, sealed, "COHERENT_PHASE_SLIP")
        elif attack == "INJECTION":
            link, pkt = self.injector.inject_threat(link, sealed, "CCSDS_SEQUENCE_HIJACK")
        elif attack == "REPLAY":
            # A genuine frame recorded 1 to 3 minutes earlier, sent again with its recorded RF.
            old = [r for r in self.recorded if REPLAY_AGE_S[0] <= t - r[0] <= REPLAY_AGE_S[1]]
            _, pkt, recorded_link = (
                old[int(self.rng.integers(len(old)))] if old else self.recorded[0]
            )
            link = dict(recorded_link)
        elif attack == "DELAY":
            # Genuine frames held back 80 ms and released late: the timing says 24,000 km more.
            link["slant_range_km"] += DELAY_S * SPEED_OF_LIGHT_KM_S
            link["light_time_us"] += DELAY_S * 1e6
        elif attack == "CO_CHANNEL_CAPTURE":
            # A louder transmitter on the channel captures the receiver a few kHz off the
            # Doppler track, sending telemetry it forged without the key.
            link["doppler_shift_hz"] += CAPTURE_OFFSET_HZ + float(self.rng.uniform(-500.0, 500.0))
            link["rssi_dbm"] += CAPTURE_EXCESS_DB
            link["snr_db"] += CAPTURE_EXCESS_DB
            forged = _unsealed(sealed)
            forged["payload"] = {**forged["payload"], "mode": "SAFE_HOLD"}
            pkt = self.attacker.seal_packet(self.v.framer.rebuild(forged))
        return link, pkt

    def uplink(self, threat: str, n: int) -> dict:
        """n telecommands under `threat`; the spacecraft checks the tag, then the count."""
        v = self.v
        onboard = SequenceFreshness()
        executed = rejected = 0
        recorded = []
        for _ in range(n):
            t = self.clock
            self.clock += 1.0
            command = {"opcode": "SET_MODE", "mode": "IMAGING"}
            genuine = v.crypto.seal_packet(
                v.framer.build_telecommand_packet(v.uplink_sequence % SEQUENCE_MODULO, command, t)
            )
            v.uplink_sequence += 1
            # The genuine command goes through first, as on a real pass.
            if v.crypto.verify_packet_integrity(genuine)["integrity_passed"]:
                onboard.accept(genuine["ccsds_header"]["sequence_count"])
            recorded.append(genuine)
            if threat in ("COMMAND_TAMPERING", "COMMAND_INJECTION"):
                received = v.injector.inject_uplink_threat(genuine, threat)
            else:
                received = recorded[int(self.rng.integers(len(recorded)))]
            ok = v.crypto.verify_packet_integrity(received)["integrity_passed"]
            count = received["ccsds_header"]["sequence_count"]
            if ok and onboard.fresh(count):
                onboard.accept(count)
                executed += 1
            else:
                rejected += 1
        return {"commands": n, "executed": executed, "rejected": rejected}


def _unsealed(sealed: dict) -> dict:
    return {
        k: v for k, v in copy.deepcopy(sealed).items() if k not in ("sha256_hash", "hmac_sha256")
    }


# ---------------------------------------------------------------------- counting


def _empty() -> dict:
    return {
        "n": 0,
        **dict.fromkeys(TIERS, 0),
        "stat_and_phys": 0,
        "burst": 0,
        "chi_square": 0,
        "kinematic": 0,
        "decoded": 0,
        "verified": 0,
        "rekey": 0,
        "snr_loss_db": 0.0,
        **dict.fromkeys(OUTCOMES, 0),
        # Ablation: packets that would reach the analyst unflagged with one tier removed.
        "unflagged_without": dict.fromkeys(TIERS, 0),
        "scores": {"forest": [], "chi": []},
    }


def _count(c: dict, r: dict) -> None:
    f: TierFlags = r["flags"]
    c["n"] += 1
    for tier in TIERS:
        c[tier] += getattr(f, tier)
    c["stat_and_phys"] += f.statistical and f.physical
    c["burst"] += r["burst"]
    c["chi_square"] += r["chi_square"]
    c["kinematic"] += r["kinematic"]
    c["decoded"] += r["decoded"]
    c["verified"] += r["verified"]
    c["rekey"] += f.key_holder
    c["snr_loss_db"] += r["snr_loss_db"]
    c[r["outcome"]] += 1
    for tier in TIERS:
        ablated = replace(f, **{tier: False}, **({"auth_failure": False} if tier == "data" else {}))
        outcome, _ = decide(ablated, r["burst"] and tier != "data")
        c["unflagged_without"][tier] += outcome == "DELIVERED"
    c["scores"]["forest"].append(r["forest_score"])
    c["scores"]["chi"].append(r["chi_ratio"])


def roc_points(negatives: list[float], positives: list[float], n: int = 80) -> list[list[float]]:
    """(false-alarm rate, detection rate) at n thresholds spread over the scores' quantiles."""
    neg, pos = np.sort(negatives), np.sort(positives)
    both = np.concatenate([neg, pos])
    thresholds = np.unique(np.quantile(both, np.linspace(0.0, 1.0, n)))
    points = [[1.0, 1.0]]
    for th in thresholds:
        fpr = 1.0 - np.searchsorted(neg, th, side="right") / len(neg)
        tpr = 1.0 - np.searchsorted(pos, th, side="right") / len(pos)
        points.append([round(float(fpr), 6), round(float(tpr), 6)])
    points.append([0.0, 0.0])
    return points


def _finish(counts: dict) -> dict:
    """AUC and ROC points of each score, attack against clean, then the raw scores go."""
    clean = counts["NONE"]["scores"]
    for name, c in counts.items():
        if name not in ("NONE", HOLDOVER) and c["n"]:
            c["auc"] = {key: auc(clean[key], c["scores"][key]) for key in ("forest", "chi")}
            c["roc"] = {key: roc_points(clean[key], c["scores"][key]) for key in ("forest", "chi")}
    for c in counts.values():
        del c["scores"]
    return counts


# ---------------------------------------------------------------------- one seed


def calibrate_sigmas(train: list[Record], engine: PhysicsSecurityEngine) -> dict:
    """One-sigma spread of each chi-square residual on clean frames, referred to high elevation."""
    return {
        name: math.sqrt(
            statistics.fmean(
                (float(r.link[name]) - float(r.predicted[name])) ** 2
                / elevation_spread_factor(r.elevation_deg)
                for r in train
            )
        )
        for name in engine.sigmas
    }


def _training_rows(train: list[Record]) -> list[tuple]:
    return [(r.t, r.link, r.predicted, r.extra.get("decoded", True)) for r in train]


def run_seed(
    seed: int,
    n_train: int = 3000,
    n_nominal: int = 12000,
    bursts: int = 50,
    burst_len: int = 30,
    uplink_commands: int = 50,
    export_path: str | None = None,
    receiver: str = "model",
) -> dict:
    source = TwinSource(seed, receiver)
    train = source.training(n_train)
    if receiver == "iq":
        # The sample-level receiver adds its own estimation noise: the chi-square's spreads
        # are measured on the training frames, clean traffic only.
        source.v.physics_engine.sigmas = calibrate_sigmas(train, source.v.physics_engine)
    forest = SiteFrameForest().fit(_training_rows(train))
    station = Station(source.v.crypto, source.v.physics_engine, forest)
    exported: list[Record] | None = list(train) if export_path else None

    counts = {m: _empty() for m in ("NONE", HOLDOVER, *ATTACKS, *EVASION)}
    first_flag: dict[str, list[int]] = {m: [] for m in ATTACKS}
    times: list[float] = []
    since_attack = [RATE_WINDOW]

    def one(rec: Record) -> dict:
        r = station.judge(rec)
        if rec.label == "NONE":
            _count(counts[HOLDOVER if since_attack[0] < RATE_WINDOW else "NONE"], r)
            since_attack[0] += 1
        else:
            _count(counts[rec.label], r)
            since_attack[0] = 0
        times.append(r["ms"])
        if exported is not None:
            exported.append(rec)
        return r

    per_gap = n_nominal // (bursts * len(ATTACKS))
    for _ in range(bursts):
        for attack in ATTACKS:
            for _ in range(per_gap):
                one(source.record("NONE", 0))
            flagged_at = None
            for k in range(burst_len):
                r = one(source.record(attack, k))
                if flagged_at is None and r["outcome"] != "DELIVERED":
                    flagged_at = k + 1
            first_flag[attack].append(flagged_at or burst_len + 1)

    for name, jn in EVASION.items():
        for _ in range(bursts):
            for _ in range(per_gap):
                one(source.record("NONE", 0))
            for k in range(burst_len):
                one(source.record(name, k, jam_to_noise_db=jn))

    if export_path:
        header = {
            "satellite": source.tle["sat_name"],
            "tle": [source.tle["line1"], source.tle["line2"]],
            "tle_sha256": source.tle["sha256"],
            "seed": seed,
            "hmac_key_hex": source.v.crypto.secret_key.hex(),
            "hw_token": SAT_TOKEN,
            "range_jerk_bound_km_s3": source.v.physics_engine.range_jerk_bound_km_s3,
            "note": "synthetic run of digital_twin.evaluate, for the adapter's test",
        }
        write_records(export_path, header, exported)

    uplink = {threat: source.uplink(threat, uplink_commands) for threat in UPLINK}
    return {
        "seed": seed,
        "receiver": receiver,
        "chi_square_sigmas": dict(source.v.physics_engine.sigmas),
        "constellations": source.constellations,
        "counts": _finish(counts),
        "packets_to_first_flag": {m: statistics.mean(v) for m, v in first_flag.items()},
        "packet_ms": {"mean": statistics.mean(times), "p95": statistics.quantiles(times, n=20)[18]},
        "uplink": uplink,
        "python_rss_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
    }


# ---------------------------------------------------------------------- a dataset file


def run_dataset(path: str, key_hex: str | None = None) -> dict:
    """The same tiers and rule on a dataset file (datasets.py): the official data's entry point."""
    logging.disable(logging.CRITICAL)
    header, stream = read_records(path)
    key = key_hex or header.get("hmac_key_hex") or os.environ.get(KEY_ENV)
    if not key:
        raise SystemExit(f"{path}: give the HMAC key with --key-hex or {KEY_ENV}")
    records = list(stream)
    tle = parse_tle("\n".join(header["tle"])) if header.get("tle") else EphemerisLoader().builtin()
    if header.get("tle_sha256") and header["tle_sha256"] != tle["sha256"]:
        raise SystemExit(f"{path}: the element set does not match its recorded SHA-256")
    validator = None
    if any(r.predicted is None for r in records):
        # The prediction the station would make: SGP4 and the link budget at each time.
        validator = MasterTelemetryValidator(tle=tle, training_passes=1)
        for r in records:
            if r.predicted is None:
                r.predicted = validator.true_link(r.t)[1]
    bound = header.get("range_jerk_bound_km_s3")
    if bound is None:
        bound = (
            validator.physics_engine.range_jerk_bound_km_s3
            if validator
            else DEFAULT_RANGE_JERK_BOUND_KM_S3
        )
    train = [r for r in records if r.split == "train"]
    if len(train) < 50:
        raise SystemExit(f"{path}: needs at least 50 records with split 'train'")
    forest = SiteFrameForest().fit(_training_rows(train))
    station = Station(
        CryptoIntegrityVerifier(bytes.fromhex(key)),
        PhysicsSecurityEngine(range_jerk_bound_km_s3=float(bound)),
        forest,
        token=header.get("hw_token", SAT_TOKEN),
    )
    counts: dict[str, dict] = {}
    times = []
    since_attack = RATE_WINDOW
    for rec in records:
        if rec.split == "train":
            continue
        r = station.judge(rec)
        name = rec.label
        if name == "NONE":
            name = HOLDOVER if since_attack < RATE_WINDOW else "NONE"
            since_attack += 1
        else:
            since_attack = 0
        _count(counts.setdefault(name, _empty()), r)
        times.append(r["ms"])
    counts.setdefault("NONE", _empty())
    return {
        "seed": header.get("seed", "dataset"),
        "dataset": path,
        "counts": _finish(counts),
        "packet_ms": {"mean": statistics.mean(times), "p95": statistics.quantiles(times, n=20)[18]},
        "python_rss_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
    }


# ---------------------------------------------------------------------- the summary


def _pct(v: float) -> str:
    return f"{100 * v:.1f}%"


def _span(values: list[float]) -> str:
    lo, hi = min(values), max(values)
    return _pct(lo) if abs(hi - lo) < 5e-4 else f"{_pct(lo)}–{_pct(hi)}"


def pooled(results: list[dict], name: str, key: str) -> tuple[int, int]:
    rows = [r["counts"][name] for r in results if name in r["counts"]]
    return sum(c[key] for c in rows), sum(c["n"] for c in rows)


def print_summary(results: list[dict]) -> None:
    names = [n for n in ("NONE", HOLDOVER, *ATTACKS, *EVASION) if n in results[0]["counts"]]
    names += sorted(set(results[0]["counts"]) - set(names))
    print(f"seeds {[r['seed'] for r in results]}")
    head = f"{'traffic':24}{'pkts/seed':>10}{'data':>14}{'stat':>14}{'phys':>14}"
    print(head + "".join(f"{o.lower():>15}" for o in OUTCOMES))
    for name in names:
        rows = [r["counts"][name] for r in results]
        line = f"{name:24}{rows[0]['n']:>10}"
        for key in (*TIERS, *OUTCOMES):
            width = 14 if key in TIERS else 15
            line += f"{_span([c[key] / max(c['n'], 1) for c in rows]):>{width}}"
        print(line)

    print("\npooled over the seeds, with 95 % Wilson intervals:")
    k, n = pooled(results, "NONE", "DELIVERED")
    lo, hi = wilson_interval(k, n)
    print(f"  genuine delivered clean {k}/{n} = {_pct(k / n)} [{_pct(lo)}, {_pct(hi)}]")
    for outcome in OUTCOMES[1:]:
        k, n = pooled(results, "NONE", outcome)
        lo, hi = wilson_interval(k, n)
        print(f"  genuine {outcome.lower():12} {k}/{n} = {k / n:.2e} [{lo:.2e}, {hi:.2e}]")
    attack_names = [a for a in ATTACKS if a in results[0]["counts"]]
    if attack_names:
        flagged = sum(
            pooled(results, a, "n")[1] - pooled(results, a, "DELIVERED")[0] for a in attack_names
        )
        total = sum(pooled(results, a, "n")[1] for a in attack_names)
        lo, hi = wilson_interval(flagged, total)
        rate = _pct(flagged / total)
        print(f"  attack packets flagged {flagged}/{total} = {rate} [{_pct(lo)}, {_pct(hi)}]")
        unflagged_to_analyst = total - flagged
        _, hi = wilson_interval(unflagged_to_analyst, total)
        print(f"  attack packets reaching the analyst unflagged: {unflagged_to_analyst}", end="")
        print(f" (≤ {hi:.2e} at 95 %)")
    k, n = pooled(results, HOLDOVER, "DELIVERED")
    if n:
        print(f"  genuine within {RATE_WINDOW} slots after an attack frame: {n - k}/{n} flagged")
    print("  re-keys (valid tag from a key holder):", end="")
    for name in names:
        print(f" {name} {sum(r['counts'][name]['rekey'] for r in results)}", end="")
    print()
    k, n = pooled(results, "NONE", "chi_square")
    print(
        f"  chi-square fired on {k} of {n} held-out genuine packets ({k / n:.1e}; 1e-4 by design)"
    )
    both, n = pooled(results, "NONE", "stat_and_phys")
    s, _ = pooled(results, "NONE", "statistical")
    p, _ = pooled(results, "NONE", "physical")
    phi = _phi(both, s, p, n)
    print(f"  genuine: statistical {s}, physical {p}, both {both}; correlation phi = {phi:.3f}")

    print("\nablation: attack packets reaching the analyst unflagged with one tier removed")
    print(f"{'traffic':24}" + "".join(f"{'no ' + t:>16}" for t in TIERS))
    scored = [n for n in names if n not in ("NONE", HOLDOVER)]
    for name in scored:
        line = f"{name:24}"
        for tier in TIERS:
            k = sum(r["counts"][name]["unflagged_without"][tier] for r in results)
            n = sum(r["counts"][name]["n"] for r in results)
            line += f"{_pct(k / n):>16}"
        print(line)

    print("\nROC area, attack against clean (mean over seeds):")
    print(f"{'traffic':24}{'forest':>10}{'chi-square':>12}")
    for name in scored:
        f = statistics.mean(r["counts"][name]["auc"]["forest"] for r in results)
        c = statistics.mean(r["counts"][name]["auc"]["chi"] for r in results)
        print(f"{name:24}{f:>10.3f}{c:>12.3f}")

    for name in EVASION:
        if name not in results[0]["counts"]:
            continue
        rows = [r["counts"][name] for r in results]
        n = sum(c["n"] for c in rows)
        loss = sum(c["snr_loss_db"] for c in rows) / n
        verified = sum(c["verified"] for c in rows) / n
        reach = sum(c["DELIVERED"] + c["DEGRADED"] for c in rows) / n
        print(
            f"{name}: J/N {EVASION[name]} dB, SNR loss {loss:.2f} dB, frames verified "
            f"{_pct(verified)}, reaching the analyst {_pct(reach)}"
        )
    if "packets_to_first_flag" in results[0]:
        print("packets to the first flag:")
        for name in ATTACKS:
            mean = statistics.mean(r["packets_to_first_flag"][name] for r in results)
            print(f"  {name:22}{mean:.2f}")
    ms = [r["packet_ms"]["mean"] for r in results]
    p95 = [r["packet_ms"]["p95"] for r in results]
    print(f"per-packet time: mean {min(ms):.1f}–{max(ms):.1f} ms, p95 ≤ {max(p95):.1f} ms")
    if "uplink" in results[0]:
        for threat in UPLINK:
            executed = sum(r["uplink"][threat]["executed"] for r in results)
            commands = sum(r["uplink"][threat]["commands"] for r in results)
            print(f"uplink {threat:20} {executed}/{commands} executed")
    print(f"Python peak RSS: {max(r['python_rss_mb'] for r in results):.0f} MB")


def _phi(both: int, a: int, b: int, n: int) -> float:
    """Phi coefficient of two binary flags from their counts."""
    denom = math.sqrt(a * (n - a) * b * (n - b))
    return (both * n - a * b) / denom if denom else 0.0


def _plain(value):
    """numpy scalars as plain numbers, for the JSON file."""
    if isinstance(value, np.generic):
        return value.item()
    raise TypeError(f"{type(value).__name__} is not JSON serialisable")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[3])
    parser.add_argument("--seeds", type=int, nargs="+", default=[1, 2, 3, 4, 5, 6])
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--json", help="write every seed's counts to this file")
    parser.add_argument(
        "--dataset",
        choices=("synthetic", "official"),
        default="synthetic",
        help="synthetic: the twin's seeded traffic; official: a dataset file (--path)",
    )
    parser.add_argument("--path", help="dataset file in the datasets.py format")
    parser.add_argument("--key-hex", help="HMAC key of the dataset, hex (else its header or env)")
    parser.add_argument("--export", help="write the first seed's synthetic run as a dataset file")
    parser.add_argument(
        "--receiver",
        choices=RECEIVERS,
        default="model",
        help="model: noise added to the link figures; iq: QPSK samples through a modem",
    )
    args = parser.parse_args()

    if args.dataset == "official":
        if not args.path:
            parser.error("--dataset official needs --path")
        results = [run_dataset(args.path, args.key_hex)]
    elif args.export:
        results = [run_seed(args.seeds[0], export_path=args.export, receiver=args.receiver)]
    elif args.workers > 1:
        with ProcessPoolExecutor(args.workers) as pool:
            results = list(pool.map(partial(run_seed, receiver=args.receiver), args.seeds))
    else:
        results = [run_seed(seed, receiver=args.receiver) for seed in args.seeds]
    if args.json:
        with open(args.json, "w") as out:
            json.dump(results, out, indent=1, default=_plain)
    print_summary(results)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
