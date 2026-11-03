"""
trust_anchor.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Cryptographic Ledger and Hash Chaining Module

Two jobs:
- authenticate every frame: HMAC-SHA256 tag under the key shared with the satellite (constant-
  time compare), then an anti-replay window on the sequence number (the nonce);
- record every frame, accepted or rejected, in a SHA-256 hash chain rooted in a genesis block,
  so any later edit to the record is detectable.
"""

from __future__ import annotations

import hashlib
import hmac
import json

from .ingester import TelemetryIngester, seal

GENESIS_PAYLOAD = "GENESIS_ROOT_ANCHOR_TUNISIA_GS01"
ZERO_HASH = "0" * 64


class ReplayWindow:
    """Rejects sequence numbers already seen or older than the window."""

    def __init__(self, size: int = 64):
        self.size = size
        self.high = -1
        self.seen: set[int] = set()

    def accept(self, seq: int) -> bool:
        if seq <= self.high - self.size or seq in self.seen:
            return False
        self.seen.add(seq)
        if seq > self.high:
            self.high = seq
            self.seen = {s for s in self.seen if s > self.high - self.size}
        return True


class TrustAnchorLedger:
    def __init__(self, key: bytes):
        self.key = key
        self.replay = ReplayWindow()
        self.chain: list[dict] = [
            {
                "index": 0,
                "previous_hash": ZERO_HASH,
                "payload": GENESIS_PAYLOAD,
                "hash": self._hash_block(ZERO_HASH, GENESIS_PAYLOAD),
            }
        ]

    @property
    def genesis_root(self) -> str:
        return self.chain[0]["hash"]

    @staticmethod
    def _hash_block(prev_hash: str, payload) -> str:
        """SHA-256 binding the previous block to this payload (canonical JSON)."""
        body = payload if isinstance(payload, str) else json.dumps(payload, sort_keys=True)
        return hashlib.sha256(f"{prev_hash}:{body}".encode()).hexdigest()

    def authenticate(self, packet: dict) -> tuple[bool, str]:
        """MAC first, so a forged frame can never burn a genuine nonce; then freshness."""
        if not hmac.compare_digest(packet["mac"], seal(self.key, packet)):
            return False, "MAC_MISMATCH"
        if not self.replay.accept(packet["sequence"]):
            return False, "STALE_OR_REUSED_NONCE"
        return True, "AUTHENTIC"

    def append_packet(self, packet: dict, verdict: str) -> dict:
        """Appends a frame and its verdict to the chain."""
        prev_hash = self.chain[-1]["hash"]
        payload = {
            key: packet[key]
            for key in ("sequence", "satellite_id", "hw_token", "sha256_hash", "mac")
        } | {"verdict": verdict}
        block = {
            "index": len(self.chain),
            "previous_hash": prev_hash,
            "payload": payload,
            "hash": self._hash_block(prev_hash, payload),
        }
        self.chain.append(block)
        return block

    def ingest(self, packet: dict) -> tuple[dict, bool, str]:
        """Authenticates a frame and records it; returns (block, authentic, reason)."""
        ok, reason = self.authenticate(packet)
        return self.append_packet(packet, reason), ok, reason

    def verify_chain(self) -> tuple[bool, str]:
        """Verifies the structural integrity of the entire ledger."""
        genesis = self.chain[0]
        if genesis["hash"] != self._hash_block(ZERO_HASH, GENESIS_PAYLOAD):
            return False, "Genesis block altered."
        for i in range(1, len(self.chain)):
            block = self.chain[i]
            if block["previous_hash"] != self.chain[i - 1]["hash"]:
                return False, f"Chain broken at index {i}: previous hash mismatch."
            if block["hash"] != self._hash_block(block["previous_hash"], block["payload"]):
                return False, f"Tampering detected at index {i}: hash mismatch."
        return True, "Ledger integrity verified: every block links back to the genesis root."


if __name__ == "__main__":
    ingester = TelemetryIngester(seed=14)
    ledger = TrustAnchorLedger(ingester.key)
    print("=== Trust Anchor Ledger Initialized ===")
    print(f"Genesis root: {ledger.genesis_root}")
    for _ in range(3):
        block, ok, reason = ledger.ingest(ingester.generate_packet("normal"))
        print(f"Added Block #{block['index']} | {reason} | Hash: {block['hash'][:16]}...")
    print("\nLedger Verification Status:", ledger.verify_chain()[1])
