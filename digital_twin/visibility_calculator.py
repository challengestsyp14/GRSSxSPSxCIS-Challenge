"""
visibility_calculator.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin, phase 1: where the satellite is in the Zaghouan sky, and when it is up.

TEME positions are rotated into the Earth-fixed frame by Greenwich mean sidereal time (IAU
1982), then into the station's local east-north-up frame for azimuth, elevation and range.
The station keeps the testbed's 2 deg elevation mask: frames flow only above it.
"""

from __future__ import annotations

import logging
import math

import numpy as np

logger = logging.getLogger("VisibilityCalculator")

WGS84_A_KM = 6378.137
WGS84_F = 1.0 / 298.257223563
EARTH_ROTATION_RAD_S = 7.292115e-5

#: The testbed's ground station, as on the dashboard map.
ZAGHOUAN_STATION = {"id": "GS-ZAG", "lat_deg": 36.4, "lon_deg": 10.14, "alt_km": 0.18}
MASK_ELEVATION_DEG = 2.0


def gmst_rad(epoch_timestamp):
    """Greenwich mean sidereal time (IAU 1982) for Unix time(s), in radians."""
    jd = 2440587.5 + np.asarray(epoch_timestamp, dtype=float) / 86400.0
    t = (jd - 2451545.0) / 36525.0
    seconds = (
        67310.54841 + (876600.0 * 3600.0 + 8640184.812866) * t + 0.093104 * t**2 - 6.2e-6 * t**3
    )
    return np.mod(seconds, 86400.0) / 86400.0 * 2.0 * math.pi


def geodetic_to_ecef(lat_deg: float, lon_deg: float, alt_km: float) -> np.ndarray:
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    e2 = WGS84_F * (2.0 - WGS84_F)
    n = WGS84_A_KM / math.sqrt(1.0 - e2 * math.sin(lat) ** 2)
    return np.array(
        [
            (n + alt_km) * math.cos(lat) * math.cos(lon),
            (n + alt_km) * math.cos(lat) * math.sin(lon),
            (n * (1.0 - e2) + alt_km) * math.sin(lat),
        ]
    )


def teme_to_ecef(positions, theta) -> np.ndarray:
    """Rotates TEME vector(s) about the pole by GMST into the Earth-fixed frame."""
    p = np.atleast_2d(np.asarray(positions, dtype=float))
    c, s = np.cos(theta), np.sin(theta)
    return np.column_stack((c * p[:, 0] + s * p[:, 1], -s * p[:, 0] + c * p[:, 1], p[:, 2]))


class VisibilityCalculator:
    def __init__(
        self,
        gs_lat: float = ZAGHOUAN_STATION["lat_deg"],
        gs_lon: float = ZAGHOUAN_STATION["lon_deg"],
        gs_alt_km: float = ZAGHOUAN_STATION["alt_km"],
        horizon_mask_deg: float = MASK_ELEVATION_DEG,
    ):
        self.gs_lat = gs_lat
        self.gs_lon = gs_lon
        self.gs_alt_km = gs_alt_km
        self.horizon_mask = horizon_mask_deg
        self.station_ecef = geodetic_to_ecef(gs_lat, gs_lon, gs_alt_km)
        lat, lon = math.radians(gs_lat), math.radians(gs_lon)
        # Rows: east, north, up unit vectors in the Earth-fixed frame.
        self.enu = np.array(
            [
                [-math.sin(lon), math.cos(lon), 0.0],
                [-math.sin(lat) * math.cos(lon), -math.sin(lat) * math.sin(lon), math.cos(lat)],
                [math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)],
            ]
        )

    def station_state_eci(self, epoch_timestamp: float) -> tuple[list, list]:
        """Station position (km) and velocity (km/s) in TEME: Earth rotation carries it."""
        theta = float(gmst_rad(epoch_timestamp))
        c, s = math.cos(theta), math.sin(theta)
        x, y, z = self.station_ecef
        position = np.array([c * x - s * y, s * x + c * y, z])
        velocity = np.cross([0.0, 0.0, EARTH_ROTATION_RAD_S], position)
        return position.tolist(), velocity.tolist()

    def _look_angles(self, positions_eci, epoch_timestamps):
        ecef = teme_to_ecef(positions_eci, gmst_rad(epoch_timestamps))
        e, n, u = self.enu @ (ecef - self.station_ecef).T
        azimuth = np.degrees(np.arctan2(e, n)) % 360.0
        elevation = np.degrees(np.arctan2(u, np.hypot(e, n)))
        return azimuth, elevation, np.sqrt(e**2 + n**2 + u**2)

    def calculate_topocentric_angles(self, sat_pos_eci: list, epoch_timestamp: float) -> dict:
        """Azimuth, elevation and range from the station, and whether it clears the mask."""
        azimuth, elevation, range_km = self._look_angles(sat_pos_eci, epoch_timestamp)
        elevation_deg = float(elevation[0])
        return {
            "azimuth_deg": float(azimuth[0]),
            "elevation_deg": elevation_deg,
            "range_km": float(range_km[0]),
            "is_above_horizon": elevation_deg >= self.horizon_mask,
        }

    def elevations(self, propagator, epoch_timestamps) -> np.ndarray:
        positions, _ = propagator.propagate_many(epoch_timestamps)
        return self._look_angles(positions, epoch_timestamps)[1]

    def find_next_pass(
        self, propagator, start_unix: float, search_hours: float = 36.0, step_s: float = 20.0
    ) -> dict | None:
        """First pass above the mask that has not set by `start_unix` (one in progress counts).

        A coarse scan finds the crossings, bisection refines rise and set to well under a
        second, and a 1 s scan finds the culmination.
        """
        t = start_unix - 1800.0 + np.arange(0.0, search_hours * 3600.0, step_s)
        above = self.elevations(propagator, t) >= self.horizon_mask
        rises = np.flatnonzero(~above[:-1] & above[1:])
        sets = np.flatnonzero(above[:-1] & ~above[1:])
        for i in rises:
            later_sets = sets[sets > i]
            if later_sets.size == 0:
                return None
            j = later_sets[0]
            los = self._crossing(propagator, t[j], t[j + 1], rising=False)
            if los <= start_unix:
                continue
            aos = self._crossing(propagator, t[i], t[i + 1], rising=True)
            fine = np.arange(aos, los, 1.0)
            el = self.elevations(propagator, fine)
            k = int(np.argmax(el))
            return {
                "aos_unix": aos,
                "tca_unix": float(fine[k]),
                "los_unix": los,
                "duration_s": los - aos,
                "max_elevation_deg": float(el[k]),
            }
        return None

    def _crossing(self, propagator, t0: float, t1: float, rising: bool) -> float:
        """Bisects the mask crossing between t0 and t1."""
        for _ in range(40):
            mid = 0.5 * (t0 + t1)
            up = self.elevations(propagator, [mid])[0] >= self.horizon_mask
            if up == rising:
                t1 = mid
            else:
                t0 = mid
        return 0.5 * (t0 + t1)
