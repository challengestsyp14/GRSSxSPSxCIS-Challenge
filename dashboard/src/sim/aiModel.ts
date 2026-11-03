// CIS layer: Isolation Forest over per-tick feature vectors, trained on nominal passes only.
//
// A robust per-feature gate runs beside the forest: a value far beyond the training range is
// isolated no faster than the most extreme training point, so a forest alone saturates on
// single-feature outliers. Both scores are calibrated on held-out nominal data so that the
// published operating point (score 0.6) corresponds to the target false-alarm rate.

import { passAt, snrPredDb } from './geometry';
import { IsolationForest, quantile } from './iforest';
import { sample, type Sample } from './signals';

export const FEATURES = [
  'doppler residual',
  'SNR residual',
  'timing skew',
  'EVM residual',
  'frame loss',
  'MAC / nonce failures',
] as const;

/** Target nominal exceedance of the 0.6 operating point (0.6 % false-alarm target). */
export const TARGET_FAR = 0.006;
export const FLAG_AT = 0.6;
const NO_FRAMES_Z = 12;

export interface FrameStats {
  lossRate: number;
  failRate: number;
}

export interface AiScales {
  doppler: number;
  snr: number;
  timing: number;
  evm: number;
}

export function featureVector(x: Sample, frames: FrameStats, scales: AiScales): number[] {
  return [
    Math.abs(x.dopplerHz) / scales.doppler,
    Math.abs(x.snrDb - x.snrModelDb) / scales.snr,
    x.timingUs === null ? NO_FRAMES_Z : Math.abs(x.timingUs) / scales.timing,
    Math.abs(x.evmPct - x.evmModelPct) / scales.evm,
    frames.lossRate,
    frames.failRate,
  ];
}

/** Nominal samples across many passes (no attacks), deterministic. */
export function nominalSamples(count: number, start: number, step: number): Sample[] {
  const out: Sample[] = [];
  let s = start;
  while (out.length < count) {
    const pass = passAt(s);
    if (pass.linkActive)
      out.push(
        sample(s, snrPredDb(pass.rangeKm, pass.elevationDeg), { attacks: [], falseAlarm: 0 }),
      );
    s += step;
  }
  return out;
}

const median = (v: number[]) => quantile(v, 0.5);

export class AiModel {
  readonly forest: IsolationForest;
  readonly scales: AiScales;
  private featureCaps: number[] = [];
  private forestNorm = 1;
  private gateNorm = 1;
  private rawNorm = 1;

  constructor(seed = 7) {
    const train = nominalSamples(4000, 11.3, 0.37);
    const calibrate = nominalSamples(4000, 5003.1, 0.41);

    this.scales = {
      doppler: median(train.map((x) => Math.abs(x.dopplerHz))),
      snr: median(train.map((x) => Math.abs(x.snrDb - x.snrModelDb))),
      timing: median(train.map((x) => Math.abs(x.timingUs ?? 0))),
      evm: median(train.map((x) => Math.abs(x.evmPct - x.evmModelPct))),
    };

    const clean = { lossRate: 0, failRate: 0 };
    const trainX = train.map((x) => featureVector(x, clean, this.scales));
    const calX = calibrate.map((x) => featureVector(x, clean, this.scales));

    this.forest = new IsolationForest({ nEstimators: 256, sampleSize: 256, seed }).fit(trainX);

    const level = 1 - TARGET_FAR;
    this.featureCaps = FEATURES.map((_, i) =>
      Math.max(
        quantile(
          calX.map((v) => v[i]),
          level,
        ),
        0.05,
      ),
    );
    this.forestNorm = quantile(
      calX.map((v) => this.forest.score(v)),
      level,
    );
    this.gateNorm = quantile(
      calX.map((v) => this.gate(v)),
      level,
    );
    this.rawNorm = quantile(
      calX.map((v) => this.raw(v)),
      level,
    );
  }

  private gate(v: number[]): number {
    let worst = 0;
    for (let i = 0; i < v.length; i++) worst = Math.max(worst, v[i] / this.featureCaps[i]);
    return worst;
  }

  private raw(v: number[]): number {
    return Math.max(this.forest.score(v) / this.forestNorm, this.gate(v) / this.gateNorm);
  }

  /** Score in [0, 1]; FLAG_AT is reached at the calibrated false-alarm quantile. */
  score(v: number[]): number {
    const r = this.raw(v) / this.rawNorm;
    return 1 - (1 - FLAG_AT) ** (r * r * r);
  }

  /** Index of the feature furthest beyond its nominal range. */
  driver(v: number[]): number {
    let best = 0;
    let worst = -Infinity;
    for (let i = 0; i < v.length; i++) {
      const z = v[i] / this.featureCaps[i];
      if (z > worst) {
        worst = z;
        best = i;
      }
    }
    return best;
  }
}
