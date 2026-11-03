"""
ingester.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Telemetry Ingestion and Red-Team Attack Simulation Module

Each packet has two parts:
- the frame the satellite sends (id, sequence number, timestamp, payload, hardware token),
  sealed with an HMAC-SHA256 tag under the key shared by satellite and station;
- what the Zaghouan receiver measures (carrier frequency, RSSI) and when (pass phase).

`attack_mode` is the ground-truth label used only to score the testbed. The detector, the
trust anchor and the zero-trust engine never read it.
"""

from __future__ import annotations

import hashlib
import hmac
import math
import random
import time

NOMINAL_CARRIER_MHZ = 8477.8
HIJACK_OFFSET_MHZ = 14.2
HIJACK_SWEEP_MHZ = 0.35
JAMMED_RSSI_DBM = -96.5
SPOOF_RSSI_DROP_DB = 3.2

SAT_ID = "TERRASAR-X"
SAT_TOKEN = "0x4FE2"
ROGUE_NODE_TOKEN = "0x99A2"

ATTACK_MODES = (
    "normal",
    "frequency_hijacking",
    "stealth_spoofing",
    "noise_jamming",
    "data_tampering",
)

#: Packets per horizon-to-horizon pass.
PASS_PACKETS = 600
#: Peak Doppler of a TerraSAR-X pass (514 km) at 8477.8 MHz: ±199 kHz at the elevation mask.
MAX_DOPPLER_MHZ = 0.199
#: RSSI at culmination and the extra path loss near the horizon.
ZENITH_RSSI_DBM = -74.7
HORIZON_EXTRA_LOSS_DB = 14.0


def predicted_link(pass_phase: float) -> tuple[float, float]:
    """Carrier (MHz) and RSSI (dBm) the station predicts from the orbit at a pass phase in [0, 1).

    The satellite rises at phase 0, culminates at 0.5 and sets at 1: Doppler goes from
    +MAX to -MAX and path loss is lowest overhead.
    """
    angle = math.pi * pass_phase
    carrier = NOMINAL_CARRIER_MHZ + MAX_DOPPLER_MHZ * math.cos(angle)
    rssi = ZENITH_RSSI_DBM - HORIZON_EXTRA_LOSS_DB * (1.0 - math.sin(angle)) ** 1.3
    return carrier, rssi


def frame_bytes(packet: dict) -> bytes:
    """Canonical bytes of the satellite-side frame, the part the MAC covers."""
    return (
        f"{packet['satellite_id']}|{packet['sequence']}|{packet['timestamp']:.6f}|"
        f"{packet['hw_token']}|{packet['payload']}"
    ).encode()


def seal(key: bytes, packet: dict) -> str:
    return hmac.new(key, frame_bytes(packet), hashlib.sha256).hexdigest()


class TelemetryIngester:
    def __init__(
        self,
        sat_id: str = SAT_ID,
        ground_station: str = "Zaghouan-01",
        key: bytes | None = None,
        seed: int | None = None,
    ):
        self.sat_id = sat_id
        self.ground_station = ground_station
        self.rng = random.Random(seed)
        # Shared satellite/station secret (an HSM holds it in a real deployment).
        self.key = key if key is not None else self.rng.randbytes(32)
        # The attacker has a key of its own, never the shared one.
        self.attacker_key = self.rng.randbytes(32)
        self.packet_seq = 1000
        self.tick = 0

    def generate_packet(self, attack_mode: str = "normal") -> dict:
        """Generates one packet as received at the station, optionally under attack."""
        if attack_mode not in ATTACK_MODES:
            raise ValueError(f"unknown attack mode: {attack_mode}")
        rng = self.rng
        pass_phase = (self.tick % PASS_PACKETS) / PASS_PACKETS
        self.tick += 1
        carrier_model, rssi_model = predicted_link(pass_phase)

        # Measured values: orbit prediction plus receiver noise.
        freq = carrier_model + rng.uniform(-0.02, 0.02)
        rssi = rssi_model + rng.uniform(-1.2, 1.2)

        sat_id = self.sat_id
        token = SAT_TOKEN
        key = self.key
        self.packet_seq += 1
        seq = self.packet_seq

        if attack_mode == "frequency_hijacking":
            # A rogue carrier sweeping around +14.2 MHz captures the receiver; its frames are
            # sealed with the attacker's key.
            freq += HIJACK_OFFSET_MHZ + HIJACK_SWEEP_MHZ * math.sin(self.tick * 0.9)
            rssi += 9.0
            key = self.attacker_key
        elif attack_mode == "stealth_spoofing":
            # Node 0x99A2 claims to be the satellite on the same channel, forging MAC headers
            # and reusing recent nonces. Its RF stays close to the orbit prediction.
            freq += rng.uniform(-0.02, 0.02)
            rssi -= SPOOF_RSSI_DROP_DB
            token = ROGUE_NODE_TOKEN
            key = self.attacker_key
            self.packet_seq -= 1  # injected alongside the genuine stream
            seq = self.packet_seq - rng.randint(0, 20)
        elif attack_mode == "noise_jamming":
            # Broadband Gaussian noise saturates the front end: the genuine carrier collapses.
            freq += rng.gauss(0.0, 0.8)
            rssi = JAMMED_RSSI_DBM + rng.uniform(-0.5, 0.5)
        # data_tampering leaves the RF alone: the genuine satellite sends the frame, and a relay
        # in the path alters it after sealing (below).

        packet = {
            "sequence": seq,
            "timestamp": time.time(),
            "satellite_id": sat_id,
            "hw_token": token,
            "payload": rng.randbytes(16).hex(),
            "target_node": self.ground_station,
            "pass_phase": pass_phase,
            "carrier_frequency_mhz": round(freq, 4),
            "rssi_dbm": round(rssi, 2),
            "attack_mode": attack_mode,
        }
        packet["mac"] = seal(key, packet)
        if attack_mode == "data_tampering":
            # One payload bit flipped in transit, after the satellite sealed the frame.
            payload = bytearray.fromhex(packet["payload"])
            payload[rng.randrange(len(payload))] ^= 1 << rng.randrange(8)
            packet["payload"] = payload.hex()
        # Digest of the frame as it reached the station.
        packet["sha256_hash"] = hashlib.sha256(frame_bytes(packet)).hexdigest()
        return packet

    def stream_telemetry(self, attack_mode: str = "normal", interval: float = 1.0):
        """Continuous generator stream for dashboard or detector ingestion."""
        while True:
            yield self.generate_packet(attack_mode)
            time.sleep(interval)


if __name__ == "__main__":
    ingester = TelemetryIngester(seed=14)
    print("=== TSYP 14 Testbed: Ingestion Stream Initialized ===")
    print(f"Target Ground Node: {ingester.ground_station}, Tunisia")
    for _ in range(3):
        print(ingester.generate_packet(attack_mode="normal"))
