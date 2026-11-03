"""
decision.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin: the decision rule, shared by the validator, the seeded evaluation and (ported
to TypeScript) the live site.

Five outcomes, from the three tiers' flags:
- DELIVERED: no tier flags the packet.
- DEGRADED: the data tier proves the packet genuine (it decoded, its HMAC tag is valid and its
  sequence count fresh), the kinematic test passes, and the chi-square gate fails only because
  of the power residual. Origin is proven by the key; only the link quality is in doubt, so the
  packet reaches the analyst tagged as degraded and a jamming alarm is raised. The statistical
  tier's flag does not change this: it reads the same power residual.
- HELD: the statistical tier alone flags it; it waits for review.
- REJECTED: the data tier or the physical tier flags it; a retransmission is requested.
- QUARANTINED: two tiers flag it at once, at least one of them deterministic (data or
  physical: the statistical tier never quarantines on its own), or it fails authentication
  during a burst (at least BURST_FAILURES authentication failures within the last BURST_WINDOW
  frames): the link is isolated.

Re-keying is a separate response. It happens only when the data tier shows that someone holds
the key: a frame whose HMAC tag is valid but whose hardware token is not the satellite's, or
whose sequence count is stale on content the station never received. A replayed frame (same
content, stale count), a rogue carrier or a forged tag proves nothing about the key, so the link
is quarantined and re-acquired with the key epoch unchanged.

Every outcome but DELIVERED raises an alarm. The red-team label never reaches this module.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

OUTCOMES = ("DELIVERED", "DEGRADED", "HELD", "REJECTED", "QUARANTINED")
#: Outcomes that reach the analyst.
DELIVERED_OUTCOMES = ("DELIVERED", "DEGRADED")

#: The burst rule: this many authentication failures within the last BURST_WINDOW frames.
BURST_FAILURES = 3
BURST_WINDOW = 10


@dataclass(frozen=True)
class TierFlags:
    """What each tier found about one packet."""

    #: The data tier: the frame did not decode, or its tag or sequence count failed.
    data: bool
    #: The statistical tier: the Isolation Forest flagged the measurement.
    statistical: bool
    #: The physical tier: the chi-square gate or the kinematic test fired.
    physical: bool
    #: The physical flag comes from the power residual alone (chi-square without it passes,
    #: kinematic test passes).
    power_only: bool = False
    #: The frame decoded and failed authentication (tag, hardware token or sequence count).
    auth_failure: bool = False
    #: Evidence of a key holder: a valid tag on a frame with a foreign hardware token, or on
    #: new content under a stale sequence count.
    key_holder: bool = False


class BurstMonitor:
    """Counts authentication failures over the last BURST_WINDOW frames."""

    def __init__(self, failures: int = BURST_FAILURES, window: int = BURST_WINDOW):
        self.failures = failures
        self.recent: deque[bool] = deque(maxlen=window)

    def observe(self, auth_failure: bool) -> bool:
        """Records one frame; True when the window now holds a burst and this frame failed."""
        self.recent.append(auth_failure)
        return auth_failure and sum(self.recent) >= self.failures


def decide(flags: TierFlags, burst: bool = False) -> tuple[str, list[str]]:
    """The outcome of one packet and the reasons behind it."""
    reasons: list[str] = []
    if flags.data:
        reasons.append("data")
    if flags.physical:
        reasons.append("physical: power residual only" if flags.power_only else "physical")
    if flags.statistical:
        reasons.append("statistical")

    if flags.key_holder:
        reasons.append("data: valid tag from a key holder · re-key")
    if burst:
        return "QUARANTINED", [
            f"data: burst · {BURST_FAILURES} authentication failures "
            f"within the last {BURST_WINDOW} frames",
            *reasons[1:],
        ]
    if not flags.data and flags.physical and flags.power_only:
        return "DEGRADED", reasons + ["genuine frame on a degraded link: jamming alarm"]
    tiers = flags.data + flags.statistical + flags.physical
    deterministic = flags.data or flags.physical
    if tiers >= 2 and deterministic:
        return "QUARANTINED", reasons
    if flags.data or flags.physical:
        return "REJECTED", reasons
    if flags.statistical:
        return "HELD", reasons
    return "DELIVERED", reasons


def rekey_required(flags: TierFlags) -> bool:
    """Re-key only on evidence that the key itself is in other hands."""
    return flags.key_holder


def power_only(physics: dict) -> bool:
    """True when the chi-square gate fails only because of the power residual."""
    if not physics["chi_square_breach"] or physics["kinematic_coupling"]["kinematic_breach"]:
        return False
    rest = physics["chi_square_value"] - physics["normalized_residuals"]["rssi_dbm"] ** 2
    return rest <= physics["adaptive_threshold"]
