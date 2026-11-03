"""
datasets.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin: the dataset adapter. The seeded evaluation reads every packet through it, so the
official reference datasets replace the synthetic traffic with one flag:

    python -m digital_twin.evaluate --dataset official --path <file.jsonl> [--key-hex <key>]

A dataset is a JSON Lines file. The first line is a header; every other line is one packet as
the station received it:

    {"format": "groundlink-records/1", "satellite": "TERRASAR-X", "tle": [l1, l2]?, ...}
    {"t": 1793000000.0, "elevation_deg": 12.3, "label": "NONE", "split": "train",
     "link": {"slant_range_km": .., "doppler_shift_hz": .., "rssi_dbm": .., "snr_db": ..,
              "received_phase_error_deg": ..},
     "predicted": {...the same fields...}?, "packet": {...CCSDS packet...} | null}

- `label` is the red-team ground truth ("NONE" for genuine traffic), read for scoring only.
- `split` "train" marks the nominal packets the statistical tier learns from.
- `predicted` is the orbit and link-budget prediction; when absent the twin computes it from
  the header's element set (or its built-in one) at `t`.
- `packet` is null when the frame did not decode.

`--export <file.jsonl>` writes the synthetic run in this format, so the adapter is tested on
the same traffic the report measures.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field

RECORD_FORMAT = "groundlink-records/1"
LINK_FIELDS = (
    "slant_range_km",
    "doppler_shift_hz",
    "rssi_dbm",
    "snr_db",
    "received_phase_error_deg",
)
#: Written when the receiver measured them: the EVM of the constellation, per cent, and the
#: frame arrival against the satellite's clock, microseconds.
OPTIONAL_LINK_FIELDS = ("evm_pct", "light_time_us")


@dataclass
class Record:
    """One packet as the station received it, and the scoring label that travels with it."""

    t: float
    elevation_deg: float
    label: str
    link: dict
    predicted: dict | None
    packet: dict | None
    split: str = "test"
    #: Extras for the report only (SNR lost to a jam); no tier reads them.
    extra: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        return {
            "t": self.t,
            "elevation_deg": self.elevation_deg,
            "label": self.label,
            "split": self.split,
            "link": {
                k: self.link[k] for k in (*LINK_FIELDS, *OPTIONAL_LINK_FIELDS) if k in self.link
            },
            "predicted": None
            if self.predicted is None
            else {k: self.predicted[k] for k in LINK_FIELDS},
            "packet": self.packet,
            **({"extra": self.extra} if self.extra else {}),
        }

    @classmethod
    def from_json(cls, row: dict) -> Record:
        missing = [k for k in ("t", "elevation_deg", "label", "link") if k not in row]
        if missing:
            raise ValueError(f"record without {missing}")
        absent = [k for k in LINK_FIELDS if k not in row["link"]]
        if absent:
            raise ValueError(f"record link without {absent}")
        return cls(
            t=float(row["t"]),
            elevation_deg=float(row["elevation_deg"]),
            label=str(row["label"]),
            link=dict(row["link"]),
            predicted=None if row.get("predicted") is None else dict(row["predicted"]),
            packet=row.get("packet"),
            split=str(row.get("split", "test")),
            extra=dict(row.get("extra", {})),
        )


def write_records(path: str, header: dict, records: Iterable[Record]) -> int:
    """Writes a dataset file; returns the number of records."""
    n = 0
    with open(path, "w") as out:
        out.write(json.dumps({"format": RECORD_FORMAT, **header}) + "\n")
        for record in records:
            out.write(json.dumps(record.to_json(), separators=(",", ":")) + "\n")
            n += 1
    return n


def read_records(path: str) -> tuple[dict, Iterator[Record]]:
    """The header and an iterator over the records of a dataset file."""
    source = open(path)  # noqa: SIM115 - closed by the generator
    header = json.loads(source.readline())
    if header.get("format") != RECORD_FORMAT:
        source.close()
        raise ValueError(f"{path}: expected format {RECORD_FORMAT!r}, got {header.get('format')!r}")

    def records() -> Iterator[Record]:
        with source:
            for line in source:
                if line.strip():
                    yield Record.from_json(json.loads(line))

    return header, records()
