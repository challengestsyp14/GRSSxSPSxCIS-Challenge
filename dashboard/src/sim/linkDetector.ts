// Browser port of testbed/detector.py and testbed/zero_trust.py.
//
// Six features, none of them a residual the chi-square gate tests: the EVM against the link
// budget's, the frame-loss rate over the last 10 slots, the jitter of the arrival time since the
// last decoded frame, the MAC and nonce failure rate over the last 10 decoded frames, and the
// change of the carrier and power residuals since the last packet the whole pipeline accepted.
// An Isolation Forest trained on nominal passes only flags at a 1 % contamination threshold; since
// a forest cannot split on a feature that never varied in training (no MAC failure happens on a
// clean pass), any feature beyond the largest value seen in training flags too. The same features
// and settings as digital_twin/isolation_forest_detector.py's SiteFrameForest. A physics gate
// flags what no orbit can produce. The red-team label on a frame is never read here.

import { FRAME_PERIOD_S } from './constants';
import { PERIOD_S, passAt, snrPredDb } from './geometry';
import { IsolationForest, quantile } from './iforest';
import { sample } from './signals';

export const MAX_CARRIER_RESIDUAL_MHZ = 0.5;
export const MAX_CARRIER_STEP_MHZ = 0.5;
export const MAX_RSSI_RESIDUAL_DB = 4.0;
export const CONTAMINATION = 0.01;
/** The rates look back over this many frame slots (loss) and decoded frames (MAC failures). */
export const RATE_WINDOW = 10;
/** Measurements further apart than this, seconds, start a new sequence (no step, no jitter). */
const SEQUENCE_GAP_S = 2;
/** Floor of the training-range check on a feature that never varied in training. */
const RANGE_FLOOR = [0.5, 0.05, 1.0, 0.05, 1e-4, 0.1];

/** The satellite the station has cleared: its identity in every frame and its hardware token. */
export let SAT_ID = 'TERRASAR-X';
export let SAT_TOKEN = '0x4FE2';
export const ROGUE_TOKEN = '0x99A2';

/** Frame identity of a CelesTrak name: "ARIRANG-5 (KOMPSAT-5)" flies as ARIRANG-5. */
export const satelliteIdFor = (name: string): string =>
  name.split(' (')[0].trim().toUpperCase().replace(/\s+/g, '-');

/** The hardware token registered for a satellite: TerraSAR-X's, else one derived from its NORAD. */
export function tokenFor(noradId: number): string {
  if (noradId === 31698) return '0x4FE2';
  let token = (Math.imul(noradId, 0x9e3779b1) >>> 16) & 0xffff;
  if (token === 0x99a2) token ^= 0x0101; // never the rogue node's
  return `0x${token.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Clears the satellite the testbed flies, before the engine starts. */
export function setSatelliteIdentity(name: string, noradId: number): void {
  SAT_ID = satelliteIdFor(name);
  SAT_TOKEN = tokenFor(noradId);
}

export interface RfMeasurement {
  carrierMHz: number;
  carrierModelMHz: number;
  rssiDbm: number;
  rssiModelDbm: number;
  evmPct: number;
  evmModelPct: number;
  /** Arrival against the predicted light time, µs; null when the frame did not decode. */
  timingUs: number | null;
  /** Simulation time of the frame slot, s. */
  t: number;
}

export const FEATURE_NAMES = [
  'EVM residual',
  'frame-loss rate',
  'arrival jitter',
  'MAC / nonce failure rate',
  'carrier step',
  'power step',
] as const;
export const FEATURE_UNITS = ['%', '', 'µs', '', 'MHz', 'dB'] as const;

export interface DetectorResult {
  /** The six features, in FEATURE_NAMES order. */
  features: number[];
  /** Features beyond the largest value seen in training. */
  beyondRange: string[];
  physics: boolean;
  physicsReasons: string[];
  /** Isolation Forest anomaly score in (0, 1); higher is more anomalous. */
  score: number;
  /** Score at the 1 % contamination point of the nominal training set. */
  threshold: number;
  /** Share of held-out nominal packets that score below this one. */
  confidence: number;
  forest: boolean;
  anomaly: boolean;
}

function residuals(rf: RfMeasurement): [number, number] {
  return [rf.carrierMHz - rf.carrierModelMHz, rf.rssiDbm - rf.rssiModelDbm];
}

/** What the detector remembers of the frames before this one. */
class FrameHistory {
  private slots: boolean[] = [];
  private failures: boolean[] = [];
  private last: { t: number; timingUs: number } | null = null;

  rates(): [number, number] {
    const loss = this.slots.length ? this.slots.filter((d) => !d).length / this.slots.length : 0;
    const fail = this.failures.length
      ? this.failures.filter(Boolean).length / this.failures.length
      : 0;
    return [loss, fail];
  }

  jitterUs(rf: RfMeasurement): number {
    const last = this.last;
    if (rf.timingUs === null || !last || rf.t - last.t > SEQUENCE_GAP_S) return 0;
    return Math.abs(rf.timingUs - last.timingUs);
  }

  observe(rf: RfMeasurement, authFailure: boolean) {
    if (this.slots.length && this.last && rf.t - this.last.t > SEQUENCE_GAP_S) {
      this.slots = [];
      this.failures = [];
    }
    const decoded = rf.timingUs !== null;
    this.slots.push(decoded);
    if (this.slots.length > RATE_WINDOW) this.slots.shift();
    if (decoded) {
      this.failures.push(authFailure);
      if (this.failures.length > RATE_WINDOW) this.failures.shift();
      this.last = { t: rf.t, timingUs: rf.timingUs as number };
    }
  }
}

function featureRow(
  rf: RfMeasurement,
  ref: [number, number] | null,
  history: FrameHistory,
): number[] {
  const [fr, rr] = residuals(rf);
  const [loss, fail] = history.rates();
  return [
    rf.evmPct - rf.evmModelPct,
    loss,
    history.jitterUs(rf),
    fail,
    ref ? fr - ref[0] : 0,
    ref ? rr - ref[1] : 0,
  ];
}

/** Nominal packet sequences over many passes, one per frame period, no attacks. */
function nominalFeatures(count: number, start: number, seedOffset: number): number[][] {
  const out: number[][] = [];
  let ref: [number, number] | null = null;
  let history = new FrameHistory();
  let s = start + seedOffset;
  while (out.length < count) {
    const pass = passAt(s);
    if (pass.linkActive) {
      const x = sample(s, snrPredDb(pass.rangeKm, pass.elevationDeg), {
        attacks: [],
        falseAlarm: 0,
        dopplerPredHz: pass.dopplerHz,
      });
      const rf = { ...x, t: s };
      out.push(featureRow(rf, ref, history));
      history.observe(rf, false);
      if (x.timingUs !== null) ref = residuals(rf);
    } else {
      ref = null;
      history = new FrameHistory();
    }
    s += FRAME_PERIOD_S;
    if (s > start + seedOffset + PERIOD_S * 400) break;
  }
  return out;
}

export class LinkDetector {
  readonly forest: IsolationForest;
  readonly threshold: number;
  /** Largest absolute value of each feature in training (with a floor): the range check. */
  readonly caps: number[];
  private readonly calibration: number[];
  private reference: [number, number] | null = null;
  private history = new FrameHistory();

  constructor(seed = 42) {
    const train = nominalFeatures(3000, 17.3, 0);
    this.forest = new IsolationForest({ nEstimators: 256, sampleSize: 256, seed }).fit(train);
    this.threshold = quantile(
      train.map((f) => this.forest.score(f)),
      1 - CONTAMINATION,
    );
    this.caps = RANGE_FLOOR.map((floor, i) => Math.max(floor, ...train.map((f) => Math.abs(f[i]))));
    this.calibration = nominalFeatures(3000, 9001.1, 0)
      .map((f) => this.forest.score(f))
      .sort((a, b) => a - b);
  }

  evaluate(rf: RfMeasurement): DetectorResult {
    const [fr, rr] = residuals(rf);
    const features = featureRow(rf, this.reference, this.history);

    const physicsReasons: string[] = [];
    if (Math.abs(fr) > MAX_CARRIER_RESIDUAL_MHZ)
      physicsReasons.push('carrier offset no orbit can produce');
    if (Math.abs(features[4]) > MAX_CARRIER_STEP_MHZ) physicsReasons.push('carrier jump');
    if (Math.abs(rr) > MAX_RSSI_RESIDUAL_DB)
      physicsReasons.push('carrier power outside the link-budget band');

    const score = this.forest.score(features);
    const beyondRange = FEATURE_NAMES.filter((_, i) => Math.abs(features[i]) > this.caps[i]);
    const forest = score > this.threshold || beyondRange.length > 0;
    const physics = physicsReasons.length > 0;
    return {
      features,
      beyondRange: [...beyondRange],
      physics,
      physicsReasons,
      score,
      threshold: this.threshold,
      confidence: this.percentile(score),
      forest,
      anomaly: physics || forest,
    };
  }

  /** Every frame slot updates the history, whatever the decision. */
  observe(rf: RfMeasurement, authFailure: boolean) {
    this.history.observe(rf, authFailure);
  }

  /** accept(): only packets the whole pipeline accepted become the velocity reference. */
  accept(rf: RfMeasurement) {
    this.reference = residuals(rf);
  }

  private percentile(score: number): number {
    const c = this.calibration;
    let lo = 0;
    let hi = c.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid] < score) lo = mid + 1;
      else hi = mid;
    }
    return lo / c.length;
  }
}

export interface Decision {
  /** The frame reaches the analyst (accepted, or delivered tagged as degraded). */
  allow: boolean;
  action:
    | 'ALLOW_STREAM'
    | 'DELIVER_DEGRADED'
    | 'HOLD_FOR_REVIEW'
    | 'QUARANTINE_AND_DROP'
    | 'QUARANTINE_LINK';
  /** The digital twin's final decision (digital_twin/decision.py). */
  verdict: 'ACCEPTED' | 'DEGRADED' | 'HELD' | 'REJECTED' | 'QUARANTINED';
  reasons: string[];
}

/** evaluate_access_request() in zero_trust.py: evidence only, never what a frame claims. */
export function zeroTrust(
  claimed: { satellite_id: string; hw_token: string } | null,
  authentic: { ok: boolean; reason: string } | null,
  detection: DetectorResult | null,
): Decision {
  const reasons: string[] = [];
  if (!claimed) reasons.push('no frame decoded');
  else if (claimed.satellite_id !== SAT_ID) reasons.push(`${claimed.satellite_id} is not cleared`);
  else if (claimed.hw_token !== SAT_TOKEN)
    reasons.push(
      `emulated hardware token ${claimed.hw_token} does not match ${SAT_ID} registration`,
    );
  if (authentic && !authentic.ok) reasons.push(`trust anchor: ${authentic.reason}`);
  if (detection?.anomaly) reasons.push('detector: RF anomaly');
  return reasons.length
    ? { allow: false, action: 'QUARANTINE_AND_DROP', verdict: 'REJECTED', reasons }
    : { allow: true, action: 'ALLOW_STREAM', verdict: 'ACCEPTED', reasons: [] };
}
