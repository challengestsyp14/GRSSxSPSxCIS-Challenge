"""
ephemeris_loader.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin, phase 1: live two-line element sets (TLE) from CelesTrak, with an offline fallback.

The twin flies TerraSAR-X (NORAD 31698), an X-band radar satellite on a 514 km
sun-synchronous orbit, on its current orbit. `fetch_latest_tle()` downloads its latest
element set from CelesTrak's public GP service and keeps the last good download on disk.
In order, it flies:

1. a download younger than two hours, reused without touching the network: CelesTrak
   refreshes its data about every two hours and asks clients not to fetch more often;
2. a fresh download from CelesTrak;
3. the last good download, however old, when the network or CelesTrak fails;
4. the element set built into the twin, TerraSAR-X as CelesTrak served it on 27 October
   2026, when the twin has never been online.

Every element set is tagged with its source and age, so the twin always says which orbit
it flies. GROUNDLINK_NORAD_ID picks another satellite, GROUNDLINK_OFFLINE=1 keeps the twin
off the network, GROUNDLINK_TLE_CACHE moves the cache directory.

    python -m digital_twin.ephemeris_loader --require-live
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import logging
import os
import time
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path

logger = logging.getLogger("EphemerisLoader")

CELESTRAK_URL = "https://celestrak.org/NORAD/elements/gp.php?CATNR={norad_id}&FORMAT=TLE"
USER_AGENT = "groundlink-digital-twin/1.0 (TSYP 14 secure ground-link testbed)"
#: TerraSAR-X: X-band SAR, ~510 km sun-synchronous orbit, 97.44 deg.
DEFAULT_NORAD_ID = 31698
NORAD_ENV = "GROUNDLINK_NORAD_ID"
OFFLINE_ENV = "GROUNDLINK_OFFLINE"
CACHE_ENV = "GROUNDLINK_TLE_CACHE"
#: CelesTrak updates GP data about every two hours; a younger download is reused.
CACHE_FRESH_S = 2 * 3600.0

#: Where each element set came from.
SOURCES = {
    "celestrak": "live from CelesTrak",
    "cache": "CelesTrak download from the last two hours",
    "stale-cache": "last good CelesTrak download (offline)",
    "builtin": "built-in element set of 27 Oct 2026 (offline, never downloaded)",
}

#: TerraSAR-X as CelesTrak served it on 27 Oct 2026: 15.19 rev/day, 97.45 deg, epoch
#: 2026-10-26 11:12 UTC. The same set ships with the website (dashboard/src/sim/orbit.ts).
BUILTIN_TLE = (
    "TERRASAR-X",
    "1 31698U 07026A   26299.46724549 -.00000045  00000+0  10706-5 0  9999",
    "2 31698  97.4456 305.3111 0001816  81.2566 278.8874 15.19151530 73153",
)


def tle_checksum(line: str) -> int:
    """Modulo-10 checksum of a TLE line: digits count their value, minus signs count 1."""
    return sum(int(c) if c.isdigit() else int(c == "-") for c in line[:68]) % 10


def validate_tle(line1: str, line2: str) -> None:
    """Raises ValueError unless both lines are well-formed and belong to one satellite."""
    for number, line in ((1, line1), (2, line2)):
        if len(line) != 69 or not line.startswith(f"{number} "):
            raise ValueError(f"TLE line {number} must be 69 characters starting with '{number} '")
        if not line[68].isdigit() or int(line[68]) != tle_checksum(line):
            raise ValueError(f"TLE line {number} fails its checksum")
    if line1[2:7] != line2[2:7]:
        raise ValueError("TLE lines carry different catalogue numbers")


def tle_epoch(line1: str) -> datetime:
    """Epoch of a TLE (two-digit year, then day of year with a fraction), in UTC."""
    year = int(line1[18:20])
    year += 2000 if year < 57 else 1900
    return datetime(year, 1, 1, tzinfo=UTC) + timedelta(days=float(line1[20:32]) - 1.0)


def parse_tle(text: str) -> dict:
    """Parses a two- or three-line element set (name line optional)."""
    lines = [line.rstrip() for line in text.strip().splitlines() if line.strip()]
    if len(lines) == 2:
        name, line1, line2 = "UNKNOWN", *lines
    elif len(lines) == 3:
        name, line1, line2 = lines[0].strip(), lines[1], lines[2]
    else:
        raise ValueError(f"expected 2 or 3 TLE lines, got {len(lines)}: {text.strip()[:60]!r}")
    validate_tle(line1, line2)
    epoch = tle_epoch(line1)
    return {
        "sat_name": name,
        "norad_id": int(line1[2:7]),
        "line1": line1,
        "line2": line2,
        "epoch_utc": epoch.isoformat(),
        "epoch_unix": epoch.timestamp(),
        # The relay that served the set is not trusted for integrity: record what was flown.
        "sha256": hashlib.sha256(f"{line1}\n{line2}".encode()).hexdigest(),
    }


def default_cache_dir() -> Path:
    if os.environ.get(CACHE_ENV):
        return Path(os.environ[CACHE_ENV])
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "groundlink"


def is_offline() -> bool:
    return os.environ.get(OFFLINE_ENV, "").strip().lower() in ("1", "true", "yes")


class EphemerisLoader:
    def __init__(
        self,
        target_sat_id: int | None = None,
        timeout_s: float = 10.0,
        cache_dir: str | Path | None = None,
    ):
        if target_sat_id is None:
            target_sat_id = int(os.environ.get(NORAD_ENV) or DEFAULT_NORAD_ID)
        self.target_sat_id = target_sat_id
        self.timeout_s = timeout_s
        self.celestrak_url = CELESTRAK_URL.format(norad_id=target_sat_id)
        self.cache_path = Path(cache_dir or default_cache_dir()) / f"tle-{target_sat_id}.json"

    def fetch_latest_tle(self, online: bool | None = None) -> dict:
        """The element set to fly, tagged with its source (see SOURCES) and age.

        `online` defaults to True unless GROUNDLINK_OFFLINE is set.
        """
        online = not is_offline() if online is None else online
        cached = self._read_cache()
        if online:
            if cached and time.time() - cached["fetched_unix"] < CACHE_FRESH_S:
                return self._tag(cached["tle"], "cache", cached["fetched_unix"])
            try:
                text = self._download()
                tle = parse_tle(text)
                if tle["norad_id"] != self.target_sat_id:
                    raise ValueError(f"CelesTrak answered with NORAD {tle['norad_id']}")
            except (OSError, ValueError, http.client.HTTPException) as exc:
                logger.warning("CelesTrak fetch for NORAD %s failed: %s", self.target_sat_id, exc)
            else:
                fetched = time.time()
                self._write_cache(text, fetched)
                return self._tag(tle, "celestrak", fetched)
        if cached:
            return self._tag(cached["tle"], "stale-cache", cached["fetched_unix"])
        return self._tag(self.builtin(), "builtin", None)

    @staticmethod
    def builtin() -> dict:
        return parse_tle("\n".join(BUILTIN_TLE))

    def _download(self) -> str:
        request = urllib.request.Request(self.celestrak_url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
            return response.read().decode("utf-8", errors="replace")

    def _read_cache(self) -> dict | None:
        try:
            record = json.loads(self.cache_path.read_text(encoding="utf-8"))
            tle = parse_tle(record["text"])
            if tle["norad_id"] != self.target_sat_id:
                return None
            return {"tle": tle, "fetched_unix": float(record["fetched_unix"])}
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _write_cache(self, text: str, fetched_unix: float) -> None:
        record = {"norad_id": self.target_sat_id, "fetched_unix": fetched_unix, "text": text}
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            partial = self.cache_path.with_suffix(".tmp")
            partial.write_text(json.dumps(record), encoding="utf-8")
            partial.replace(self.cache_path)
        except OSError as exc:  # a read-only disk only costs the offline fallback
            logger.warning("Could not cache the element set: %s", exc)

    @staticmethod
    def _tag(tle: dict, source: str, fetched_unix: float | None) -> dict:
        fetched = None
        if fetched_unix is not None:
            fetched = datetime.fromtimestamp(fetched_unix, UTC).isoformat(timespec="seconds")
        logger.info("Flying %s (NORAD %s): %s", tle["sat_name"], tle["norad_id"], SOURCES[source])
        return {
            **tle,
            "source": source,
            "source_detail": SOURCES[source],
            "fetched_utc": fetched,
            "epoch_age_days": (time.time() - tle["epoch_unix"]) / 86400.0,
        }


def describe(tle: dict) -> str:
    """One line on the orbit flown: satellite, where its elements came from, their age."""
    source = tle.get("source_detail", "element set given by the caller")
    age_days = (time.time() - tle["epoch_unix"]) / 86400.0
    digest = tle.get("sha256", "")[:16]
    return (
        f"{tle['sat_name']} (NORAD {tle['norad_id']}): {source}, "
        f"epoch {tle['epoch_utc']} ({age_days:.1f} days old), sha256 {digest}…"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Load the twin's element set and its source.")
    parser.add_argument(
        "--norad", type=int, help=f"NORAD catalogue number (default {DEFAULT_NORAD_ID})"
    )
    parser.add_argument(
        "--require-live",
        action="store_true",
        help="exit 1 unless the set came from CelesTrak in the last two hours",
    )
    args = parser.parse_args(argv)
    tle = EphemerisLoader(args.norad).fetch_latest_tle(online=True)
    print(describe(tle))
    print(tle["line1"])
    print(tle["line2"])
    if args.require_live and tle["source"] not in ("celestrak", "cache"):
        print("not live: CelesTrak was not reachable")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
