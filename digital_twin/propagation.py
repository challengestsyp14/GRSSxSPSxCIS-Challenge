"""
propagation.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin, phase 1: SGP4 orbit propagation.

SGP4 is the propagator element sets are fitted for: it models the J2, J3 and J4 zonal
harmonics of Earth's gravity and atmospheric drag. It returns the satellite's position and
velocity in the TEME frame, the quasi-inertial frame the rest of the twin calls ECI.
"""

from __future__ import annotations

import logging
import math

import numpy as np
from sgp4.api import SGP4_ERRORS, WGS72, Satrec
from sgp4.earth_gravity import wgs72 as wgs72_gravity

logger = logging.getLogger("SGP4Propagator")

UNIX_EPOCH_JD = 2440587.5
#: The zonal harmonics SGP4 applies (WGS-72). J2 turns TerraSAR-X's orbit plane ~0.98 deg/day
#: eastward, the sun-synchronous rate; J3 and J4 add the smaller periodic terms.
ZONAL_HARMONICS = {"J2": wgs72_gravity.j2, "J3": wgs72_gravity.j3, "J4": wgs72_gravity.j4}


def unix_to_jd(epoch_timestamp: float) -> tuple[float, float]:
    """Unix seconds as a Julian date split in two parts, to keep SGP4's time precision."""
    jd = UNIX_EPOCH_JD + epoch_timestamp / 86400.0
    whole = math.floor(jd - 0.5) + 0.5
    return whole, jd - whole


class OrbitPropagator:
    def __init__(self, tle_data: dict):
        self.tle = tle_data
        self.satellite = Satrec.twoline2rv(tle_data["line1"], tle_data["line2"], WGS72)

    @property
    def perigee_altitude_km(self) -> float:
        return self.satellite.altp * self.satellite.radiusearthkm

    @property
    def mean_orbital_speed_km_s(self) -> float:
        return math.sqrt(self.satellite.mu / (self.satellite.a * self.satellite.radiusearthkm))

    def propagate_eci_state(self, epoch_timestamp: float) -> dict:
        """Satellite state at a Unix time: position (km) and velocity (km/s) in TEME."""
        jd, fraction = unix_to_jd(epoch_timestamp)
        error, position, velocity = self.satellite.sgp4(jd, fraction)
        if error:
            raise RuntimeError(f"SGP4 error {error}: {SGP4_ERRORS[error]}")
        return {
            "epoch": epoch_timestamp,
            "position_eci_km": list(position),
            "velocity_eci_km_s": list(velocity),
            "frame": "TEME",
        }

    def propagate_many(self, epoch_timestamps) -> tuple[np.ndarray, np.ndarray]:
        """Vectorised SGP4 over many Unix times: (N, 3) positions and velocities."""
        t = np.asarray(epoch_timestamps, dtype=float)
        jd = UNIX_EPOCH_JD + t / 86400.0
        whole = np.floor(jd - 0.5) + 0.5
        errors, positions, velocities = self.satellite.sgp4_array(whole, jd - whole)
        if np.any(errors):
            code = int(errors[np.flatnonzero(errors)[0]])
            raise RuntimeError(f"SGP4 error {code}: {SGP4_ERRORS[code]}")
        return positions, velocities
