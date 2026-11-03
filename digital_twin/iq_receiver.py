"""
iq_receiver.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin: the receiver at sample level. Instead of adding noise to the link figures, the
twin builds each frame's waveform and the station measures it, as a real modem does.

Transmitter: QPSK at 50 ksym/s, Gray mapped, root-raised-cosine pulses (roll-off 0.35, 8 symbols
long, 8 samples a symbol). Each frame opens with a known preamble, the CCSDS attached sync
marker 0x1ACFFC1D four times (64 symbols), followed by 960 data symbols.

Channel: what reaches the antenna, set by the orbit and by whoever transmits.
- The carrier: the true Doppler (SGP4 plus the satellite oscillator's offset) against the
  receiver's numerically controlled oscillator, which follows the SGP4 prediction.
- The arrival time: the true light time against the predicted one, a fractional delay of the
  pulse train.
- The carrier phase against the receiver's reference.
- The power: Es/N0 from the link budget, minus what a jammer adds to the noise; AWGN.
- A second carrier on the channel when an attacker shares it (co-channel capture).
The wide acquisition search (an FFT over the Doppler uncertainty, the frame-sync search over a
frame period) is modelled at its output: the bin it locks to, 200 Hz wide, and the whole symbol
the sync marker falls on. Everything finer is measured from the samples.

Receiver:
- matched filter, then the preamble correlator, non-coherent, with parabolic interpolation of
  its peak: the arrival time to a fraction of a symbol;
- the matched filter again, shifted by that fraction, and one sample a symbol;
- a data-aided estimate of frequency and phase over the preamble (a line through the unwrapped
  phase of the received preamble against the known one);
- a second-order phase-locked loop over the whole frame, data-aided on the preamble and
  decision-directed after it, which refines the frequency and phase;
- the M2M4 moments estimator of the SNR, blind, on the symbol samples;
- the EVM from the constellation after the loop, against the nearest QPSK point.

The measured link it returns has the same fields as the measurement model's: range, Doppler,
carrier power (the receiver's noise floor plus its SNR estimate, as in physics_validator.py),
SNR, phase error, EVM. The residuals of the tiers come from these measurements.
"""

from __future__ import annotations

import math

import numpy as np

SPEED_OF_LIGHT_KM_S = 299_792.458

SYMBOL_RATE = 50_000.0
SAMPLES_PER_SYMBOL = 8
ROLL_OFF = 0.35
SPAN_SYMBOLS = 8
#: CCSDS attached sync marker, sent four times as the preamble.
ASM = 0x1ACFFC1D
PREAMBLE_REPEATS = 4
DATA_SYMBOLS = 960
#: Width of the acquisition FFT's bin, Hz: the carrier offset is found to this, then measured.
ACQUISITION_BIN_HZ = 200.0
#: The correlator searches this many symbols either side of the expected sync position.
TIMING_SEARCH_SYMBOLS = 2
#: Phase-locked loop: noise bandwidth times symbol period, damping.
PLL_BN_T = 0.004
PLL_DAMPING = 0.707

_QPSK = np.array([1 + 1j, -1 + 1j, 1 - 1j, -1 - 1j]) / math.sqrt(2.0)


def rrc_taps(delay_samples: float = 0.0) -> np.ndarray:
    """Root-raised-cosine pulse at SAMPLES_PER_SYMBOL, unit energy, shifted by a fraction."""
    sps, beta = SAMPLES_PER_SYMBOL, ROLL_OFF
    n = np.arange(-SPAN_SYMBOLS * sps // 2, SPAN_SYMBOLS * sps // 2 + 1, dtype=float)
    t = (n - delay_samples) / sps
    h = np.empty_like(t)
    for i, x in enumerate(t):
        if abs(x) < 1e-9:
            h[i] = 1.0 - beta + 4.0 * beta / math.pi
        elif abs(abs(4.0 * beta * x) - 1.0) < 1e-9:
            h[i] = (beta / math.sqrt(2.0)) * (
                (1 + 2 / math.pi) * math.sin(math.pi / (4 * beta))
                + (1 - 2 / math.pi) * math.cos(math.pi / (4 * beta))
            )
        else:
            h[i] = (
                math.sin(math.pi * x * (1 - beta))
                + 4 * beta * x * math.cos(math.pi * x * (1 + beta))
            ) / (math.pi * x * (1 - (4 * beta * x) ** 2))
    return h / math.sqrt(np.sum(h * h))


_RRC = rrc_taps()
_HALF = len(_RRC) // 2


def preamble_symbols() -> np.ndarray:
    bits = [(ASM >> (31 - i)) & 1 for i in range(32)] * PREAMBLE_REPEATS
    pairs = np.array(bits).reshape(-1, 2)
    return _QPSK[pairs[:, 0] * 2 + pairs[:, 1]]


_PREAMBLE = preamble_symbols()
N_PREAMBLE = len(_PREAMBLE)
N_SYMBOLS = N_PREAMBLE + DATA_SYMBOLS


def _wrap(phase: float) -> float:
    return (phase + math.pi) % (2.0 * math.pi) - math.pi


def _decide(z: np.ndarray) -> np.ndarray:
    return (np.sign(z.real) + 1j * np.sign(z.imag)) / math.sqrt(2.0)


class Carrier:
    """One transmitter as the receiver sees it, after acquisition."""

    def __init__(self, snr_db, offset_hz, delay_symbols, phase_rad, symbols):
        self.snr_db = snr_db
        self.offset_hz = offset_hz
        self.delay_symbols = delay_symbols
        self.phase_rad = phase_rad
        self.symbols = symbols

    def waveform(self, n_samples: int) -> np.ndarray:
        sps = SAMPLES_PER_SYMBOL
        up = np.zeros(n_samples, dtype=complex)
        start = 2 * SPAN_SYMBOLS * sps
        whole = int(math.floor(self.delay_symbols * sps))
        frac = self.delay_symbols * sps - whole
        idx = start + whole + sps * np.arange(len(self.symbols))
        keep = (idx >= 0) & (idx < n_samples)
        up[idx[keep]] = self.symbols[keep]
        tx = np.convolve(up, rrc_taps(frac), mode="same")
        # Carrier phase and offset referred to the first symbol of the frame.
        n = np.arange(n_samples) - start
        amplitude = math.sqrt(10.0 ** (self.snr_db / 10.0))
        rot = np.exp(1j * (2 * math.pi * self.offset_hz / (SYMBOL_RATE * sps) * n + self.phase_rad))
        return amplitude * tx * rot


class IqReceiver:
    """Builds each frame's samples from the link and measures them."""

    def __init__(self, seed: int, noise_floor_dbm: float):
        self.rng = np.random.default_rng(seed)
        self.noise_floor_dbm = noise_floor_dbm
        n_tx = N_SYMBOLS + 4 * SPAN_SYMBOLS
        self.n_samples = n_tx * SAMPLES_PER_SYMBOL
        #: The last frame's constellation, after the loop, for the figures.
        self.last_constellation: np.ndarray | None = None

    # -------------------------------------------------------------- the channel

    def _data(self) -> np.ndarray:
        return _QPSK[self.rng.integers(0, 4, DATA_SYMBOLS)]

    def _acquire(self, offset_hz: float, delay_s: float) -> tuple[float, float, float, float]:
        """Acquisition: the 200 Hz bin and the whole symbol it locks to, and what is left."""
        coarse_f = ACQUISITION_BIN_HZ * round(offset_hz / ACQUISITION_BIN_HZ)
        delay_sym = delay_s * SYMBOL_RATE
        coarse_t = float(round(delay_sym))
        return coarse_f, offset_hz - coarse_f, coarse_t, delay_sym - coarse_t

    def samples(self, link: dict, predicted: dict, interferer: dict | None = None):
        """The frame's complex baseband samples after acquisition, and what acquisition found."""
        offset = float(link["doppler_shift_hz"]) - float(predicted["doppler_shift_hz"])
        delay = (float(link["slant_range_km"]) - float(predicted["slant_range_km"])) / (
            SPEED_OF_LIGHT_KM_S
        )
        coarse_f, fine_f, coarse_t, fine_t = self._acquire(offset, delay)
        phase = math.radians(float(link["received_phase_error_deg"]))
        main = Carrier(
            float(link["snr_db"]),
            fine_f,
            fine_t,
            phase,
            np.concatenate([_PREAMBLE, self._data()]),
        )
        x = main.waveform(self.n_samples)
        if interferer is not None:
            # Another carrier on the channel, relative to the one the receiver locked to.
            other = Carrier(
                float(link["snr_db"]) - float(interferer["below_db"]),
                fine_f - float(interferer["offset_hz"]),
                fine_t + float(self.rng.uniform(-0.5, 0.5)),
                float(self.rng.uniform(-math.pi, math.pi)),
                np.concatenate([_PREAMBLE, self._data()]),
            )
            x = x + other.waveform(self.n_samples)
        noise = (
            self.rng.normal(size=self.n_samples) + 1j * self.rng.normal(size=self.n_samples)
        ) / math.sqrt(2.0)
        return x + noise, coarse_f, coarse_t

    # -------------------------------------------------------------- the receiver

    def _timing(self, mf: np.ndarray) -> float:
        """Preamble correlator on the matched-filter output: arrival, in fractional symbols."""
        sps = SAMPLES_PER_SYMBOL
        start = 2 * SPAN_SYMBOLS * sps
        lags = np.arange(-TIMING_SEARCH_SYMBOLS * sps, TIMING_SEARCH_SYMBOLS * sps + 1)
        ref = np.conj(_PREAMBLE)
        taps = sps * np.arange(N_PREAMBLE)
        corr = np.array([abs(np.dot(mf[start + lag + taps], ref)) for lag in lags])
        k = int(np.argmax(corr))
        frac = 0.0
        if 0 < k < len(corr) - 1:
            a, b, c = corr[k - 1], corr[k], corr[k + 1]
            denom = a - 2 * b + c
            frac = 0.5 * (a - c) / denom if denom != 0 else 0.0
        return (lags[k] + frac) / sps

    def _symbols(self, r: np.ndarray, delay_sym: float) -> np.ndarray:
        """Matched filter shifted by the measured arrival, one sample a symbol."""
        sps = SAMPLES_PER_SYMBOL
        whole = int(math.floor(delay_sym * sps))
        frac = delay_sym * sps - whole
        mf = np.convolve(r, rrc_taps(frac)[::-1], mode="same")
        start = 2 * SPAN_SYMBOLS * sps + whole
        return mf[start + sps * np.arange(N_SYMBOLS)]

    @staticmethod
    def _preamble_fit(y: np.ndarray) -> tuple[float, float]:
        """Frequency (rad a symbol) and phase (rad, at the frame's first symbol), data-aided."""
        z = y[:N_PREAMBLE] * np.conj(_PREAMBLE)
        ph = np.unwrap(np.angle(z))
        k = np.arange(N_PREAMBLE)
        slope, intercept = np.polyfit(k, ph, 1)
        return float(slope), float(intercept)

    @staticmethod
    def _pll(y: np.ndarray, freq: float, phase: float) -> tuple[np.ndarray, float, float]:
        """Second-order loop over the frame: data-aided on the preamble, then decision-directed.
        Returns the de-rotated symbols and a line through the loop's phase track: its slope,
        the frequency (rad a symbol), and its value at the frame's first symbol, the phase."""
        theta_n = 2 * math.pi * PLL_BN_T / (PLL_DAMPING + 1 / (4 * PLL_DAMPING))
        k1 = 2 * PLL_DAMPING * theta_n
        k2 = theta_n * theta_n
        out = np.empty(len(y), dtype=complex)
        track = np.empty(len(y))
        pre = _PREAMBLE
        theta, nu = phase, freq
        yr, yi = y.real.tolist(), y.imag.tolist()
        s2 = 1 / math.sqrt(2.0)
        for i in range(len(y)):
            c, s = math.cos(theta), math.sin(theta)
            zr = yr[i] * c + yi[i] * s
            zi = yi[i] * c - yr[i] * s
            out[i] = complex(zr, zi)
            track[i] = theta
            if i < N_PREAMBLE:
                ar, ai = pre[i].real, pre[i].imag
            else:
                ar = s2 if zr >= 0 else -s2
                ai = s2 if zi >= 0 else -s2
            # Phase detector: angle of z against the reference symbol.
            err = math.atan2(zi * ar - zr * ai, zr * ar + zi * ai)
            nu += k2 * err
            theta += nu + k1 * err
        slope, intercept = np.polyfit(np.arange(len(y)), track, 1)
        return out, float(slope), float(intercept)

    @staticmethod
    def m2m4_snr_db(y: np.ndarray) -> float:
        """Blind M2M4 estimate of Es/N0 for a constant-modulus signal in complex AWGN."""
        p = np.abs(y) ** 2
        m2, m4 = float(np.mean(p)), float(np.mean(p * p))
        s = math.sqrt(max(2.0 * m2 * m2 - m4, 1e-12))
        n = max(m2 - s, 1e-12)
        return 10.0 * math.log10(s / n)

    @staticmethod
    def evm_pct(z: np.ndarray) -> float:
        """RMS error vector against the nearest QPSK point, per cent of the RMS symbol."""
        scale = math.sqrt(float(np.mean(np.abs(z) ** 2)))
        if scale == 0:
            return 100.0
        zn = z / scale
        err = zn - _decide(zn)
        return 100.0 * math.sqrt(float(np.mean(np.abs(err) ** 2)))

    def measure(self, link: dict, predicted: dict, interferer: dict | None = None) -> dict:
        """What the station measures of this frame, from its samples."""
        r, coarse_f, coarse_t = self.samples(link, predicted, interferer)
        mf = np.convolve(r, _RRC[::-1], mode="same")
        fine_t = self._timing(mf)
        y = self._symbols(r, fine_t)
        freq, phase = self._preamble_fit(y)
        z, freq, phase = self._pll(y, freq, phase)
        self.last_constellation = z
        snr = self.m2m4_snr_db(y)
        delay_s = (coarse_t + fine_t) / SYMBOL_RATE
        offset_hz = coarse_f + freq * SYMBOL_RATE / (2 * math.pi)
        measured = dict(link)
        measured.update(
            slant_range_km=float(predicted["slant_range_km"]) + delay_s * SPEED_OF_LIGHT_KM_S,
            light_time_us=float(predicted["slant_range_km"]) / 0.299792458 + delay_s * 1e6,
            doppler_shift_hz=float(predicted["doppler_shift_hz"]) + offset_hz,
            snr_db=snr,
            rssi_dbm=self.noise_floor_dbm + snr,
            received_phase_error_deg=math.degrees(_wrap(phase)),
            evm_pct=self.evm_pct(z[N_PREAMBLE:]),
        )
        return measured
