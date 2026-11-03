"""
audit_logger.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin, phase 3: the forensic audit trail, one JSON line per security decision.

Append-only and tamper-evident: every entry carries the SHA-256 of the one before it,
hashed the way the trust anchor hashes its ledger blocks and rooted in the same genesis
block, so editing, deleting or reordering any past line breaks the chain from that point.
Reopening an existing file continues its chain.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path

from testbed.trust_anchor import GENESIS_PAYLOAD, ZERO_HASH, TrustAnchorLedger

logger = logging.getLogger("AuditLogger")

GENESIS_HASH = TrustAnchorLedger._hash_block(ZERO_HASH, GENESIS_PAYLOAD)


def _plain(value):
    """JSON fallback for numpy scalars."""
    if hasattr(value, "item"):
        return value.item()
    raise TypeError(f"{type(value).__name__} is not JSON serialisable")


def _normalise(record: dict) -> dict:
    """The record exactly as it will read back from JSON, so its hash can be re-verified."""
    return json.loads(json.dumps(record, default=_plain))


class AuditLogger:
    def __init__(self, log_filepath: str | Path = "security_audit.jsonl"):
        self.log_filepath = Path(log_filepath)
        self._lock = threading.Lock()
        self._index, self._last_hash = 0, GENESIS_HASH
        if self.log_filepath.exists():
            for entry in self._entries():
                self._index, self._last_hash = entry["index"] + 1, entry["entry_hash"]

    def _entries(self):
        with self.log_filepath.open(encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    yield json.loads(line)

    def log_telemetry_event(self, simulation_results: dict) -> dict:
        """Appends a timestamped security decision to the hash-chained JSONL trail."""
        with self._lock:
            body = _normalise(
                {
                    "index": self._index,
                    "system_timestamp": time.time(),
                    "simulation_event": simulation_results,
                }
            )
            entry = {
                **body,
                "previous_hash": self._last_hash,
                "entry_hash": TrustAnchorLedger._hash_block(self._last_hash, body),
            }
            self.log_filepath.parent.mkdir(parents=True, exist_ok=True)
            with self.log_filepath.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, sort_keys=True) + "\n")
            self._index += 1
            self._last_hash = entry["entry_hash"]
        logger.info("Forensic security verdict %d appended to the audit log", entry["index"])
        return entry

    def verify_log(self) -> tuple[bool, str]:
        """Re-walks the chain from the genesis hash; reports the first broken entry."""
        if not self.log_filepath.exists():
            return True, "Audit log is empty."
        previous = GENESIS_HASH
        count = 0
        for position, entry in enumerate(self._entries()):
            body = {key: entry[key] for key in ("index", "system_timestamp", "simulation_event")}
            if entry["index"] != position or entry["previous_hash"] != previous:
                return False, f"Chain broken at entry {position}: missing or reordered entries."
            if entry["entry_hash"] != TrustAnchorLedger._hash_block(previous, body):
                return False, f"Tampering detected at entry {position}: hash mismatch."
            previous = entry["entry_hash"]
            count += 1
        return True, f"Audit log intact: {count} entries chained to the genesis root."
