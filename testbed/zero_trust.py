"""
zero_trust.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Zero Trust Architecture (ZTA) & Policy Enforcement Module

Every frame is judged on evidence, never on what it claims about itself:
1. Explicit verification: the claimed satellite must be registered and cleared, the hardware
   token must match its registration, and the trust anchor must have authenticated the frame.
2. Least privilege: only cleared space assets may stream into the pipeline.
3. Assume breach: any anomaly from the detector quarantines the frame.
"""

from __future__ import annotations

from .ingester import ROGUE_NODE_TOKEN, SAT_ID, SAT_TOKEN


class ZeroTrustPolicyEngine:
    def __init__(self):
        self.device_trust_registry = {
            SAT_ID: {"cleared": True, "hw_token": SAT_TOKEN, "auth_level": "L3_SPACE"},
            "ROGUE-NODE-99": {
                "cleared": False,
                "hw_token": ROGUE_NODE_TOKEN,
                "auth_level": "UNAUTHORIZED",
            },
        }

    def evaluate_access_request(self, packet: dict, detection: dict, auth: tuple[bool, str]):
        """Decides from the registry, the trust anchor result and the detector result."""
        claimed = packet.get("satellite_id", "UNKNOWN")
        entry = self.device_trust_registry.get(claimed)
        authentic, auth_reason = auth

        reasons = []
        if entry is None or not entry["cleared"]:
            reasons.append(f"{claimed} is not a cleared asset")
        elif packet.get("hw_token") != entry["hw_token"]:
            reasons.append(
                f"hardware token {packet.get('hw_token')} does not match {claimed} registration"
            )
        if not authentic:
            reasons.append(f"trust anchor: {auth_reason}")
        if detection["anomaly"]:
            reasons.append("detector: RF anomaly")

        if reasons:
            return {
                "access_granted": False,
                "policy_action": "QUARANTINE_AND_DROP",
                "reason": "Zero Trust policy violation: " + "; ".join(reasons),
            }
        return {
            "access_granted": True,
            "policy_action": "ALLOW_STREAM",
            "reason": "Registered asset, matching token, authentic frame, nominal RF profile.",
        }


if __name__ == "__main__":
    from .detector import TelemetryDetector
    from .ingester import TelemetryIngester
    from .trust_anchor import TrustAnchorLedger

    ingester = TelemetryIngester(seed=14)
    detector = TelemetryDetector()
    detector.train_baseline([ingester.generate_packet("normal") for _ in range(1200)])
    ledger = TrustAnchorLedger(ingester.key)
    zta = ZeroTrustPolicyEngine()

    print("=== Zero Trust Policy Engine Initialized ===")
    packet = ingester.generate_packet("stealth_spoofing")
    detection = detector.evaluate_packet(packet)
    _, ok, reason = ledger.ingest(packet)
    print("ZTA Decision Result:", zta.evaluate_access_request(packet, detection, (ok, reason)))
