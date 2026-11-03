"""
link_budget.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin, phase 1: the X-band downlink budget with ITU-R path loss.

From the satellite and station states it gives what the receiver should see: slant range,
range rate, Doppler shift, light time, path loss, SNR and RSSI. The budget is the live
dashboard's (EIRP 18 dBW, G/T 31 dB/K, 300 MHz channel, 2 dB fixed losses, -100 dBm noise
floor). On top of free-space loss, the atmosphere follows ITU-R P.618-13 section 2.5: the
attenuation exceeded for p % of an average year is

    A_T(p) = A_G(p) + sqrt((A_R(p) + A_C(p))^2 + A_S(p)^2)

with gaseous absorption A_G from P.676-10 Annex 2, rain A_R from P.618-13 section 2.2.1.1
(P.838-3 specific attenuation, P.839-4 rain height), clouds A_C from P.840-7 and
tropospheric scintillation A_S from P.618-13 section 2.4.1. The live link uses the median
atmosphere, p = 50 %, where rain, clouds and scintillation vanish over Zaghouan and
gaseous absorption is left: 0.05 dB at zenith, about 1 dB at the 2 deg mask. A smaller p
gives the fade margin for a link available 100 - p % of the time. The climate inputs
default to the ITU-R maps at Zaghouan.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass

import numpy as np

from testbed.ingester import NOMINAL_CARRIER_MHZ

logger = logging.getLogger("LinkBudgetCalculator")

SPEED_OF_LIGHT_M_S = 299_792_458.0
BOLTZMANN_DBW_PER_HZ_K = -228.6
#: Effective Earth radius for 4/3-Earth refraction (ITU-R P.834).
EFFECTIVE_EARTH_RADIUS_KM = 8500.0
#: Exceedance of the median atmosphere, the one the live link sees.
MEDIAN_PERCENT = 50.0


@dataclass(frozen=True)
class StationClimate:
    """Station and climate inputs of the ITU-R models; defaults are the maps at Zaghouan."""

    latitude_deg: float = 36.4
    altitude_km: float = 0.18
    rain_rate_001_mm_h: float = 30.19  # P.837-7: rain rate exceeded 0.01 % of a year
    rain_height_km: float = 2.863  # P.839-4: 0 deg C isotherm at 2.503 km, plus 0.36 km
    temperature_c: float = 18.2  # P.1510-1: mean surface temperature
    pressure_hpa: float = 991.8  # P.835: reference atmosphere at the station height
    wet_refractivity: float = 68.4  # P.453-13: median wet term of the radio refractivity
    #: P.836-6 surface water-vapour density (g/m^3) exceeded for p % of a year, as (p, value).
    water_vapour_g_m3: tuple = (
        (1.0, 18.84),
        (2.0, 18.05),
        (3.0, 17.53),
        (5.0, 16.78),
        (10.0, 15.48),
        (20.0, 13.70),
        (30.0, 12.30),
        (50.0, 9.87),
    )
    #: P.840-7 reduced cloud liquid water content (kg/m^2) exceeded for p % of a year.
    cloud_liquid_kg_m2: tuple = (
        (1.0, 0.857),
        (2.0, 0.640),
        (3.0, 0.522),
        (5.0, 0.362),
        (10.0, 0.170),
        (20.0, 0.039),
        (30.0, 0.005),
        (50.0, 0.0),
    )
    antenna_diameter_m: float = 7.3  # the X-band dish that gives G/T 31 dB/K
    antenna_efficiency: float = 0.6
    polarisation_tilt_deg: float = 45.0  # circular polarisation


def exceeded_for(table: tuple, percent: float) -> float:
    """A climate value exceeded for `percent` % of a year, interpolated in log(p).

    P.618-13 section 2.5 holds gases and clouds at their 1 % values below 1 %, which the
    clamp to the table's first row does.
    """
    p = min(max(percent, table[0][0]), table[-1][0])
    for (p0, v0), (p1, v1) in zip(table, table[1:], strict=False):
        if p <= p1:
            return v0 + (v1 - v0) * math.log(p / p0) / math.log(p1 / p0)
    return table[-1][1]


# ---------------------------------------------------------------- ITU-R P.676-10, Annex 2


def gaseous_specific_attenuation(
    f_ghz: float, pressure_hpa: float, water_vapour_g_m3: float, temperature_c: float
) -> tuple[float, float]:
    """Dry-air and water-vapour specific attenuation (dB/km) below 54 GHz."""
    f, rho = f_ghz, water_vapour_g_m3
    rp = pressure_hpa / 1013.0
    rt = 288.0 / (273.15 + temperature_c)

    def phi(a, b, c, d):
        return rp**a * rt**b * math.exp(c * (1.0 - rp) + d * (1.0 - rt))

    xi1 = phi(0.0717, -1.8132, 0.0156, -1.6515)
    xi2 = phi(0.5146, -4.6368, -0.1921, -5.7416)
    xi3 = phi(0.3414, -6.5851, 0.2130, -8.5854)
    gamma_o = (
        (
            7.2 * rt**2.8 / (f**2 + 0.34 * rp**2 * rt**1.6)
            + 0.62 * xi3 / ((54.0 - f) ** (1.16 * xi1) + 0.83 * xi2)
        )
        * f**2
        * rp**2
        * 1e-3
    )

    eta1 = 0.955 * rp * rt**0.68 + 0.006 * rho
    eta2 = 0.735 * rp * rt**0.5 + 0.0353 * rt**4 * rho

    def g(fi):
        return 1.0 + ((f - fi) / (f + fi)) ** 2

    def line(strength, decay, centre, width, eta=eta1):
        return strength * eta * math.exp(decay * (1.0 - rt)) / ((f - centre) ** 2 + width * eta**2)

    gamma_w = (
        (
            line(3.98, 2.23, 22.235, 9.42) * g(22.0)
            + line(11.96, 0.70, 183.31, 11.14)
            + line(0.081, 6.44, 321.226, 6.29)
            + line(3.66, 1.60, 325.153, 9.22)
            + line(25.37, 1.09, 380.0, 0.0)
            + line(17.40, 1.46, 448.0, 0.0)
            + line(844.6, 0.17, 557.0, 0.0) * g(557.0)
            + line(290.0, 0.41, 752.0, 0.0) * g(752.0)
            + line(8.3328e4, 0.99, 1780.0, 0.0, eta=eta2) * g(1780.0)
        )
        * f**2
        * rt**2.5
        * rho
        * 1e-4
    )
    return gamma_o, gamma_w


def gaseous_equivalent_heights(f_ghz: float, total_pressure_hpa: float) -> tuple[float, float]:
    """Equivalent heights (km) of dry air and water vapour for slant paths."""
    f = f_ghz
    rp = total_pressure_hpa / 1013.0
    t1 = (
        4.64
        / (1.0 + 0.066 * rp**-2.3)
        * math.exp(-(((f - 59.7) / (2.87 + 12.4 * math.exp(-7.9 * rp))) ** 2))
    )
    t2 = 0.14 * math.exp(2.21 * rp) / ((f - 118.75) ** 2 + 0.031 * math.exp(2.2 * rp))
    t3 = (
        0.0114
        / (1.0 + 0.14 * rp**-2.6)
        * f
        * (-0.0247 + 0.0001 * f + 1.61e-6 * f**2)
        / (1.0 - 0.0169 * f + 4.1e-5 * f**2 + 3.2e-7 * f**3)
    )
    h_o = 6.1 / (1.0 + 0.17 * rp**-1.1) * (1.0 + t1 + t2 + t3)
    if f < 70.0:
        h_o = min(h_o, 10.7 * rp**0.3)
    sigma_w = 1.013 / (1.0 + math.exp(-8.6 * (rp - 0.57)))
    h_w = 1.66 * (
        1.0
        + 1.39 * sigma_w / ((f - 22.235) ** 2 + 2.56 * sigma_w)
        + 3.37 * sigma_w / ((f - 183.31) ** 2 + 4.69 * sigma_w)
        + 1.58 * sigma_w / ((f - 325.1) ** 2 + 2.89 * sigma_w)
    )
    return h_o, h_w


# ---------------------------------------------------------------- ITU-R P.838-3 and P.840-7

# Curve-fitting coefficients (a_j, b_j, c_j), then (m, c), for k_H, k_V, alpha_H, alpha_V.
_P838 = {
    "kH": (
        ((-5.33980, -0.10008, 1.13098), (-0.35351, 1.26970, 0.45400)),
        ((-0.23789, 0.86036, 0.15354), (-0.94158, 0.64552, 0.16817)),
        (-0.18961, 0.71147),
    ),
    "kV": (
        ((-3.80595, 0.56934, 0.81061), (-3.44965, -0.22911, 0.51059)),
        ((-0.39902, 0.73042, 0.11899), (0.50167, 1.07319, 0.27195)),
        (-0.16398, 0.63297),
    ),
    "aH": (
        ((-0.14318, 1.82442, -0.55187), (0.29591, 0.77564, 0.19822)),
        ((0.32177, 0.63773, 0.13164), (-5.37610, -0.96230, 1.47828), (16.1721, -3.29980, 3.43990)),
        (0.67849, -1.95537),
    ),
    "aV": (
        ((-0.07771, 2.33840, -0.76284), (0.56727, 0.95545, 0.54039)),
        (
            (-0.20238, 1.14520, 0.26809),
            (-48.2991, 0.791669, 0.116226),
            (48.5833, 0.791459, 0.116479),
        ),
        (-0.053739, 0.83433),
    ),
}


def _p838_fit(name: str, f_ghz: float) -> float:
    first, second, (m, c) = _P838[name]
    x = math.log10(f_ghz)
    total = sum(a * math.exp(-(((x - b) / w) ** 2)) for a, b, w in first + second)
    return total + m * x + c


def rain_coefficients(f_ghz: float, elevation_deg: float, tilt_deg: float) -> tuple[float, float]:
    """P.838-3: k and alpha of the specific rain attenuation gamma_R = k R^alpha (dB/km)."""
    k_h, k_v = 10.0 ** _p838_fit("kH", f_ghz), 10.0 ** _p838_fit("kV", f_ghz)
    a_h, a_v = _p838_fit("aH", f_ghz), _p838_fit("aV", f_ghz)
    mix = math.cos(math.radians(elevation_deg)) ** 2 * math.cos(math.radians(2.0 * tilt_deg))
    k = (k_h + k_v + (k_h - k_v) * mix) / 2.0
    alpha = (k_h * a_h + k_v * a_v + (k_h * a_h - k_v * a_v) * mix) / (2.0 * k)
    return k, alpha


def cloud_specific_attenuation(f_ghz: float, temperature_c: float = 0.0) -> float:
    """P.840-7: specific attenuation of cloud liquid water, (dB/km)/(g/m^3), double-Debye."""
    f = f_ghz
    theta = 300.0 / (273.15 + temperature_c)
    eps0 = 77.66 + 103.3 * (theta - 1.0)
    eps1 = 0.0671 * eps0
    eps2 = 3.52
    fp = 20.20 - 146.0 * (theta - 1.0) + 316.0 * (theta - 1.0) ** 2
    fs = 39.8 * fp
    eps_imag = f * (eps0 - eps1) / (fp * (1.0 + (f / fp) ** 2)) + f * (eps1 - eps2) / (
        fs * (1.0 + (f / fs) ** 2)
    )
    eps_real = (eps0 - eps1) / (1.0 + (f / fp) ** 2) + (eps1 - eps2) / (1.0 + (f / fs) ** 2) + eps2
    eta = (2.0 + eps_real) / eps_imag
    return 0.819 * f / (eps_imag * (1.0 + eta**2))


class LinkBudgetCalculator:
    def __init__(
        self,
        carrier_freq_hz: float = NOMINAL_CARRIER_MHZ * 1e6,
        eirp_dbw: float = 18.0,
        g_over_t_db_k: float = 31.0,
        bandwidth_hz: float = 300e6,
        fixed_losses_db: float = 2.0,
        noise_floor_dbm: float = -100.0,
        climate: StationClimate | None = None,
        exceedance_percent: float = MEDIAN_PERCENT,
    ):
        self.freq_hz = carrier_freq_hz
        self.f_ghz = carrier_freq_hz / 1e9
        self.eirp_dbw = eirp_dbw
        self.g_over_t_db_k = g_over_t_db_k
        self.bandwidth_hz = bandwidth_hz
        self.fixed_losses_db = fixed_losses_db
        self.noise_floor_dbm = noise_floor_dbm
        self.climate = climate or StationClimate()
        self.exceedance_percent = exceedance_percent
        self.c = SPEED_OF_LIGHT_M_S

    def free_space_loss_db(self, slant_range_km: float) -> float:
        return 20.0 * math.log10(4.0 * math.pi * slant_range_km * 1000.0 * self.freq_hz / self.c)

    # ------------------------------------------------------------ ITU-R propagation losses

    def gaseous_attenuation_db(self, elevation_deg: float, percent: float) -> float:
        """P.676-10 Annex 2 slant path; the 0-5 deg form follows the curved, refracted ray."""
        clim = self.climate
        rho = exceeded_for(clim.water_vapour_g_m3, percent)
        gamma_o, gamma_w = gaseous_specific_attenuation(
            self.f_ghz, clim.pressure_hpa, rho, clim.temperature_c
        )
        vapour_pressure = rho * (273.15 + clim.temperature_c) / 216.7
        h_o, h_w = gaseous_equivalent_heights(self.f_ghz, clim.pressure_hpa + vapour_pressure)
        el = math.radians(max(elevation_deg, 0.0))
        if el >= math.radians(5.0):
            return (gamma_o * h_o + gamma_w * h_w) / math.sin(el)

        def f_curve(x):
            return 1.0 / (0.661 * x + 0.339 * math.sqrt(x**2 + 5.51))

        re = EFFECTIVE_EARTH_RADIUS_KM
        return (
            math.sqrt(re)
            / math.cos(el)
            * (
                gamma_o * math.sqrt(h_o) * f_curve(math.tan(el) * math.sqrt(re / h_o))
                + gamma_w * math.sqrt(h_w) * f_curve(math.tan(el) * math.sqrt(re / h_w))
            )
        )

    def rain_attenuation_db(self, elevation_deg: float, percent: float) -> float:
        """P.618-13 section 2.2.1.1; defined for 0.001-5 %, taken as zero beyond 5 %."""
        clim = self.climate
        dh = clim.rain_height_km - clim.altitude_km
        if percent > 5.0 or dh <= 0.0 or clim.rain_rate_001_mm_h <= 0.0:
            return 0.0
        p = max(percent, 0.001)
        f = self.f_ghz
        el_deg = max(elevation_deg, 0.0)
        el = math.radians(el_deg)
        lat = abs(clim.latitude_deg)
        # Steps 2-3: slant path below the rain height, and its horizontal projection.
        if el_deg >= 5.0:
            ls = dh / math.sin(el)
        else:
            ls = (
                2.0
                * dh
                / (
                    math.sqrt(math.sin(el) ** 2 + 2.0 * dh / EFFECTIVE_EARTH_RADIUS_KM)
                    + math.sin(el)
                )
            )
        lg = ls * math.cos(el)
        # Step 5: specific attenuation for the rain rate exceeded 0.01 % of the time.
        k, alpha = rain_coefficients(f, el_deg, clim.polarisation_tilt_deg)
        gamma_r = k * clim.rain_rate_001_mm_h**alpha
        # Steps 6-8: horizontal reduction, vertical adjustment, effective path length.
        r001 = 1.0 / (1.0 + 0.78 * math.sqrt(lg * gamma_r / f) - 0.38 * (1.0 - math.exp(-2.0 * lg)))
        zeta = math.degrees(math.atan2(dh, lg * r001))
        lr = lg * r001 / math.cos(el) if zeta > el_deg else dh / math.sin(el)
        chi = 36.0 - lat if lat < 36.0 else 0.0
        v001 = 1.0 / (
            1.0
            + math.sqrt(math.sin(el))
            * (
                31.0 * (1.0 - math.exp(-el_deg / (1.0 + chi))) * math.sqrt(lr * gamma_r) / f**2
                - 0.45
            )
        )
        # Step 9: attenuation exceeded 0.01 % of an average year.
        a001 = gamma_r * lr * v001
        # Step 10: scale to p %.
        if p >= 1.0 or lat >= 36.0:
            beta = 0.0
        elif el_deg >= 25.0:
            beta = -0.005 * (lat - 36.0)
        else:
            beta = -0.005 * (lat - 36.0) + 1.8 - 4.25 * math.sin(el)
        exponent = -(
            0.655 + 0.033 * math.log(p) - 0.045 * math.log(a001) - beta * (1.0 - p) * math.sin(el)
        )
        return a001 * (p / 0.01) ** exponent

    def cloud_attenuation_db(self, elevation_deg: float, percent: float) -> float:
        """P.840-7, valid from 5 deg: lower elevations are held at the 5 deg value."""
        liquid = exceeded_for(self.climate.cloud_liquid_kg_m2, percent)
        sin_el = math.sin(math.radians(max(elevation_deg, 5.0)))
        return liquid * cloud_specific_attenuation(self.f_ghz) / sin_el

    def scintillation_sigma_db(self, elevation_deg: float) -> float:
        """P.618-13 section 2.4.1: one-sigma tropospheric scintillation, valid from 5 deg."""
        clim = self.climate
        f = self.f_ghz
        sin_el = math.sin(math.radians(max(elevation_deg, 5.0)))
        sigma_ref = 3.6e-3 + 1e-4 * clim.wet_refractivity
        turbulence_path_m = 2.0 * 1000.0 / (math.sqrt(sin_el**2 + 2.35e-4) + sin_el)
        d_eff = math.sqrt(clim.antenna_efficiency) * clim.antenna_diameter_m
        x = 1.22 * d_eff**2 * f / turbulence_path_m
        if x >= 7.0:
            return 0.0
        averaging = math.sqrt(
            3.86 * (x**2 + 1.0) ** (11.0 / 12.0) * math.sin(11.0 / 6.0 * math.atan(1.0 / x))
            - 7.08 * x ** (5.0 / 6.0)
        )
        return sigma_ref * f ** (7.0 / 12.0) * averaging / sin_el**1.2

    def scintillation_attenuation_db(self, elevation_deg: float, percent: float) -> float:
        """P.618-13 section 2.4.1: fade depth exceeded for p % of the time (0.01-50 %)."""
        lp = math.log10(min(max(percent, 0.01), 50.0))
        a = -0.061 * lp**3 + 0.072 * lp**2 - 1.71 * lp + 3.0
        return a * self.scintillation_sigma_db(elevation_deg)

    def atmospheric_attenuation(self, elevation_deg: float, percent: float | None = None) -> dict:
        """P.618-13 section 2.5: each contribution and the total exceeded for p % of a year."""
        p = self.exceedance_percent if percent is None else percent
        gas = self.gaseous_attenuation_db(elevation_deg, p)
        rain = self.rain_attenuation_db(elevation_deg, p)
        cloud = self.cloud_attenuation_db(elevation_deg, p)
        scintillation = self.scintillation_attenuation_db(elevation_deg, p)
        return {
            "elevation_deg": elevation_deg,
            "exceedance_percent": p,
            "gaseous_db": gas,
            "rain_db": rain,
            "cloud_db": cloud,
            "scintillation_db": scintillation,
            "total_db": gas + math.sqrt((rain + cloud) ** 2 + scintillation**2),
        }

    def atmospheric_loss_db(self, elevation_deg: float, percent: float | None = None) -> float:
        return self.atmospheric_attenuation(elevation_deg, percent)["total_db"]

    # ------------------------------------------------------------ the link

    def compute_rf_link(
        self,
        sat_pos: list,
        sat_vel: list,
        gs_pos: list,
        gs_vel: list | None = None,
        elevation_deg: float = 90.0,
        exceedance_percent: float | None = None,
    ) -> dict:
        """Slant range, Doppler, path loss, SNR and RSSI for one satellite-station geometry.

        Positions in km and velocities in km/s, both in the same inertial frame. The
        atmosphere is the one exceeded for `exceedance_percent` % of a year, the median
        by default.
        """
        r_vec = np.asarray(sat_pos, dtype=float) - np.asarray(gs_pos, dtype=float)
        v_rel = np.asarray(sat_vel, dtype=float) - np.asarray(
            gs_vel if gs_vel is not None else (0.0, 0.0, 0.0), dtype=float
        )
        slant_range_km = float(np.linalg.norm(r_vec))
        range_rate_km_s = float(np.dot(v_rel, r_vec / slant_range_km))
        # Doppler shift f_d = -f_c * (v . r_hat) / c: an approaching satellite shifts it up.
        doppler_shift_hz = -self.freq_hz * range_rate_km_s * 1000.0 / self.c

        fspl_db = self.free_space_loss_db(slant_range_km)
        atmospheric_db = self.atmospheric_loss_db(elevation_deg, exceedance_percent)
        path_loss_db = fspl_db + atmospheric_db + self.fixed_losses_db
        cn0_dbhz = self.eirp_dbw - path_loss_db + self.g_over_t_db_k - BOLTZMANN_DBW_PER_HZ_K
        snr_db = cn0_dbhz - 10.0 * math.log10(self.bandwidth_hz)

        return {
            "carrier_hz": self.freq_hz,
            "slant_range_km": slant_range_km,
            "range_rate_km_s": range_rate_km_s,
            "light_time_us": slant_range_km * 1000.0 / self.c * 1e6,
            "doppler_shift_hz": doppler_shift_hz,
            "fspl_db": fspl_db,
            "atmospheric_loss_db": atmospheric_db,
            "path_loss_db": path_loss_db,
            "cn0_dbhz": cn0_dbhz,
            "snr_db": snr_db,
            "rssi_dbm": self.noise_floor_dbm + snr_db,
            # A receiver locked on the genuine carrier tracks it with no phase error.
            "received_phase_error_deg": 0.0,
        }
