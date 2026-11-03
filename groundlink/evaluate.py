"""Scoring for detector runs: detection quality, false alarms and latency."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class DetectionMetrics:
    """Operating-point and ranking metrics for one run."""

    probability_of_detection: float
    false_alarm_rate: float
    detection_latency_epochs: float
    roc_auc: float

    def as_row(self) -> dict[str, float]:
        return {
            "Pd": round(self.probability_of_detection, 4),
            "Pfa": round(self.false_alarm_rate, 4),
            "latency_epochs": self.detection_latency_epochs,
            "roc_auc": round(self.roc_auc, 4),
        }


def roc_auc(scores: np.ndarray, labels: np.ndarray) -> float:
    """Rank-based AUC; ties share the average rank."""
    positives = labels == 1
    n_pos = int(positives.sum())
    n_neg = int(labels.size - n_pos)
    if n_pos == 0 or n_neg == 0:
        return float("nan")

    order = np.argsort(scores, kind="mergesort")
    ranks = np.empty(scores.size, dtype=float)
    ranks[order] = np.arange(1, scores.size + 1, dtype=float)

    # Average the ranks within each group of equal scores.
    sorted_scores = scores[order]
    start = 0
    for end in range(1, scores.size + 1):
        if end == scores.size or sorted_scores[end] != sorted_scores[start]:
            ranks[order[start:end]] = ranks[order[start:end]].mean()
            start = end

    return float((ranks[positives].sum() - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg))


def detection_latency(alarms: np.ndarray, labels: np.ndarray) -> float:
    """Epochs between attack onset and the first alarm; ``inf`` if never detected."""
    attack_epochs = np.flatnonzero(labels == 1)
    if attack_epochs.size == 0:
        return float("nan")

    onset = int(attack_epochs[0])
    fired = np.flatnonzero(alarms[onset:] == 1)
    return float(fired[0]) if fired.size else float("inf")


def score_run(scores: np.ndarray, alarms: np.ndarray, labels: np.ndarray) -> DetectionMetrics:
    positives = labels == 1
    negatives = ~positives

    pd = float(alarms[positives].mean()) if positives.any() else float("nan")
    pfa = float(alarms[negatives].mean()) if negatives.any() else float("nan")

    return DetectionMetrics(
        probability_of_detection=pd,
        false_alarm_rate=pfa,
        detection_latency_epochs=detection_latency(alarms, labels),
        roc_auc=roc_auc(scores, labels),
    )
