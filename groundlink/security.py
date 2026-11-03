"""Link-layer security: AES-256-GCM authenticated encryption with anti-replay.

Modelled on the approach of CCSDS Space Data Link Security: every frame is encrypted and
authenticated under a shared key, the nonce is derived from a sequence counter that never
repeats, and the receiver rejects anything whose counter it has already passed.

This layer proves a frame's *content* is genuine. It cannot see an attacker who forwards
genuine frames unchanged, delays them, or jams the link — that is the detector's job.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .frames import HEADER_SIZE, TAG_SIZE, FrameHeader

_VALID_KEY_SIZES = (16, 24, 32)


class Status(StrEnum):
    OK = "ok"
    MALFORMED = "malformed"
    AUTH_FAIL = "auth_fail"
    REPLAY = "replay"
    STALE = "stale"


def _nonce(sequence: int) -> bytes:
    # 96-bit GCM nonce from the 64-bit counter. Unique per key for as long as the counter
    # is never reused — which the anti-replay rule on the receiver side also enforces.
    return b"\x00\x00\x00\x00" + sequence.to_bytes(8, "big")


def _check_key(key: bytes) -> None:
    if len(key) not in _VALID_KEY_SIZES:
        raise ValueError(f"AES key must be 16, 24 or 32 bytes, got {len(key)}")


class LinkProtector:
    """Spacecraft side: seals each outgoing frame."""

    def __init__(self, key: bytes, spacecraft_id: int, virtual_channel: int = 0) -> None:
        _check_key(key)
        self._aead = AESGCM(key)
        self._spacecraft_id = spacecraft_id
        self._virtual_channel = virtual_channel

    def protect(self, sequence: int, timestamp_s: float, payload: bytes) -> bytes:
        header = FrameHeader(
            spacecraft_id=self._spacecraft_id,
            virtual_channel=self._virtual_channel,
            sequence=sequence,
            timestamp_us=round(timestamp_s * 1e6),
        ).pack()
        return header + self._aead.encrypt(_nonce(sequence), payload, header)


@dataclass(frozen=True)
class Verdict:
    status: Status
    header: FrameHeader | None
    payload: bytes | None


class LinkVerifier:
    """Station side: authenticates, decrypts and orders incoming frames.

    ``max_age_s`` bounds how far a frame's authenticated timestamp may sit from its arrival.
    It rejects gross delays and stale replays, but any delay smaller than this bound passes
    the cryptographic layer by construction.
    """

    def __init__(self, key: bytes, max_age_s: float = 0.5) -> None:
        _check_key(key)
        self._aead = AESGCM(key)
        self._max_age_s = max_age_s
        self._highest_sequence = -1

    def verify(self, wire: bytes, arrival_s: float) -> Verdict:
        if len(wire) < HEADER_SIZE + TAG_SIZE:
            return Verdict(Status.MALFORMED, None, None)

        header = FrameHeader.unpack(wire)
        try:
            payload = self._aead.decrypt(
                _nonce(header.sequence), wire[HEADER_SIZE:], wire[:HEADER_SIZE]
            )
        except InvalidTag:
            return Verdict(Status.AUTH_FAIL, header, None)

        if header.sequence <= self._highest_sequence:
            return Verdict(Status.REPLAY, header, None)

        if abs(arrival_s - header.timestamp_s) > self._max_age_s:
            return Verdict(Status.STALE, header, None)

        # Only a frame that passed every check may advance the replay window.
        self._highest_sequence = header.sequence
        return Verdict(Status.OK, header, payload)
