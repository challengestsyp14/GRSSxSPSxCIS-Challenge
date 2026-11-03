"""Ground-station processing: the two defensive layers applied to every reception.

Layer 1 — cryptography: authenticate, decrypt and order the frame.
Layer 2 — link behaviour: compare what was physically received against what the orbit
predicts, producing the features the anomaly detector scores.

The layers are independent on purpose. Features are computed for every frame, including
those cryptography rejects, so each layer can be evaluated on its own.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .channel import PassGeometry
from .frames import FrameHeader
from .security import LinkVerifier, Status
from .simulate import Reception

FEATURE_NAMES = (
    "snr_db",
    "rssi_residual_db",
    "doppler_residual_hz",
    "latency_residual_ms",
    "inter_arrival_ms",
    "sequence_step",
)


@dataclass(frozen=True)
class FrameReport:
    arrival_s: float
    status: Status
    sequence: int | None
    features: np.ndarray
    label: str


class GroundStation:
    def __init__(
        self,
        key: bytes,
        geometry: PassGeometry | None = None,
        max_age_s: float = 0.5,
        processing_delay_s: float = 0.002,
    ) -> None:
        self._key = key
        self._geometry = geometry or PassGeometry()
        self._max_age_s = max_age_s
        self._processing_delay_s = processing_delay_s

    def process(self, receptions: list[Reception]) -> list[FrameReport]:
        # A fresh verifier per pass: replay state belongs to one contact, not the station.
        verifier = LinkVerifier(self._key, max_age_s=self._max_age_s)
        geometry = self._geometry

        reports = []
        previous_arrival: float | None = None
        previous_sequence: int | None = None

        for r in receptions:
            verdict = verifier.verify(r.wire, r.arrival_s)

            # The header is readable even when authentication fails; the detector uses it
            # as observed, without trusting it.
            try:
                header = verdict.header or FrameHeader.unpack(r.wire)
            except ValueError:
                header = None

            t = r.arrival_s
            if header is not None:
                sent = header.timestamp_s
                latency = t - sent - float(geometry.light_time_s(sent)) - self._processing_delay_s
                step = 1 if previous_sequence is None else header.sequence - previous_sequence
                previous_sequence = header.sequence
            else:
                latency, step = 0.0, 0

            inter_arrival = 0.1 if previous_arrival is None else t - previous_arrival
            previous_arrival = t

            features = np.array(
                [
                    r.snr_db,
                    r.rssi_dbm - float(geometry.rssi_dbm(t)),
                    r.doppler_hz - float(geometry.doppler_hz(t)),
                    latency * 1e3,
                    inter_arrival * 1e3,
                    float(step),
                ]
            )
            reports.append(
                FrameReport(
                    arrival_s=t,
                    status=verdict.status,
                    sequence=header.sequence if header else None,
                    features=features,
                    label=r.label,
                )
            )
        return reports


def feature_matrix(reports: list[FrameReport]) -> np.ndarray:
    return np.vstack([r.features for r in reports])


def labels(reports: list[FrameReport]) -> np.ndarray:
    return np.array([0 if r.label == "clean" else 1 for r in reports])


def crypto_alarms(reports: list[FrameReport]) -> np.ndarray:
    return np.array([0 if r.status is Status.OK else 1 for r in reports])
