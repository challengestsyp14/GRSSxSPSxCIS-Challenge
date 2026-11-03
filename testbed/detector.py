"""
detector.py
TSYP 14 Track 1: Secure Ground-Link Testbed
AI-Based Anomaly Detection Module using Isolation Forest & Velocity Checks

Features are residuals against the station's orbit prediction (what the RF should look like at
this point of the pass) plus their rate of change between packets. Two layers decide:
- a physics gate: a carrier offset or jump no orbit can produce, or an RSSI outside the link-
  budget band, is flagged outright. An Isolation Forest alone misses these when a single
  feature goes far past the training range, because such a point is isolated no faster than
  the most extreme training point;
- an Isolation Forest trained on nominal passes only, for everything subtler.

The ground-truth `attack_mode` label on a packet is never read here.
"""

from __future__ import annotations

import numpy as np
from sklearn.ensemble import IsolationForest

from .ingester import TelemetryIngester, predicted_link

#: Largest carrier residual (MHz) and packet-to-packet carrier step orbital motion allows.
MAX_CARRIER_RESIDUAL_MHZ = 0.5
MAX_CARRIER_STEP_MHZ = 0.5
#: Link-budget band: RSSI further than this from the prediction breaks the physics.
MAX_RSSI_RESIDUAL_DB = 4.0
HISTORY = 50


class TelemetryDetector:
    def __init__(self, contamination: float = 0.01, random_state: int = 42):
        self.model = IsolationForest(contamination=contamination, random_state=random_state)
        self.is_trained = False
        self.history: list[dict] = []

    def extract_features(self, packet: dict) -> list[float]:
        """Residuals vs the orbit prediction and their velocity (rate of change)."""
        carrier_model, rssi_model = predicted_link(packet["pass_phase"])
        freq_residual = packet["carrier_frequency_mhz"] - carrier_model
        rssi_residual = packet["rssi_dbm"] - rssi_model

        freq_velocity = 0.0
        rssi_velocity = 0.0
        if self.history:
            last = self.history[-1]
            last_carrier, last_rssi = predicted_link(last["pass_phase"])
            freq_velocity = freq_residual - (last["carrier_frequency_mhz"] - last_carrier)
            rssi_velocity = rssi_residual - (last["rssi_dbm"] - last_rssi)
        return [freq_residual, rssi_residual, freq_velocity, rssi_velocity]

    def train_baseline(self, nominal_packets: list[dict]) -> None:
        """Trains the Isolation Forest on normal operating baseline data."""
        self.history = []
        features = []
        for pkt in nominal_packets:
            features.append(self.extract_features(pkt))
            self._remember(pkt)
        self.model.fit(np.array(features))
        self.history = []
        self.is_trained = True

    def evaluate_packet(self, packet: dict) -> dict:
        """Evaluates one live packet for physical anomalies or attack signatures."""
        if not self.is_trained:
            raise RuntimeError("train_baseline() must run before evaluate_packet()")
        feats = self.extract_features(packet)
        physics = (
            abs(feats[0]) > MAX_CARRIER_RESIDUAL_MHZ
            or abs(feats[2]) > MAX_CARRIER_STEP_MHZ
            or abs(feats[1]) > MAX_RSSI_RESIDUAL_DB
        )
        # One scoring pass: score_samples is higher when more normal, and predict() is exactly
        # score_samples < offset_.
        normality = float(self.model.score_samples(np.array([feats]))[0])
        forest = normality < self.model.offset_
        anomaly = physics or forest
        return {
            "anomaly": anomaly,
            "physics_gate": physics,
            "isolation_forest": forest,
            "anomaly_score": round(-normality, 4),
            "carrier_frequency_mhz": packet["carrier_frequency_mhz"],
            "rssi_dbm": packet["rssi_dbm"],
        }

    def accept(self, packet: dict) -> None:
        """Makes an accepted packet the reference for the next velocity features.

        Only packets the whole pipeline accepted (authentic, cleared, nominal RF) become the
        reference. A spoofed frame that slips past the RF checks must not, or the next genuine
        packet would look like a jump back.
        """
        self._remember(packet)

    def _remember(self, packet: dict) -> None:
        self.history.append(packet)
        if len(self.history) > HISTORY:
            self.history.pop(0)


if __name__ == "__main__":
    ingester = TelemetryIngester(seed=14)
    detector = TelemetryDetector()
    print("Generating baseline training data...")
    detector.train_baseline([ingester.generate_packet("normal") for _ in range(1200)])
    print("[+] Telemetry Anomaly Detector trained on the nominal baseline.")
    print("\nEvaluating attack packet (Frequency Hijacking)...")
    result = detector.evaluate_packet(ingester.generate_packet("frequency_hijacking"))
    print("Detection Result:", result)
