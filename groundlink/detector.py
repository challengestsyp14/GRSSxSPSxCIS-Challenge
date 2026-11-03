"""Link-behaviour anomaly detector.

Trained on clean passes only. That matches operations: a station has hours of normal
contacts and almost no labelled attacks, so the model learns what a healthy link looks like
and flags departures from it.

Two scorers are combined, because each covers the other's blind spot:

- **Isolation Forest** catches *joint* anomalies — several features each slightly off in a
  combination never seen in clean traffic.
- **Robust per-feature gate** (largest median/IQR deviation) catches a *single* feature far
  outside its normal range. Isolation Forest cannot: a value beyond the training range is
  isolated no faster than the most extreme training point, so its score saturates. A delay
  attack that moves latency alone and leaves every other feature normal sits exactly there.

Each score is normalised by its own clean-calibration quantile, the two are merged with a
max, and the final threshold is set on a *separate* clean pass against the stated target
false-alarm rate — so the reported rate is measured on data the model never trained on.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import RobustScaler

from .station import FEATURE_NAMES


@dataclass
class LinkAnomalyDetector:
    target_pfa: float = 0.01
    n_estimators: int = 200
    seed: int = 0
    threshold: float = float("nan")
    _scaler: RobustScaler | None = field(default=None, repr=False)
    _forest: IsolationForest | None = field(default=None, repr=False)
    _forest_norm: float = field(default=float("nan"), repr=False)
    _gate_norm: float = field(default=float("nan"), repr=False)

    def fit(self, clean_train: np.ndarray, clean_calibration: np.ndarray) -> LinkAnomalyDetector:
        if not 0.0 < self.target_pfa < 1.0:
            raise ValueError("target_pfa must lie strictly between 0 and 1")

        self._scaler = RobustScaler().fit(clean_train)
        self._forest = IsolationForest(n_estimators=self.n_estimators, random_state=self.seed).fit(
            self._scaler.transform(clean_train)
        )

        level = 1.0 - self.target_pfa
        forest, gate = self._raw_scores(clean_calibration)
        self._forest_norm = float(np.quantile(forest, level))
        self._gate_norm = float(np.quantile(gate, level))
        self.threshold = float(np.quantile(self.score(clean_calibration), level))
        return self

    def _scaled(self, features: np.ndarray) -> np.ndarray:
        if self._scaler is None or self._forest is None:
            raise RuntimeError("fit the detector before scoring")
        return self._scaler.transform(features)

    def _raw_scores(self, features: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        scaled = self._scaled(features)
        forest = -self._forest.score_samples(scaled)
        gate = np.abs(scaled).max(axis=1)
        return forest, gate

    def score(self, features: np.ndarray) -> np.ndarray:
        """Anomaly score — higher means less like the clean link."""
        forest, gate = self._raw_scores(features)
        return np.maximum(forest / self._forest_norm, gate / self._gate_norm)

    def alarms(self, features: np.ndarray) -> np.ndarray:
        return (self.score(features) >= self.threshold).astype(int)

    def explain(self, row: np.ndarray) -> str:
        """Name the feature furthest from normal, in robust units."""
        scaled = self._scaled(row.reshape(1, -1))[0]
        return FEATURE_NAMES[int(np.argmax(np.abs(scaled)))]
