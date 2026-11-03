"""
isolation_forest_detector.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin, phase 2: the statistical layer. An Isolation Forest scores each link
measurement against the clean passes it was trained on.

Unsupervised: it only ever sees nominal traffic and needs neither attack labels nor the
orbit model, which keeps it independent of the physics layer. From the five link
measurements it derives three relations that hold on any clean pass:
- the size of the carrier phase tracking error, near zero while the loop is locked on
  the genuine carrier;
- the received power normalised by range, RSSI + 20 log10(range), constant under the
  free-space law up to atmospheric loss and noise;
- the noise floor implied by RSSI and SNR, which only the receiver itself sets.
A meaconer's louder, longer path breaks the second and third; a phase slip, the first.
Doppler is left to the physics layer, since judging it needs the orbit. Features are
standardised so that no unit dominates the split choices.
"""

from __future__ import annotations

import logging
import math
from collections import deque

import numpy as np
from sklearn.ensemble import IsolationForest

logger = logging.getLogger("IsolationForestDetector")

#: The link measurements the detector reads.
MEASUREMENTS = (
    "slant_range_km",
    "doppler_shift_hz",
    "rssi_dbm",
    "snr_db",
    "received_phase_error_deg",
)
FEATURES = ("phase_error_magnitude_deg", "range_normalised_power_db", "noise_floor_dbm")


def derived_features(link: dict) -> list[float]:
    return [
        abs(float(link["received_phase_error_deg"])),
        float(link["rssi_dbm"]) + 20.0 * math.log10(float(link["slant_range_km"])),
        float(link["rssi_dbm"]) - float(link["snr_db"]),
    ]


class MLAnomalyDetector:
    def __init__(
        self, contamination: float = 0.01, n_estimators: int = 256, random_state: int = 42
    ):
        self.model = IsolationForest(
            n_estimators=n_estimators, contamination=contamination, random_state=random_state
        )
        self.mean: np.ndarray | None = None
        self.scale: np.ndarray | None = None

    @property
    def is_trained(self) -> bool:
        return self.mean is not None

    def _standardise(self, links) -> np.ndarray:
        return (np.array([derived_features(link) for link in links]) - self.mean) / self.scale

    def fit(self, nominal_links: list[dict]) -> MLAnomalyDetector:
        """Trains on clean link measurements only."""
        if len(nominal_links) < 50:
            raise ValueError("train on at least 50 nominal measurements")
        x = np.array([derived_features(link) for link in nominal_links])
        self.mean = x.mean(axis=0)
        spread = x.std(axis=0)
        self.scale = np.where(spread > 0, spread, 1.0)
        self.model.fit(self._standardise(nominal_links))
        logger.info("Isolation Forest trained on %d nominal measurements", len(x))
        return self

    def evaluate_packet(self, link_packet: dict) -> dict:
        if not self.is_trained:
            raise RuntimeError("train the detector on nominal passes first")
        features = self._standardise([link_packet])
        # One scoring pass: predict() is exactly decision_function() < 0.
        score = float(self.model.decision_function(features)[0])
        is_anomaly = score < 0.0
        return {
            "layer": "Statistical Layer (ML)",
            # Positive for inliers, negative for outliers; the decision threshold is zero.
            "anomaly_score": score,
            "threat_detected": is_anomaly,
            "verdict": "ML_ANOMALY_FLAGGED" if is_anomaly else "ML_NOMINAL_INLIER",
        }


#: The live site's per-frame forest (dashboard/src/sim/linkDetector.ts): its six features. None
#: of them is a residual the chi-square gate tests: the forest reads what the gate cannot see.
SITE_FEATURES = (
    "evm_residual_pct",
    "frame_loss_rate",
    "inter_arrival_jitter_us",
    "mac_failure_rate",
    "carrier_step_mhz",
    "power_step_db",
)
#: The rates look back over this many frame slots (loss) and decoded frames (MAC failures).
RATE_WINDOW = 10
#: Consecutive measurements further apart than this start a new sequence (no step, no jitter).
SITE_SEQUENCE_GAP_S = 2.0
#: Floor of the training-range check on a feature that never varied in training.
RANGE_FLOOR = (0.5, 0.05, 1.0, 0.05, 1e-4, 0.1)


def evm_from_snr(snr_db: float) -> float:
    """RMS error vector magnitude of QPSK at this SNR, per cent: 100 / sqrt(SNR)."""
    return 100.0 / math.sqrt(10.0 ** (float(snr_db) / 10.0))


def site_residuals(link: dict, predicted: dict) -> tuple[float, float]:
    """Measured carrier minus the orbit-predicted carrier (MHz), measured power minus budget."""
    return (
        (float(link["doppler_shift_hz"]) - float(predicted["doppler_shift_hz"])) / 1e6,
        float(link["rssi_dbm"]) - float(predicted["rssi_dbm"]),
    )


def _light_time_us(link: dict) -> float:
    if "light_time_us" in link:
        return float(link["light_time_us"])
    return float(link["slant_range_km"]) / 0.299792458


def arrival_offset_us(link: dict, predicted: dict) -> float:
    """When the frame arrived against when the orbit says it should have, microseconds."""
    return _light_time_us(link) - _light_time_us(predicted)


def evm_residual(link: dict, predicted: dict) -> float:
    """Measured EVM minus the EVM the link budget predicts, percentage points."""
    measured = link.get("evm_pct")
    if measured is None:
        measured = evm_from_snr(link["snr_db"])
    return float(measured) - evm_from_snr(predicted["snr_db"])


class FrameHistory:
    """What the station remembers of the frames before this one."""

    def __init__(self, window: int = RATE_WINDOW):
        self.slots: deque[bool] = deque(maxlen=window)
        self.failures: deque[bool] = deque(maxlen=window)
        self.last: tuple[float, float] | None = None

    def rates(self) -> tuple[float, float]:
        """Share of the last slots with no decoded frame; of the last decoded frames that
        failed authentication."""
        loss = sum(not d for d in self.slots) / len(self.slots) if self.slots else 0.0
        fail = sum(self.failures) / len(self.failures) if self.failures else 0.0
        return loss, fail

    def jitter_us(self, t: float, offset_us: float, decoded: bool) -> float:
        """Change of the arrival offset since the last decoded frame of this sequence."""
        if not decoded or self.last is None or t - self.last[0] > SITE_SEQUENCE_GAP_S:
            return 0.0
        return abs(offset_us - self.last[1])

    def observe(self, t: float, offset_us: float, decoded: bool, auth_failure: bool) -> None:
        if self.slots and self.last is not None and t - self.last[0] > SITE_SEQUENCE_GAP_S:
            self.slots.clear()
            self.failures.clear()
        self.slots.append(decoded)
        if decoded:
            self.failures.append(auth_failure)
            self.last = (t, offset_us)


def _average_path_length(n: np.ndarray) -> np.ndarray:
    """Mean path length of an unsuccessful search in a binary tree of n samples."""
    n = np.asarray(n, dtype=float)
    out = np.zeros_like(n)
    out[n == 2] = 1.0
    big = n > 2
    out[big] = 2.0 * (np.log(n[big] - 1.0) + np.euler_gamma) - 2.0 * (n[big] - 1.0) / n[big]
    return out


class FastForestScorer:
    """scikit-learn's IsolationForest.decision_function for one sample, all trees at once.

    The trees are walked level by level with array indexing instead of one estimator at a time:
    the same leaves, the same path lengths, the same score, about ten times faster per packet.
    """

    def __init__(self, model: IsolationForest):
        trees = [e.tree_ for e in model.estimators_]
        width = max(t.node_count for t in trees)
        n = len(trees)
        self.left = np.full((n, width), -1, dtype=np.int64)
        self.right = np.full((n, width), -1, dtype=np.int64)
        self.feature = np.zeros((n, width), dtype=np.int64)
        self.threshold = np.zeros((n, width))
        self.value = np.zeros((n, width))
        for i, (t, feats) in enumerate(zip(trees, model.estimators_features_, strict=True)):
            k = t.node_count
            self.left[i, :k] = t.children_left
            self.right[i, :k] = t.children_right
            f = np.where(t.feature >= 0, t.feature, 0)
            self.feature[i, :k] = np.asarray(feats)[f]
            self.threshold[i, :k] = t.threshold
            self.value[i, :k] = (
                t.compute_node_depths() + _average_path_length(t.n_node_samples) - 1.0
            )
        self.rows = np.arange(n)
        self.levels = max(t.max_depth for t in trees) + 1
        self.denominator = n * float(_average_path_length(np.array([model._max_samples]))[0])
        self.offset = float(model.offset_)

    def decision(self, x: list[float]) -> float:
        # The trees compare in float32, as scikit-learn does.
        x32 = np.asarray(x, dtype=np.float32).astype(float)
        node = np.zeros(len(self.rows), dtype=np.int64)
        r = self.rows
        for _ in range(self.levels):
            left = self.left[r, node]
            go_left = x32[self.feature[r, node]] <= self.threshold[r, node]
            node = np.where(left == -1, node, np.where(go_left, left, self.right[r, node]))
        depth = float(self.value[r, node].sum())
        return -(2.0 ** (-depth / self.denominator)) - self.offset


class SiteFrameForest:
    """The site's per-frame statistical tier, re-implemented with the same features and settings.

    Six features, none of them a residual the chi-square gate tests: the EVM against the link
    budget's, the frame-loss rate over the last 10 slots, the jitter of the arrival time since
    the last decoded frame, the MAC and nonce failure rate over the last 10 decoded frames, and
    the change of the carrier and power residuals since the last packet the whole pipeline
    delivered. 256 trees of 256 samples each, trained on 3,000 nominal frames, flagging at the
    1 % contamination point of the training scores, as linkDetector.ts does in the browser.

    An Isolation Forest cannot split on a feature that never varied in training (no MAC failure
    ever happens on a clean pass), so the tier also flags any feature beyond the largest value
    it saw in training: the training-range check.
    """

    def __init__(
        self, contamination: float = 0.01, n_estimators: int = 256, random_state: int = 42
    ):
        self.model = IsolationForest(
            n_estimators=n_estimators,
            max_samples=256,
            contamination=contamination,
            random_state=random_state,
        )
        self.reference: tuple[float, float] | None = None
        self.history = FrameHistory()
        self.caps: np.ndarray | None = None
        self.trained = False

    def _row(self, t, link, predicted, decoded, ref, history) -> list[float]:
        r = site_residuals(link, predicted)
        loss, fail = history.rates()
        return [
            evm_residual(link, predicted),
            loss,
            history.jitter_us(t, arrival_offset_us(link, predicted), decoded),
            fail,
            r[0] - ref[0] if ref else 0.0,
            r[1] - ref[1] if ref else 0.0,
        ]

    def fit(self, measurements: list[tuple]) -> SiteFrameForest:
        """Trains on (time, measured link, predicted link[, decoded]) of consecutive nominal
        frames; every one of them counts as delivered."""
        rows, ref, last_t, history = [], None, None, FrameHistory()
        for m in measurements:
            t, link, predicted = m[:3]
            decoded = m[3] if len(m) > 3 else True
            if last_t is not None and t - last_t > SITE_SEQUENCE_GAP_S:
                ref = None
            rows.append(self._row(t, link, predicted, decoded, ref, history))
            history.observe(t, arrival_offset_us(link, predicted), decoded, False)
            if decoded:
                ref = site_residuals(link, predicted)
            last_t = t
        x = np.array(rows)
        self.model.fit(x)
        self.scorer = FastForestScorer(self.model)
        self.caps = np.maximum(np.abs(x).max(axis=0), RANGE_FLOOR)
        self.trained = True
        return self

    def features(self, t: float, link: dict, predicted: dict, decoded: bool = True) -> list[float]:
        return self._row(t, link, predicted, decoded, self.reference, self.history)

    def evaluate(self, t: float, link: dict, predicted: dict, decoded: bool = True) -> dict:
        if not self.trained:
            raise RuntimeError("train the forest on nominal frames first")
        x = self.features(t, link, predicted, decoded)
        score = self.scorer.decision(x)
        beyond = [
            name for name, v, cap in zip(SITE_FEATURES, x, self.caps, strict=True) if abs(v) > cap
        ]
        return {
            "features": dict(zip(SITE_FEATURES, x, strict=True)),
            "anomaly_score": score,
            "beyond_training_range": beyond,
            "threat_detected": score < 0.0 or bool(beyond),
        }

    def observe(self, t: float, link: dict, predicted: dict, decoded: bool, auth_failure: bool):
        """Every frame slot updates the history, whatever the decision."""
        self.history.observe(t, arrival_offset_us(link, predicted), decoded, auth_failure)

    def accept(self, link: dict, predicted: dict) -> None:
        """Only packets the whole pipeline delivered become the reference for the steps."""
        self.reference = site_residuals(link, predicted)
