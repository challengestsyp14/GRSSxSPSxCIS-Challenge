"""Geometry and RF behaviour of a single low-Earth-orbit pass over the station.

The station knows the orbit from published ephemeris, so it can *predict* what the link
should look like at every instant — range, light time, Doppler and received power. The
simulator uses the same model as ground truth. Attacks show up as departures from that
prediction, which is what makes a genuine-but-forwarded or delayed frame detectable even
when its cryptography is perfect.

Flat-Earth pass geometry is used: adequate for a single pass, and replaceable by a real
propagator without changing any caller.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

SPEED_OF_LIGHT_KM_S = 299_792.458


@dataclass(frozen=True)
class PassGeometry:
    altitude_km: float = 514.0  # TerraSAR-X
    ground_speed_km_s: float = 7.6
    duration_s: float = 600.0
    carrier_hz: float = 2.2e9  # S-band downlink
    rssi_zenith_dbm: float = -90.0
    noise_floor_dbm: float = -110.0

    @property
    def closest_approach_s(self) -> float:
        return self.duration_s / 2.0

    def range_km(self, t: np.ndarray | float) -> np.ndarray:
        along_track = self.ground_speed_km_s * (np.asarray(t) - self.closest_approach_s)
        return np.hypot(self.altitude_km, along_track)

    def range_rate_km_s(self, t: np.ndarray | float) -> np.ndarray:
        offset = np.asarray(t) - self.closest_approach_s
        return self.ground_speed_km_s**2 * offset / self.range_km(t)

    def doppler_hz(self, t: np.ndarray | float) -> np.ndarray:
        # Approaching satellite (negative range rate) shifts the carrier up.
        return -self.carrier_hz * self.range_rate_km_s(t) / SPEED_OF_LIGHT_KM_S

    def light_time_s(self, t: np.ndarray | float) -> np.ndarray:
        return self.range_km(t) / SPEED_OF_LIGHT_KM_S

    def rssi_dbm(self, t: np.ndarray | float) -> np.ndarray:
        # Free-space loss relative to zenith.
        return self.rssi_zenith_dbm - 20.0 * np.log10(self.range_km(t) / self.altitude_km)
