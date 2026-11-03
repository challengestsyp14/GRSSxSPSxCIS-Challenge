"""Telemetry frame layout on the satellite-to-station link.

The header travels in the clear so the station can route and order frames before
decrypting, but it is bound into the authentication tag as associated data, so any change
to it is detected exactly like a change to the payload.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

# spacecraft id, virtual channel, sequence number, transmit timestamp (microseconds)
_HEADER = struct.Struct(">HBQQ")

HEADER_SIZE = _HEADER.size
TAG_SIZE = 16


@dataclass(frozen=True)
class FrameHeader:
    spacecraft_id: int
    virtual_channel: int
    sequence: int
    timestamp_us: int

    @property
    def timestamp_s(self) -> float:
        return self.timestamp_us / 1e6

    def pack(self) -> bytes:
        return _HEADER.pack(
            self.spacecraft_id, self.virtual_channel, self.sequence, self.timestamp_us
        )

    @classmethod
    def unpack(cls, data: bytes) -> FrameHeader:
        if len(data) < HEADER_SIZE:
            raise ValueError(f"header needs {HEADER_SIZE} bytes, got {len(data)}")
        return cls(*_HEADER.unpack(data[:HEADER_SIZE]))
