"""
security_detector.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin, phase 2: the physical layer. A chi-square test of what the signal claims
against what orbital mechanics says it must be, and a kinematic test of the claims against
each other.

Chi-square residuals. The station predicts range, Doppler, received power and carrier
phase from the SGP4 orbit and the ITU-R P.618 link budget. Each measured residual is
divided by its natural one-sigma spread on a clean pass, the figures the dashboard
measured: 1.6 us of frame timing (0.48 km of range), 6.1 Hz of carrier, 0.23 dB of power,
plus 1.5 deg of carrier phase. The squares are summed: on a clean link the sum follows a
chi-square law with four degrees of freedom, so the gate is the quantile for a 1e-4
false-alarm rate. Near the horizon tropospheric scintillation and multipath widen the
residuals: the covariance grows by a factor 1 + 2 exp(-elevation / 6 deg), and the gate
with it.

Kinematic coupling. Range and Doppler are not independent: the Doppler shift is the range
rate, f_d = -f_c (d range / dt) / c. So the range change since the last trusted
measurement must equal the Doppler integrated over the interval (trapezoidal rule), whatever
the orbit. The test needs no ephemeris: it holds even if the element set is stale, and it
catches a delay that steps or drifts without the matching Doppler, the signature of a
meaconer or a drag-off spoofer. Its residual is judged against the range and Doppler noise
plus a bound on the integration error, two-sided at the same 1e-4 false-alarm rate.

A replayed, delayed or re-transmitted signal cannot match the geometry, so it fails
these tests however clean its cryptography.
"""

from __future__ import annotations

import logging
import math

from testbed.ingester import NOMINAL_CARRIER_MHZ

logger = logging.getLogger("PhysicsSecurityEngine")

SPEED_OF_LIGHT_KM_S = 299_792.458

#: Natural one-sigma spread of each residual on a clean pass, above ~30 deg elevation.
NATURAL_SIGMA = {
    "slant_range_km": 1.6e-6 * SPEED_OF_LIGHT_KM_S,
    "doppler_shift_hz": 6.1,
    "rssi_dbm": 0.23,
    "received_phase_error_deg": 1.5,
}

#: Longest interval over which the last trusted measurement anchors the kinematic test.
KINEMATIC_MAX_GAP_S = 30.0
#: Speed of the ground at the equator, added to the orbital speed for a safe bound.
EARTH_SURFACE_SPEED_KM_S = 0.465


def range_jerk_bound(min_range_km: float, relative_speed_km_s: float) -> float:
    """Largest |d^3 range / dt^3| of a pass (km/s^3): 0.859 v^3 / rho_min^2, at u = 1/2.

    For a straight pass at speed v and closest range rho_min, the range jerk peaks at
    3 v^3 / rho_min^2 * u / (1 + u^2)^(5/2) with u = 1/2. The trapezoidal error of the
    Doppler integral over dt is at most this times dt^3 / 12.
    """
    return 0.859 * relative_speed_km_s**3 / min_range_km**2


#: TerraSAR-X overhead at 514 km; the validator derives the bound from the orbit it flies.
DEFAULT_RANGE_JERK_BOUND_KM_S3 = range_jerk_bound(514.0, 7.61 + EARTH_SURFACE_SPEED_KM_S)

NO_REFERENCE = {
    "available": False,
    "kinematic_breach": False,
    "verdict": "KINEMATIC_NO_REFERENCE",
}


def chi_square_sf(x: float, dof: int) -> float:
    """Survival function of the chi-square law, exact for an even number of degrees of freedom."""
    if dof % 2:
        raise ValueError("closed form needs an even number of degrees of freedom")
    half = x / 2.0
    term, total = 1.0, 1.0
    for i in range(1, dof // 2):
        term *= half / i
        total += term
    return math.exp(-half) * total


def chi_square_quantile(probability: float, dof: int) -> float:
    """Inverse CDF of the chi-square law, by bisection on the survival function."""
    low, high = 0.0, 1000.0
    for _ in range(200):
        mid = 0.5 * (low + high)
        if 1.0 - chi_square_sf(mid, dof) < probability:
            low = mid
        else:
            high = mid
    return 0.5 * (low + high)


def normal_two_sided_quantile(false_alarm_rate: float) -> float:
    """z with P(|Z| > z) = false_alarm_rate for a standard normal Z, by bisection."""
    low, high = 0.0, 40.0
    for _ in range(200):
        mid = 0.5 * (low + high)
        if math.erfc(mid / math.sqrt(2.0)) > false_alarm_rate:
            low = mid
        else:
            high = mid
    return 0.5 * (low + high)


def elevation_spread_factor(elevation_deg: float) -> float:
    """Variance growth of the residuals near the horizon: 3x at 0 deg, ~1 above 30 deg."""
    return 1.0 + 2.0 * math.exp(-max(float(elevation_deg), 0.0) / 6.0)


class PhysicsSecurityEngine:
    def __init__(
        self,
        false_alarm_rate: float = 1e-4,
        sigmas: dict | None = None,
        carrier_hz: float = NOMINAL_CARRIER_MHZ * 1e6,
        max_gap_s: float = KINEMATIC_MAX_GAP_S,
        range_jerk_bound_km_s3: float = DEFAULT_RANGE_JERK_BOUND_KM_S3,
    ):
        self.sigmas = dict(sigmas or NATURAL_SIGMA)
        self.false_alarm_rate = false_alarm_rate
        self.dof = len(self.sigmas)
        self.base_threshold = chi_square_quantile(1.0 - false_alarm_rate, self.dof)
        self.kinematic_gate_z = normal_two_sided_quantile(false_alarm_rate)
        self.carrier_hz = carrier_hz
        self.max_gap_s = max_gap_s
        self.range_jerk_bound_km_s3 = range_jerk_bound_km_s3
        # The last measurement the layer found consistent: the kinematic test's reference.
        self.anchor: dict | None = None

    def adaptive_threshold(self, elevation_deg: float) -> float:
        return self.base_threshold * elevation_spread_factor(elevation_deg)

    def sigma_at(self, name: str, elevation_deg: float) -> float:
        return self.sigmas[name] * math.sqrt(elevation_spread_factor(elevation_deg))

    def kinematic_coupling(self, rx_link: dict, elevation_deg: float, timestamp: float) -> dict:
        """Range change since the last trusted measurement against the integrated Doppler."""
        anchor = self.anchor
        if anchor is None or not 0.0 < timestamp - anchor["timestamp"] <= self.max_gap_s:
            return dict(NO_REFERENCE)
        dt = timestamp - anchor["timestamp"]
        # km of range per Hz of Doppler per second: f_d = -f_c (d range / dt) / c.
        scale = SPEED_OF_LIGHT_KM_S / self.carrier_hz
        range_change = rx_link["slant_range_km"] - anchor["slant_range_km"]
        doppler_change = (
            -scale * 0.5 * (rx_link["doppler_shift_hz"] + anchor["doppler_shift_hz"]) * dt
        )
        residual = range_change - doppler_change
        variance = (
            self.sigma_at("slant_range_km", elevation_deg) ** 2
            + self.sigma_at("slant_range_km", anchor["elevation_deg"]) ** 2
            + (0.5 * scale * dt) ** 2
            * (
                self.sigma_at("doppler_shift_hz", elevation_deg) ** 2
                + self.sigma_at("doppler_shift_hz", anchor["elevation_deg"]) ** 2
            )
            + (self.range_jerk_bound_km_s3 * dt**3 / 12.0) ** 2
        )
        z = residual / math.sqrt(variance)
        breach = abs(z) > self.kinematic_gate_z
        return {
            "available": True,
            "interval_s": dt,
            "range_change_km": range_change,
            "doppler_range_change_km": doppler_change,
            "residual_km": residual,
            "sigma_km": math.sqrt(variance),
            "z_score": z,
            "gate_z": self.kinematic_gate_z,
            "kinematic_breach": breach,
            "verdict": "KINEMATIC_VIOLATION" if breach else "KINEMATIC_CONSISTENT",
        }

    def evaluate_telemetry_physics(
        self,
        rx_link: dict,
        true_link: dict,
        elevation_deg: float,
        timestamp: float | None = None,
    ) -> dict:
        """Chi-square of the received link against the orbit prediction, the kinematic
        coupling of its range and Doppler (when `timestamp` is given), and the verdict."""
        residuals = {name: rx_link[name] - true_link[name] for name in self.sigmas}
        normalized = {name: residuals[name] / sigma for name, sigma in self.sigmas.items()}
        chi_square = sum(z * z for z in normalized.values())
        threshold = self.adaptive_threshold(elevation_deg)
        chi_square_breach = chi_square > threshold

        if timestamp is None:
            kinematic = dict(NO_REFERENCE)
        else:
            kinematic = self.kinematic_coupling(rx_link, elevation_deg, timestamp)
        breach = chi_square_breach or kinematic["kinematic_breach"]
        if timestamp is not None and not breach:
            self.anchor = {
                "timestamp": timestamp,
                "elevation_deg": elevation_deg,
                "slant_range_km": rx_link["slant_range_km"],
                "doppler_shift_hz": rx_link["doppler_shift_hz"],
            }
        return {
            "layer": "Physical Layer (Chi-Square)",
            "chi_square_value": chi_square,
            "adaptive_threshold": threshold,
            "degrees_of_freedom": self.dof,
            "false_alarm_rate": self.false_alarm_rate,
            "residuals": residuals,
            "normalized_residuals": normalized,
            "dominant_residual": max(normalized, key=lambda name: abs(normalized[name])),
            "chi_square_breach": chi_square_breach,
            "kinematic_coupling": kinematic,
            "physical_breach_detected": breach,
            "verdict": "PHYSICS_VIOLATION" if breach else "PHYSICS_CONSISTENT",
        }
