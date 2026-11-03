// The decision of the three tiers, as in digital_twin/decision.py, five outcomes:
// - ACCEPTED: no tier flags the frame;
// - DEGRADED: the data layer proves the frame genuine (cleared identity, valid HMAC-SHA256 tag,
//   fresh nonce), the kinematic test passes and the chi-square gate fails only because of the
//   power residual: the frame reaches the analyst tagged as degraded, with a jamming alarm;
// - HELD: the statistical layer (Isolation Forest) alone flags it, for review;
// - REJECTED: the data layer or the physical layer (chi-square, kinematic coupling) flags it;
// - QUARANTINED: two tiers at once, or an authentication failure during a burst (3 within the
//   last 10 frames).
// The red-team label never reaches this function.

import { zeroTrust, type Decision, type DetectorResult } from './linkDetector';
import { RESIDUAL_LABEL, type PhysicsResult } from './physicsEngine';
import type { AuthReason, Frame } from './trustAnchor';

/** The burst rule: this many authentication failures within the last BURST_WINDOW frames. */
export const BURST_FAILURES = 3;
export const BURST_WINDOW = 10;

const sigma = (z: number) => `${z < 0 ? '−' : '+'}${Math.abs(z).toFixed(1)}σ`;

/** One line on why the physical layer fired. */
export function physicsReason(p: PhysicsResult): string {
  if (p.chiSquareBreach) {
    return (
      `physics: χ² ${p.chiSquare.toFixed(1)} > gate ${p.threshold.toFixed(1)} · ` +
      `${RESIDUAL_LABEL[p.dominant].toLowerCase()} ${sigma(p.normalized[p.dominant])}`
    );
  }
  return `physics: range change disagrees with the Doppler by ${sigma(p.kinematic.z)}`;
}

/** True when the chi-square gate fails only because of the power residual. */
export function powerOnly(p: PhysicsResult): boolean {
  if (!p.chiSquareBreach || p.kinematic.breach) return false;
  return p.chiSquare - p.normalized.rssiDb ** 2 <= p.threshold;
}

export function decide(
  claimed: Pick<Frame, 'satellite_id' | 'hw_token'> | null,
  authentic: { ok: boolean; reason: AuthReason } | null,
  physics: PhysicsResult | null,
  detection: DetectorResult | null,
  burst = false,
): Decision {
  const data = zeroTrust(claimed, authentic, null).reasons.map((r) => `data: ${r}`);
  const physical = physics?.breach ? [physicsReason(physics)] : [];
  const statistical = detection?.forest
    ? [
        `statistical: Isolation Forest score ${detection.score.toFixed(3)} > ${detection.threshold.toFixed(3)}`,
      ]
    : [];

  if (burst && data.length) {
    return {
      allow: false,
      action: 'QUARANTINE_LINK',
      verdict: 'QUARANTINED',
      reasons: [
        `data: burst · ${BURST_FAILURES} authentication failures within the last ${BURST_WINDOW} frames`,
        ...data,
        ...physical,
        ...statistical,
      ],
    };
  }
  if (!data.length && physics?.breach && powerOnly(physics)) {
    return {
      allow: true,
      action: 'DELIVER_DEGRADED',
      verdict: 'DEGRADED',
      reasons: [
        `${physical[0]} · power residual only`,
        'genuine frame on a degraded link: delivered flagged, jamming alarm',
        ...statistical,
      ],
    };
  }
  const tiers = Number(data.length > 0) + Number(physical.length > 0) + statistical.length;
  const reasons = [...data, ...physical, ...statistical];
  if (tiers >= 2) {
    return { allow: false, action: 'QUARANTINE_LINK', verdict: 'QUARANTINED', reasons };
  }
  if (data.length || physical.length) {
    return { allow: false, action: 'QUARANTINE_AND_DROP', verdict: 'REJECTED', reasons };
  }
  if (statistical.length) {
    return { allow: false, action: 'HOLD_FOR_REVIEW', verdict: 'HELD', reasons };
  }
  return { allow: true, action: 'ALLOW_STREAM', verdict: 'ACCEPTED', reasons: [] };
}
