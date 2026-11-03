"""Clean satellite-to-station traffic for one pass.

Each frame is sealed by the spacecraft with real AES-GCM, then given the physical-layer
measurements the station's receiver would record when it arrives: arrival time, received
power, signal-to-noise ratio and measured Doppler.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np

from .channel import PassGeometry
from .security import LinkProtector


@dataclass(frozen=True)
class Reception:
    """One burst as the station's receiver records it."""

    wire: bytes
    arrival_s: float
    rssi_dbm: float
    snr_db: float
    doppler_hz: float
    label: str = "clean"

    def with_changes(self, **changes) -> Reception:
        return replace(self, **changes)


@dataclass(frozen=True)
class LinkConfig:
    frame_rate_hz: float = 10.0
    payload_bytes: int = 64
    processing_delay_s: float = 0.002
    processing_jitter_s: float = 0.0002
    rssi_noise_db: float = 1.0
    doppler_noise_hz: float = 20.0
    spacecraft_id: int = 0x2A
    seed: int = 0


def simulate_pass(
    key: bytes,
    geometry: PassGeometry | None = None,
    config: LinkConfig | None = None,
) -> list[Reception]:
    geometry = geometry or PassGeometry()
    config = config or LinkConfig()
    rng = np.random.default_rng(config.seed)
    protector = LinkProtector(key, spacecraft_id=config.spacecraft_id)

    transmit_times = np.arange(0.0, geometry.duration_s, 1.0 / config.frame_rate_hz)
    n = transmit_times.size

    arrivals = (
        transmit_times
        + geometry.light_time_s(transmit_times)
        + config.processing_delay_s
        + rng.normal(0.0, config.processing_jitter_s, n)
    )
    rssi = geometry.rssi_dbm(transmit_times) + rng.normal(0.0, config.rssi_noise_db, n)
    doppler = geometry.doppler_hz(transmit_times) + rng.normal(0.0, config.doppler_noise_hz, n)

    receptions = []
    for sequence, t in enumerate(transmit_times):
        wire = protector.protect(sequence, float(t), rng.bytes(config.payload_bytes))
        receptions.append(
            Reception(
                wire=wire,
                arrival_s=float(arrivals[sequence]),
                rssi_dbm=float(rssi[sequence]),
                snr_db=float(rssi[sequence] - geometry.noise_floor_dbm),
                doppler_hz=float(doppler[sequence]),
            )
        )
    return receptions
