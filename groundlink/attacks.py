"""Controlled attacks on the satellite-to-station link.

Every attack takes clean receptions, returns a new list sorted by arrival, and labels the
receptions it produced or altered, so each run carries its own ground truth.

The catalogue is split by which defensive layer is expected to catch it:

- Cryptography catches content attacks: ``tamper``, ``inject``, ``replay``.
- Only link-behaviour detection catches ``relay``, ``delay`` and ``jamming``: the frames
  that arrive are genuine and untouched, so every cryptographic check passes.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .frames import HEADER_SIZE, FrameHeader
from .simulate import Reception


@dataclass(frozen=True)
class Window:
    """Attack interval in station time, end-exclusive."""

    start_s: float
    end_s: float

    def __post_init__(self) -> None:
        if self.end_s <= self.start_s:
            raise ValueError(f"empty attack window: {self.start_s}..{self.end_s}")

    def contains(self, t: float) -> bool:
        return self.start_s <= t < self.end_s


def _sorted(receptions: list[Reception]) -> list[Reception]:
    return sorted(receptions, key=lambda r: r.arrival_s)


def tamper(receptions: list[Reception], window: Window, seed: int = 0) -> list[Reception]:
    """Man-in-the-middle flips one ciphertext byte in every frame it intercepts."""
    rng = np.random.default_rng(seed)
    out = []
    for r in receptions:
        if window.contains(r.arrival_s):
            body = bytearray(r.wire)
            position = int(rng.integers(HEADER_SIZE, len(body)))
            body[position] ^= 0x01
            r = r.with_changes(wire=bytes(body), label="tamper")
        out.append(r)
    return out


def inject(
    receptions: list[Reception],
    window: Window,
    rate_hz: float = 2.0,
    transmitter_rssi_dbm: float = -80.0,
    noise_floor_dbm: float = -110.0,
    seed: int = 0,
) -> list[Reception]:
    """Forge frames from a ground transmitter without the key.

    The forger copies the header format and guesses the next sequence number, but cannot
    produce a valid tag. Transmitting from the ground, its signal carries no orbital
    Doppler at all.
    """
    rng = np.random.default_rng(seed)
    out = list(receptions)
    last = FrameHeader.unpack(receptions[0].wire)
    body_size = len(receptions[0].wire) - HEADER_SIZE

    for t in np.arange(window.start_s, window.end_s, 1.0 / rate_hz):
        for r in receptions:
            if r.arrival_s > t:
                break
            last = FrameHeader.unpack(r.wire)

        forged_header = FrameHeader(
            spacecraft_id=last.spacecraft_id,
            virtual_channel=last.virtual_channel,
            sequence=last.sequence + 1,
            timestamp_us=round(t * 1e6),
        )
        rssi = transmitter_rssi_dbm + float(rng.normal(0.0, 1.0))
        out.append(
            Reception(
                wire=forged_header.pack() + rng.bytes(body_size),
                arrival_s=float(t),
                rssi_dbm=rssi,
                snr_db=rssi - noise_floor_dbm,
                doppler_hz=float(rng.normal(0.0, 20.0)),
                label="inject",
            )
        )
    return _sorted(out)


def replay(
    receptions: list[Reception],
    window: Window,
    recorded_from_s: float = 0.0,
) -> list[Reception]:
    """Retransmit genuine frames recorded earlier in the pass.

    Every replayed frame carries a valid tag. The recorded RF also carries the Doppler of
    the moment it was captured, not the moment it is replayed.
    """
    offset = window.start_s - recorded_from_s
    duration = window.end_s - window.start_s
    replayed = [
        r.with_changes(arrival_s=r.arrival_s + offset, label="replay")
        for r in receptions
        if recorded_from_s <= r.arrival_s < recorded_from_s + duration
    ]
    return _sorted(list(receptions) + replayed)


def relay(
    receptions: list[Reception],
    window: Window,
    extra_delay_s: float = 0.020,
    relay_rssi_dbm: float = -82.0,
    doppler_bias_hz: float = 300.0,
    doppler_noise_hz: float = 100.0,
    noise_floor_dbm: float = -110.0,
    seed: int = 0,
) -> list[Reception]:
    """Man-in-the-middle that forwards genuine frames unchanged.

    The relay decodes and re-transmits from a fixed site near the station, pre-correcting
    the Doppler from public ephemeris — imperfectly. Content and tags are untouched, so
    cryptography sees nothing; the forwarding path shows up in timing, power and Doppler.
    """
    rng = np.random.default_rng(seed)
    out = []
    for r in receptions:
        if window.contains(r.arrival_s):
            rssi = relay_rssi_dbm + float(rng.normal(0.0, 0.5))
            r = r.with_changes(
                arrival_s=r.arrival_s + extra_delay_s,
                rssi_dbm=rssi,
                snr_db=rssi - noise_floor_dbm,
                doppler_hz=r.doppler_hz
                + doppler_bias_hz
                + float(rng.normal(0.0, doppler_noise_hz)),
                label="relay",
            )
        out.append(r)
    return _sorted(out)


def delay(
    receptions: list[Reception],
    window: Window,
    delay_s: float = 0.080,
) -> list[Reception]:
    """Hold genuine frames back and release them late, inside the freshness bound.

    The recorded RF keeps the Doppler of its original arrival, so it no longer matches the
    orbit prediction for the moment it is released.
    """
    out = [
        r.with_changes(arrival_s=r.arrival_s + delay_s, label="delay")
        if window.contains(r.arrival_s)
        else r
        for r in receptions
    ]
    return _sorted(out)


def jamming(
    receptions: list[Reception],
    window: Window,
    jam_db: float = 15.0,
    rssi_rise_db: float = 6.0,
    loss_below_snr_db: float = 3.0,
) -> list[Reception]:
    """Broadband noise over the downlink.

    Signal-to-noise collapses, the receiver sees more total power, and frames that fall
    below the decoding threshold are lost outright.
    """
    out = []
    for r in receptions:
        if window.contains(r.arrival_s):
            snr = r.snr_db - jam_db
            if snr < loss_below_snr_db:
                continue
            r = r.with_changes(snr_db=snr, rssi_dbm=r.rssi_dbm + rssi_rise_db, label="jamming")
        out.append(r)
    return out


ATTACKS = {
    "tamper": tamper,
    "inject": inject,
    "replay": replay,
    "relay": relay,
    "delay": delay,
    "jamming": jamming,
}

CRYPTO_VISIBLE = frozenset({"tamper", "inject", "replay"})
