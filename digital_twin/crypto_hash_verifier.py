"""
crypto_hash_verifier.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin, phase 2: the data layer. A SHA-256 digest and an HMAC-SHA256 tag on every packet.

Both cover the CCSDS headers and the user data, telemetry down or commands up, so a changed
sequence count breaks them as surely as a changed reading or a rewritten command. The
digest detects corruption; only the tag proves origin, because it needs the key shared by
satellite and station: anyone can recompute a CRC or a SHA-256, nobody without the key can
produce a valid tag. Comparisons are constant-time.
The key is never in the source code: pass it in, set GROUNDLINK_HMAC_KEY (hex), or get a
fresh random 256-bit key for the run.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets

from .ccsds_framing import canonical_json

logger = logging.getLogger("CryptoIntegrityVerifier")

KEY_ENV = "GROUNDLINK_HMAC_KEY"
COVERED_FIELDS = ("ccsds_header", "secondary_header", "payload")


def covered_bytes(packet: dict) -> bytes:
    """Canonical bytes of the packet fields the digest and the tag protect."""
    return canonical_json({field: packet[field] for field in COVERED_FIELDS})


def sha256_digest(packet: dict) -> str:
    return hashlib.sha256(covered_bytes(packet)).hexdigest()


class CryptoIntegrityVerifier:
    def __init__(self, secret_shared_key: bytes | str | None = None):
        if secret_shared_key is None:
            from_env = os.environ.get(KEY_ENV)
            secret_shared_key = bytes.fromhex(from_env) if from_env else secrets.token_bytes(32)
        elif isinstance(secret_shared_key, str):
            secret_shared_key = secret_shared_key.encode("utf-8")
        if len(secret_shared_key) < 16:
            raise ValueError("the shared key must be at least 128 bits")
        self.secret_key = secret_shared_key

    def compute_packet_hash(self, packet: dict) -> str:
        return sha256_digest(packet)

    def generate_hmac_signature(self, packet: dict) -> str:
        return hmac.new(self.secret_key, covered_bytes(packet), hashlib.sha256).hexdigest()

    def seal_packet(self, packet: dict) -> dict:
        """What the satellite sends: the packet with its digest and tag."""
        return {
            **packet,
            "sha256_hash": self.compute_packet_hash(packet),
            "hmac_sha256": self.generate_hmac_signature(packet),
        }

    def verify_packet_integrity(
        self, incoming_packet: dict, r_hash: str | None = None, r_sig: str | None = None
    ) -> dict:
        r_hash = incoming_packet.get("sha256_hash", "") if r_hash is None else r_hash
        r_sig = incoming_packet.get("hmac_sha256", "") if r_sig is None else r_sig
        is_hash_valid = hmac.compare_digest(self.compute_packet_hash(incoming_packet), r_hash)
        is_sig_valid = hmac.compare_digest(self.generate_hmac_signature(incoming_packet), r_sig)
        passed = is_hash_valid and is_sig_valid
        return {
            "layer": "Data Layer (Crypto)",
            "hash_valid": is_hash_valid,
            "signature_valid": is_sig_valid,
            "integrity_passed": passed,
            "verdict": "CRYPTOGRAPHIC_VERIFIED" if passed else "CRYPTO_INTEGRITY_BREACH",
        }
