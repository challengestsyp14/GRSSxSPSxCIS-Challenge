// Copy deck: audited strings, kept in one place so terminology stays consistent.

import type { AttackKind } from './signals';
import type { UplinkThreat } from './uplink';

export const STATION = 'GS-ZAG';
export const STATION_LABEL = 'Zaghouan GS (TN)';
export const STATION_PLACE = 'Zaghouan, Tunisia';
export const HANDOVER_STATION = 'GS-MAT';
export const HANDOVER_PLACE = 'Matera, Italy';
/** The satellite the testbed flies, as the page names it. */
export let SATELLITE = 'TerraSAR-X';

/** Names the satellite the testbed flies, before the page renders. */
export function setSatelliteName(name: string, noradId: number): void {
  SATELLITE = noradId === 31698 ? 'TerraSAR-X' : noradId === 36605 ? 'TanDEM-X' : name;
}
export const ROGUE_NODE = '0x99A2';

export const ATTACK_BUTTONS: Record<AttackKind, { label: string; sub: string; running: string }> = {
  hijack: {
    label: 'Frequency Hijacking',
    sub: 'rogue carrier +14.2 MHz',
    running: 'Frequency Hijacking',
  },
  spoof: {
    label: 'Stealth Spoofing',
    sub: `forged MAC · node ${ROGUE_NODE}`,
    running: 'Stealth Spoofing',
  },
  jam: { label: 'Noise Jamming', sub: 'broadband white noise', running: 'Noise Jamming' },
  tamper: {
    label: 'Data Tampering',
    sub: 'bit flips in transit',
    running: 'Data Tampering',
  },
};

/** What each scenario proves, shown on the Simulate Attack panel. */
export const ATTACK_PROOF: Record<AttackKind, string> = {
  spoof: 'Inside a ±4 dB band but 14σ below the link budget: χ², HMAC and nonce checks all fire',
  tamper: 'No RF signature at all: only the data layer’s hash verification catches it',
  hijack: 'Physical and data layers both fire: χ² of the carrier and proof failures',
  jam: 'Frames are genuine: only the χ² physical layer catches it, then fallback',
};

export interface BannerCopy {
  headline: string;
  detail: string;
}

export function activeBanner(kind: AttackKind, ms: number | null): BannerCopy {
  const t = ms === null ? '' : ` in ${Math.round(ms)} ms`;
  switch (kind) {
    case 'hijack':
      return {
        headline: `Frequency hijack detected${t} · carrier at 8492 MHz`,
        detail: `Rogue carrier +14.2 MHz, outside the 6 MHz channel, on the wideband spectrum monitor · proof failures on every frame`,
      };
    case 'spoof':
      return {
        headline: `Quarantine protocols engaged${t}`,
        detail: `Forged MAC headers and nonces from node ${ROGUE_NODE} · frames isolated at the gate`,
      };
    case 'tamper':
      return {
        headline: `Data tampering detected${t} · hash verification failed`,
        detail: `Payload bits flipped between ${SATELLITE} and ${STATION} · HMAC-SHA256 mismatch on every altered frame`,
      };
    case 'jam':
      return {
        headline: `Noise jamming at ${STATION} · carrier power −96.5 dBm`,
        detail: `Broadband white noise saturating the receiver · forcing fallback routing to ${HANDOVER_STATION}`,
      };
  }
}

export function resolvedBanner(
  kind: AttackKind,
  epoch: number,
  handoverS: number | null,
  rekeyed = false,
): BannerCopy {
  const e = `0x${epoch.toString(16).toUpperCase()}`;
  switch (kind) {
    case 'hijack':
      return {
        headline: 'Hijack contained · 0 corrupted frames reached the analyst',
        detail: rekeyed
          ? `Carrier re-locked on ${SATELLITE} · keys rotated to epoch ${e}`
          : `Carrier re-locked on ${SATELLITE} · key epoch ${e} unchanged: no valid tag from the rogue`,
      };
    case 'spoof':
      return {
        headline: `Node ${ROGUE_NODE} isolated · spoofed frames quarantined`,
        detail: rekeyed
          ? `Keys rotated to epoch ${e} · re-key signed with Ed25519`
          : `Key epoch ${e} unchanged: ${ROGUE_NODE} never produced a valid tag`,
      };
    case 'tamper':
      return {
        headline: 'Tampered frames quarantined · 0 reached the analyst',
        detail: `Retransmission requested · key epoch ${e} unchanged: the relay never had the key`,
      };
    case 'jam':
      return {
        headline: `Fallback routing via ${HANDOVER_STATION}${handoverS === null ? '' : ` in ${handoverS.toFixed(1)} s`}`,
        detail: `${STATION} flagged as jammed · no corrupted frames accepted`,
      };
  }
}

export const unansweredBanner: BannerCopy = {
  headline: 'Attack ended · auto-response was off',
  detail: 'Failing frames were still dropped at the provenance gate',
};

export const TOUR_CALLOUTS = {
  get lock() {
    return {
      text: `${SATELLITE} downlink locked on ${STATION}`,
      sub: 'pass predicted from orbital elements',
    };
  },
  gate: {
    text: 'Range, Doppler, power and phase vs the orbit',
    sub: 'one χ² gate, wider near the horizon',
  },
  chain: {
    text: 'Each frame is a SHA-256 block chained to the last',
    sub: 'one altered frame breaks the chain',
  },
  hold: {
    text: 'Only the statistical layer flagged it',
    sub: 'the forest alone holds a frame, it never rejects one',
  },
  suppressed: { text: 'False alarm suppressed', sub: 'physical and data layers both pass' },
  controls: { text: 'Every control drives the telemetry', sub: 'and the 3D link in real time' },
} as const;

export const UPLINK_BUTTONS: Record<UplinkThreat, { label: string; sub: string; running: string }> =
  {
    cmdtamper: {
      label: 'Command Tampering',
      sub: 'telecommand rewritten in flight',
      running: 'Command Tampering',
    },
    cmdinject: {
      label: 'Command Injection',
      sub: 'forged from a rogue uplink',
      running: 'Command Injection',
    },
    cmdreplay: {
      label: 'Command Replay',
      sub: 'recorded command sent again',
      running: 'Command Replay',
    },
  };

/** What each uplink scenario proves, shown on the Simulate Attack panel. */
export const UPLINK_PROOF: Record<UplinkThreat, string> = {
  cmdtamper:
    'Checksum and SHA-256 recomputed, the original tag kept: the HMAC check on board fails',
  cmdinject: 'Tag computed under a guessed key: rejected on board, nothing executes',
  cmdreplay: 'Tag genuine, sequence count old: the on-board anti-replay check rejects it',
};

export function activeUplinkBanner(threat: UplinkThreat): BannerCopy {
  switch (threat) {
    case 'cmdtamper':
      return {
        headline: `Uplink command tampering · DISABLE_TRANSMITTER never executes`,
        detail: `Telecommands from ${STATION} rewritten in flight · HMAC-SHA256 tag mismatch on board ${SATELLITE}`,
      };
    case 'cmdinject':
      return {
        headline: 'Command injection from a rogue uplink · rejected on board',
        detail: `Forged telecommands, tag under a guessed key · ${SATELLITE} executes only what mission control sealed`,
      };
    case 'cmdreplay':
      return {
        headline: 'Command replay · stale sequence counts rejected on board',
        detail: `Recorded telecommands sent again · the tag checks out, the anti-replay counter does not`,
      };
  }
}

export function resolvedUplinkBanner(
  threat: UplinkThreat,
  blocked: number,
  executed: number,
): BannerCopy {
  return {
    headline: `Uplink clean · ${blocked} hostile ${blocked === 1 ? 'command' : 'commands'} rejected, ${executed} executed`,
    detail: `${UPLINK_BUTTONS[threat].label} over · ${SATELLITE} kept executing mission control's commands only`,
  };
}
