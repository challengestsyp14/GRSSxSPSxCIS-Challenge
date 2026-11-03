"""Writes src/data/p618.json: the digital twin's ITU-R P.618 atmospheric loss over elevation.

The website's link budgets add the same median-atmosphere attenuation as the twin
(digital_twin/link_budget.py), interpolated from this table: the X-band downlink, and the
S-band telecommand uplink at 2050 MHz, inside the 2025-2110 MHz space-operation band.

    python dashboard/scripts/gen-p618.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from digital_twin.link_budget import MEDIAN_PERCENT, LinkBudgetCalculator  # noqa: E402

OUT = ROOT / "dashboard" / "src" / "data" / "p618.json"
#: The testbed's S-band telecommand uplink.
UPLINK_CARRIER_HZ = 2050e6


def elevations() -> list[float]:
    """Dense near the horizon, where the loss changes fastest."""
    low = [i * 0.25 for i in range(40)]
    mid = [10.0 + i for i in range(20)]
    high = [30.0 + 5.0 * i for i in range(13)]
    return low + mid + high


def table() -> dict:
    link = LinkBudgetCalculator()
    uplink = LinkBudgetCalculator(carrier_freq_hz=UPLINK_CARRIER_HZ)
    els = elevations()
    return {
        "model": "ITU-R P.618-13, median atmosphere over Zaghouan (digital_twin/link_budget.py)",
        "carrierMHz": link.freq_hz / 1e6,
        "uplinkCarrierMHz": uplink.freq_hz / 1e6,
        "exceedancePercent": MEDIAN_PERCENT,
        "elevationDeg": els,
        "totalDb": [round(link.atmospheric_loss_db(el), 4) for el in els],
        "uplinkTotalDb": [round(uplink.atmospheric_loss_db(el), 4) for el in els],
    }


def main() -> None:
    OUT.write_text(json.dumps(table(), indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
