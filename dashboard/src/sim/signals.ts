// Physical-layer telemetry: carrier frequency, RSSI, SNR vs link budget, frame timing, carrier
// phase and EVM. Residual shapes follow the standard-scenario generator; the SNR model comes
// from the real link budget (free space plus the ITU-R P.618 atmosphere) at the current slant
// range and elevation, so it rises and falls with the pass. The physical layer judges these
// residuals with the chi-square engine in physicsEngine.ts.

import { FRAME_PERIOD_S } from './constants';
import { frameDraw, frameErrorRate } from './fec';
import { CARRIER_HZ, NOISE_FLOOR_DBM } from './geometry';
import { clamp, smooth, sn } from './noise';

/** `tamper` alters frame bits in transit: no RF signature, only the crypto can see it. */
export type AttackKind = 'hijack' | 'spoof' | 'jam' | 'tamper';

export interface Attack {
  kind: AttackKind;
  tTrigger: number;
  /** Response time (or natural end); Infinity until scheduled. */
  tResponse: number;
  power: (s: number) => number;
}

/** Offset of the rogue carrier injected by the frequency hijack. */
export const HIJACK_OFFSET_HZ = 14.2e6;
/** Half-width of the hijacker's frequency sweep around its offset. */
export const HIJACK_SWEEP_HZ = 0.35e6;
/** RSSI the jammed receiver settles at, at nominal jammer power. */
export const JAMMED_RSSI_DBM = -96.5;
const JAM_REFERENCE_POWER_DB = 9;
/** Jammer power at which the receiver front end starts to saturate and the RSSI to collapse. */
const JAM_SATURATION_DB = 5;

/** SNR the noise jammer costs the link at `powerDb` of attack power, on average. */
export const jamSnrLossDb = (powerDb: number): number => Math.max(0, 1.4 * powerDb - 3);

/**
 * Jammer-to-noise ratio, dB, of the jam at `powerDb` of attack power: the J/N that costs the link
 * jamSnrLossDb(powerDb), since SNR lost = 10·log10(1 + J/N). −Infinity while the jam costs nothing.
 */
export function jamToNoiseDb(powerDb: number): number {
  const loss = jamSnrLossDb(powerDb);
  return loss > 0 ? 10 * Math.log10(10 ** (loss / 10) - 1) : -Infinity;
}

/** Attack envelope: ramps in 0.05–0.3 s after the trigger, out over 0.5 s after the response. */
export function envelope(a: Attack, s: number): number {
  return (
    smooth(a.tTrigger + 0.05, a.tTrigger + 0.3, s) * (1 - smooth(a.tResponse, a.tResponse + 0.5, s))
  );
}

export interface Sample {
  /** Measured carrier minus the orbit-predicted carrier. */
  dopplerHz: number;
  /** Absolute measured carrier frequency, MHz. */
  carrierMHz: number;
  /** Orbit-predicted carrier frequency (nominal carrier + predicted Doppler), MHz. */
  carrierModelMHz: number;
  snrDb: number;
  snrModelDb: number;
  /** Received signal strength of the locked carrier. */
  rssiDbm: number;
  rssiModelDbm: number;
  /** Frame timing against the light time the orbit predicts, µs, or null when no frames arrive. */
  timingUs: number | null;
  /** Carrier phase error of the receiver's phase loop, degrees. */
  phaseDeg: number;
  evmPct: number;
  evmModelPct: number;
}

export const evmFromSnr = (snrDb: number): number => 100 / Math.sqrt(10 ** (snrDb / 10));

export interface SignalContext {
  attacks: Attack[];
  /** Transient EVM burst used by the false-alarm moment (0..1). */
  falseAlarm: number;
  /** Doppler predicted from the orbit for this instant. */
  dopplerPredHz?: number;
}

export function sample(s: number, snrModelDb: number, ctx: SignalContext): Sample {
  let dop = 7 * Math.sin(s * 1.9) + 11 * sn(s * 2.4, 11) + 4 * sn(s * 9, 12);
  let snr = snrModelDb + 0.7 * sn(s * 2.6, 31) + 0.3 * sn(s * 11, 33);
  let timing: number | null = 2 * Math.sin(s * 2.3) + 2.4 * sn(s * 3, 21) + 0.8 * sn(s * 11, 24);
  let phase = 1.2 * Math.sin(s * 1.7 + 0.6) + 3.8 * sn(s * 2.9, 51) + 1.5 * sn(s * 10, 52);
  let jamRssi: { weight: number; e: number } | null = null;
  let jamLock: { e: number; p: number } | null = null;

  for (const a of ctx.attacks) {
    const e = envelope(a, s);
    if (e === 0) continue;
    const p = a.power(s);
    switch (a.kind) {
      case 'hijack':
        // A rogue carrier sweeping around +14.2 MHz captures the receiver's lock.
        dop += e * (HIJACK_OFFSET_HZ + HIJACK_SWEEP_HZ * Math.sin(s * 9) + 40e3 * sn(s * 3, 13));
        snr += e * (p + 1.1 * sn(s * 5, 34));
        timing += e * (27 + 6 * sn(s * 6, 22));
        phase += e * (62 + 28 * sn(s * 4, 53));
        break;
      case 'spoof':
        // Fade-mimicking: on the Doppler track, coherent with the carrier, its power a plausible
        // fade below the link budget. Inside a ±4 dB band, but 14 sigma off the prediction.
        dop += e * 16 * sn(s * 5, 16);
        snr -= e * (3.2 + 0.4 * sn(s * 7, 36));
        timing += e * 4.2;
        phase += e * 2 * sn(s * 6, 54);
        break;
      case 'jam':
        snr -= e * jamSnrLossDb(p) + e * clamp((p - 5) / 5) * 1.5 * sn(s * 16, 35);
        jamLock = { e, p };
        jamRssi = {
          weight: e * clamp((p - JAM_SATURATION_DB) / (JAM_REFERENCE_POWER_DB - JAM_SATURATION_DB)),
          e,
        };
        break;
    }
  }

  // The decoder (fec.ts): below its threshold the frame is lost. Where the jam leaves less SNR
  // than that, the carrier loop loses lock too and the carrier and phase wander.
  const lost = frameDraw(Math.floor(s / FRAME_PERIOD_S)) < frameErrorRate(snr);
  if (jamLock && frameErrorRate(snr) > 0.5) {
    const k = jamLock.e * clamp((jamLock.p - 5) / 5);
    dop += k * 720 * sn(s * 22, 15);
    phase += k * 38 * sn(s * 19, 55);
  }

  const evmModelPct = evmFromSnr(snrModelDb);
  const evmPct =
    evmFromSnr(snr) * (1 + 0.04 * sn(s * 7, 41)) + ctx.falseAlarm * (7 + 2 * sn(s * 13, 42));

  const rssiModelDbm = NOISE_FLOOR_DBM + snrModelDb;
  let rssiDbm = NOISE_FLOOR_DBM + snr;
  if (jamRssi) {
    // The saturated front end loses the carrier: RSSI collapses towards the jammed level.
    const target = JAMMED_RSSI_DBM + 0.5 * sn(s * 6, 37);
    rssiDbm += (target - rssiDbm) * jamRssi.weight;
  }

  const predicted = ctx.dopplerPredHz ?? 0;
  return {
    dopplerHz: dop,
    carrierMHz: (CARRIER_HZ + predicted + dop) / 1e6,
    carrierModelMHz: (CARRIER_HZ + predicted) / 1e6,
    snrDb: snr,
    snrModelDb,
    rssiDbm,
    rssiModelDbm,
    timingUs: lost ? null : timing,
    phaseDeg: phase,
    evmPct,
    evmModelPct,
  };
}
