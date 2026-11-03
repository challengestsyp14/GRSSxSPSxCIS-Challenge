// The telecommand uplink, ground to satellite: a browser port of the digital twin's
// run_uplink_command (digital_twin/physics_validator.py) and its uplink threats
// (digital_twin/attack_injector.py). Mission control at Zaghouan seals every telecommand with
// HMAC-SHA256 under the uplink key; the spacecraft executes only what passes its on-board check:
// the tag, compared in constant time, then a sequence count newer than the last one it executed.
//
// Threats against the uplink:
// - COMMAND_TAMPERING: a genuine command caught in flight and rewritten to switch the
//   transmitter off; the checksum and SHA-256 are recomputed, the original tag rides along.
// - COMMAND_INJECTION: a command forged from scratch at a rogue uplink station, with a tag
//   computed under a key the attacker can only guess.
// - COMMAND_REPLAY: a genuine command recorded earlier and transmitted again.

import { encodeText, toHex } from './crypto';

export type UplinkThreat = 'cmdtamper' | 'cmdinject' | 'cmdreplay';
export const UPLINK_THREATS: UplinkThreat[] = ['cmdtamper', 'cmdinject', 'cmdreplay'];

/** The twin's name for each threat. */
export const TWIN_THREAT: Record<UplinkThreat, string> = {
  cmdtamper: 'COMMAND_TAMPERING',
  cmdinject: 'COMMAND_INJECTION',
  cmdreplay: 'COMMAND_REPLAY',
};

/** What every uplink attacker wants executed on board. */
export const ROGUE_COMMAND = { opcode: 'DISABLE_TRANSMITTER', args: 'X-BAND' } as const;
export const ROGUE_UPLINK = 'ROGUE-UPLINK';

/** Mission control's routine commands during a pass, in turn. */
export const ROUTINE: { opcode: string; args: string }[] = [
  { opcode: 'SET_MODE', args: 'IMAGING' },
  { opcode: 'DOWNLINK_SCHEDULE', args: 'GS-ZAG' },
  { opcode: 'ACQUIRE_TARGET', args: '36.40N 10.14E' },
  { opcode: 'TIME_SYNC', args: 'UTC' },
  { opcode: 'HOUSEKEEPING', args: 'DUMP' },
];

export interface Telecommand {
  satelliteId: string;
  seq: number;
  /** Mission time of transmission, s. */
  t: number;
  opcode: string;
  args: string;
}

/** What the tag covers: every field of the command, in a fixed order. */
export const commandText = (c: Telecommand): string =>
  `TC|${c.satelliteId}|${c.seq}|${c.t.toFixed(3)}|${c.opcode}|${c.args}`;

export async function sealCommand(key: CryptoKey, c: Telecommand): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encodeText(commandText(c)))));
}

/** Equal-time comparison of two hex tags, like hmac.compare_digest. */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export type UplinkVerdict = 'EXECUTED' | 'REJECTED';

export interface OnboardCheck {
  macOk: boolean;
  fresh: boolean;
  verdict: UplinkVerdict;
  reason: string;
  expected: string;
}

/** The spacecraft's command decoder: the tag first, then the sequence count. */
export class OnboardVerifier {
  private last = -1;

  get lastExecuted(): number {
    return this.last;
  }

  async verify(key: CryptoKey, c: Telecommand, tag: string): Promise<OnboardCheck> {
    const expected = await sealCommand(key, c);
    if (!constantTimeEqual(expected, tag)) {
      return {
        macOk: false,
        fresh: false,
        verdict: 'REJECTED',
        reason: 'HMAC tag mismatch: not sealed by mission control',
        expected,
      };
    }
    if (c.seq <= this.last) {
      return {
        macOk: true,
        fresh: false,
        verdict: 'REJECTED',
        reason: `sequence ${c.seq} not newer than ${this.last}: replayed`,
        expected,
      };
    }
    this.last = c.seq;
    return {
      macOk: true,
      fresh: true,
      verdict: 'EXECUTED',
      reason: 'tag ok · sequence fresh',
      expected,
    };
  }
}
