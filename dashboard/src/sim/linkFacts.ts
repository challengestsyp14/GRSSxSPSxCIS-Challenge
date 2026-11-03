// Signal facts quoted on the site, derived from the link model so the text never drifts from it.
//
// The carrier is fixed; only the orbit's Doppler shift moves it. The received power follows the
// link budget (free space plus the ITU-R P.618 atmosphere) at the current slant range, from the
// elevation mask to the zenith. Amplitudes are the peak voltage of that carrier across the
// receiver's 50 Ω input. The physics gates are the chi-square engine's (physicsEngine.ts).

import {
  ALTITUDE_KM,
  CARRIER_HZ,
  atmosphericLossDb,
  MASK_ELEVATION_DEG,
  NOISE_FLOOR_DBM,
  REAL_PASS_S,
  fsplDb,
  passAt,
  snrPredDb,
  timeAfterAos,
} from './geometry';
import { FRAME_PERIOD_S } from './constants';
import { NATURAL_SIGMA, PhysicsEngine } from './physicsEngine';
import { HIJACK_OFFSET_HZ, JAMMED_RSSI_DBM } from './signals';

/** Receiver input impedance used to turn power into voltage. */
export const RX_OHMS = 50;

/** Peak voltage (µV) of a sine carrier of `dbm` across the receiver input. */
export const peakMicrovolts = (dbm: number): number =>
  Math.sqrt(2 * 10 ** (dbm / 10) * 1e-3 * RX_OHMS) * 1e6;

/** RMS voltage (µV) of noise of `dbm` across the receiver input. */
export const rmsMicrovolts = (dbm: number): number =>
  Math.sqrt(10 ** (dbm / 10) * 1e-3 * RX_OHMS) * 1e6;

/** SNR lost when noise `aboveFloorDb` above the thermal floor is added to the channel. */
export const snrLossDb = (aboveFloorDb: number): number =>
  10 * Math.log10(1 + 10 ** (aboveFloorDb / 10));

const atMask = passAt(timeAfterAos(0));
const snrMin = snrPredDb(atMask.rangeKm, atMask.elevationDeg);
const snrMax = snrPredDb(ALTITUDE_KM, 90);

export const SIGNAL = {
  carrierMHz: CARRIER_HZ / 1e6,
  altitudeKm: ALTITUDE_KM,
  maskElevationDeg: MASK_ELEVATION_DEG,
  passMinutes: REAL_PASS_S / 60,
  /** Largest Doppler shift, at the elevation mask (positive on the rise, negative on the set). */
  dopplerMaxKHz: Math.abs(atMask.dopplerHz) / 1e3,
  slantRangeKm: { mask: atMask.rangeKm, zenith: ALTITUDE_KM },
  pathLossDb: {
    mask: fsplDb(atMask.rangeKm, CARRIER_HZ / 1e6),
    zenith: fsplDb(ALTITUDE_KM, CARRIER_HZ / 1e6),
  },
  /** ITU-R P.618 median atmosphere: mostly oxygen and water-vapour absorption. */
  atmosphereDb: { mask: atmosphericLossDb(atMask.elevationDeg), zenith: atmosphericLossDb(90) },
  /** Received carrier power: RSSI = noise floor + SNR. */
  rxDbm: { mask: NOISE_FLOOR_DBM + snrMin, zenith: NOISE_FLOOR_DBM + snrMax },
  snrDb: { mask: snrMin, zenith: snrMax },
  amplitudeUv: {
    mask: peakMicrovolts(NOISE_FLOOR_DBM + snrMin),
    zenith: peakMicrovolts(NOISE_FLOOR_DBM + snrMax),
  },
  noiseFloorDbm: NOISE_FLOOR_DBM,
  noiseUvRms: rmsMicrovolts(NOISE_FLOOR_DBM),
  modulation: 'QPSK',
  occupiedMHz: 6,
  framePeriodS: FRAME_PERIOD_S,
} as const;

const physics = new PhysicsEngine();

/** The chi-square engine: 4 degrees of freedom, 1e-4 false alarms, gate widening at the horizon. */
export const CHI_SQUARE = {
  dof: physics.dof,
  falseAlarmRate: 1e-4,
  gate: physics.baseThreshold,
  /** The gate at the elevation mask, where scintillation and multipath widen the residuals. */
  maskGate: physics.adaptiveThreshold(MASK_ELEVATION_DEG),
  kinematicGateZ: physics.kinematicGateZ,
} as const;

/** Largest residual on one axis that, alone, stays inside the gate above ~30° elevation. */
const alone = (name: keyof typeof NATURAL_SIGMA) => physics.axisLimit(name, 90);

/**
 * Natural variation against the orbit model on a clean pass (signals.ts with no attack): the
 * one-sigma spread the chi-square engine divides by, the largest excursion seen, and how far one
 * residual alone may go before the gate fires. tests/sim.test.ts re-measures these figures.
 */
export const NATURAL = {
  carrierHz: { sigma: NATURAL_SIGMA.dopplerHz, max: 19, gate: alone('dopplerHz') },
  powerDb: { sigma: NATURAL_SIGMA.rssiDb, max: 0.82, gate: alone('rssiDb') },
  timingUs: { sigma: 1.6, max: 4.5, gate: alone('rangeKm') / (NATURAL_SIGMA.rangeKm / 1.6) },
  phaseDeg: { sigma: NATURAL_SIGMA.phaseDeg, max: 5.4, gate: alone('phaseDeg') },
} as const;

/** J/N of a jam that costs the link `lossDb` of SNR: SNR lost = 10·log10(1 + J/N). */
const jamToNoiseFor = (lossDb: number) => 10 * Math.log10(10 ** (lossDb / 10) - 1);

/**
 * The stealth budget at `elevationDeg`: the most SNR a jammer can take before the power residual
 * alone fires the chi-square gate, which widens near the horizon, and the J/N that costs it.
 */
export function stealthBudgetAt(elevationDeg: number) {
  const maxSnrLossDb = physics.axisLimit('rssiDb', elevationDeg);
  return {
    elevationDeg,
    gate: physics.adaptiveThreshold(elevationDeg),
    widening: physics.adaptiveThreshold(elevationDeg) / CHI_SQUARE.gate,
    maxSnrLossDb,
    maxNoiseAboveFloorDb: jamToNoiseFor(maxSnrLossDb),
  };
}

/** The budget at the 2° mask, at 9° and 30°, and overhead. */
export const STEALTH_BY_ELEVATION = [2, 9, 30, 90].map(stealthBudgetAt);

/** The most noise an attacker can add overhead, the strictest case. */
const maxSnrLossDb = NATURAL.powerDb.gate;
export const STEALTH = {
  maxSnrLossDb,
  maxNoiseAboveFloorDb: jamToNoiseFor(maxSnrLossDb),
  maxNoiseDbm: NOISE_FLOOR_DBM + jamToNoiseFor(maxSnrLossDb),
  /** At the 2° mask, where the gate is widest. */
  atMask: stealthBudgetAt(2),
  /** The old ±4 dB band of box gates, for comparison: 4 dB of SNR could go unseen. */
  boxBandDb: 4,
} as const;

export const ATTACK_SIGNALS = {
  hijackMHz: (CARRIER_HZ + HIJACK_OFFSET_HZ) / 1e6,
  hijackOffsetMHz: HIJACK_OFFSET_HZ / 1e6,
  /** Default attack power: the hijacker's excess over the genuine carrier, and the jammer's. */
  defaultPowerDb: 9,
  jammedRssiDbm: JAMMED_RSSI_DBM,
  spoofPowerDropDb: 3.2,
} as const;
