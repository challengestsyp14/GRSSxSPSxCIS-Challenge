"""Tamper-evident record of what the station received.

Provenance needs a processing history that cannot be quietly rewritten after the fact.
Every frame report is committed to a hash chain and authenticated with HMAC-SHA256, so any
later edit, reorder, truncation or splice of the station's log is detected and located.

This is separate from link security: AES-GCM protects frames in flight between spacecraft
and station; this log protects the station's own record once they have landed.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from typing import Any

GENESIS = "0" * 64


@dataclass(frozen=True)
class Record:
    """One sealed epoch."""

    index: int
    timestamp: float
    payload_digest: str
    prev_digest: str
    mac: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _canonical(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest_payload(payload: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical(payload)).hexdigest()


class ObservationLog:
    """Append-only, hash-chained, MAC-authenticated log of observation epochs."""

    def __init__(self, key: bytes) -> None:
        if not key:
            raise ValueError("trust anchor key must not be empty")
        self._key = key
        self._records: list[Record] = []

    def __len__(self) -> int:
        return len(self._records)

    @property
    def records(self) -> tuple[Record, ...]:
        return tuple(self._records)

    @property
    def head(self) -> str:
        return self._records[-1].mac if self._records else GENESIS

    def append(self, timestamp: float, payload: dict[str, Any]) -> Record:
        payload_digest = digest_payload(payload)
        prev_digest = self.head
        index = len(self._records)
        record = Record(
            index=index,
            timestamp=timestamp,
            payload_digest=payload_digest,
            prev_digest=prev_digest,
            mac=self._mac(index, timestamp, payload_digest, prev_digest),
        )
        self._records.append(record)
        return record

    def _mac(self, index: int, timestamp: float, payload_digest: str, prev_digest: str) -> str:
        message = _canonical(
            {
                "index": index,
                "timestamp": timestamp,
                "payload_digest": payload_digest,
                "prev_digest": prev_digest,
            }
        )
        return hmac.new(self._key, message, hashlib.sha256).hexdigest()

    def verify(self, records: Iterable[Record] | None = None) -> tuple[bool, str]:
        """Check chain continuity and authenticity.

        Returns ``(ok, reason)``; ``reason`` is empty when the chain verifies.
        """
        chain = list(self._records if records is None else records)
        expected_prev = GENESIS

        for position, record in enumerate(chain):
            if record.index != position:
                return False, f"index {record.index} out of order at position {position}"
            if record.prev_digest != expected_prev:
                return False, f"chain broken at index {record.index}"
            expected = self._mac(
                record.index, record.timestamp, record.payload_digest, record.prev_digest
            )
            if not hmac.compare_digest(expected, record.mac):
                return False, f"authentication failed at index {record.index}"
            expected_prev = record.mac

        return True, ""
