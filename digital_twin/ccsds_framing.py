"""
ccsds_framing.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin, phase 1: CCSDS space packets (CCSDS 133.0-B-2) with a packet error control word.

Primary header (6 octets): version 0, packet type (0 telemetry down, 1 telecommand up),
secondary header present, 11-bit APID, unsegmented sequence flags, 14-bit sequence count,
data length. The secondary header is a CCSDS unsegmented time code (CUC, 4 + 2 octets from
the 1958 epoch); the user data is the telemetry or the command as canonical JSON; the
packet ends with a CRC-16/CCITT word over everything before it. The CRC catches
transmission errors only: anyone can recompute it, which is why the crypto layer exists.
"""

from __future__ import annotations

import json
import logging
import struct
import time

logger = logging.getLogger("CCSDSFramer")

#: Seconds from the CCSDS epoch (1958-01-01) to the Unix epoch.
CCSDS_EPOCH_OFFSET_S = 378_691_200
SEQUENCE_MODULO = 1 << 14
UNSEGMENTED = 0b11
TELEMETRY, TELECOMMAND = 0, 1


def crc16_ccitt(data: bytes, crc: int = 0xFFFF) -> int:
    """CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, no reflection."""
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else crc << 1
            crc &= 0xFFFF
    return crc


def canonical_json(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()


def packet_time(packet: dict) -> float:
    """Unix time of a packet, from its CUC secondary header."""
    secondary = packet["secondary_header"]
    return secondary["cuc_coarse_s"] + secondary["cuc_fine"] / 65536 - CCSDS_EPOCH_OFFSET_S


class CCSDSFrameHandler:
    def __init__(self, space_craft_id: int = 42, apid: int = 0x073):
        if not 0 <= apid < 2048:
            raise ValueError("APID is an 11-bit field")
        # The spacecraft id travels in the transfer frame around these packets.
        self.sc_id = space_craft_id
        self.apid = apid

    def build_telemetry_packet(
        self, sequence_count: int, payload_data: dict, timestamp: float | None = None
    ) -> dict:
        """Formats telemetry into a CCSDS space packet with a CRC-16 error control word."""
        return self._build_packet(TELEMETRY, sequence_count, payload_data, timestamp)

    def build_telecommand_packet(
        self, sequence_count: int, command: dict, timestamp: float | None = None
    ) -> dict:
        """Formats an uplink command into a CCSDS telecommand space packet (type 1)."""
        return self._build_packet(TELECOMMAND, sequence_count, command, timestamp)

    def _build_packet(
        self, packet_type: int, sequence_count: int, payload_data: dict, timestamp: float | None
    ) -> dict:
        timestamp = time.time() if timestamp is None else timestamp
        sequence_count %= SEQUENCE_MODULO
        ccsds_seconds = timestamp + CCSDS_EPOCH_OFFSET_S
        coarse = int(ccsds_seconds)
        fine = int((ccsds_seconds - coarse) * 65536) & 0xFFFF
        user_data = canonical_json(payload_data)
        data_field = struct.pack(">IH", coarse, fine) + user_data
        primary_header = {
            "version_number": 0,
            "packet_type": packet_type,
            "sec_header_flag": 1,
            "apid": self.apid,
            "sequence_flags": UNSEGMENTED,
            "sequence_count": sequence_count,
            # Octets in the data field (secondary header, user data and CRC) minus one.
            "packet_data_length": len(data_field) + 2 - 1,
        }
        body = self._pack_header(primary_header) + data_field
        crc = crc16_ccitt(body)
        raw = body + struct.pack(">H", crc)
        return {
            "spacecraft_id": self.sc_id,
            "ccsds_header": primary_header,
            "secondary_header": {"cuc_coarse_s": coarse, "cuc_fine": fine},
            # Its own copy, exactly as encoded: later edits to the caller's dict do not leak in.
            "payload": json.loads(user_data),
            "crc_16": f"0x{crc:04X}",
            "raw_hex": raw.hex(),
        }

    def rebuild(self, packet: dict) -> dict:
        """Re-encodes a packet after its fields changed, with a freshly computed CRC."""
        header = packet["ccsds_header"]
        rebuilt = self._build_packet(
            header["packet_type"], header["sequence_count"], packet["payload"], packet_time(packet)
        )
        return {**packet, **{k: rebuilt[k] for k in ("ccsds_header", "crc_16", "raw_hex")}}

    @staticmethod
    def parse_telemetry_packet(raw: bytes) -> dict:
        """Decodes a raw space packet, telemetry or telecommand, and checks its CRC."""
        if len(raw) < 6 + 6 + 2:
            raise ValueError("packet shorter than its headers")
        word0, word1, length = struct.unpack(">HHH", raw[:6])
        if length + 7 != len(raw):
            raise ValueError("packet data length field does not match the packet size")
        coarse, fine = struct.unpack(">IH", raw[6:12])
        (received_crc,) = struct.unpack(">H", raw[-2:])
        computed_crc = crc16_ccitt(raw[:-2])
        return {
            "ccsds_header": {
                "version_number": word0 >> 13,
                "packet_type": (word0 >> 12) & 1,
                "sec_header_flag": (word0 >> 11) & 1,
                "apid": word0 & 0x7FF,
                "sequence_flags": word1 >> 14,
                "sequence_count": word1 & 0x3FFF,
                "packet_data_length": length,
            },
            "secondary_header": {"cuc_coarse_s": coarse, "cuc_fine": fine},
            "payload": json.loads(raw[12:-2]),
            "crc_16": f"0x{received_crc:04X}",
            "crc_valid": received_crc == computed_crc,
        }

    @staticmethod
    def _pack_header(header: dict) -> bytes:
        word0 = (
            (header["version_number"] << 13)
            | (header["packet_type"] << 12)
            | (header["sec_header_flag"] << 11)
            | header["apid"]
        )
        word1 = (header["sequence_flags"] << 14) | header["sequence_count"]
        return struct.pack(">HHH", word0, word1, header["packet_data_length"])
