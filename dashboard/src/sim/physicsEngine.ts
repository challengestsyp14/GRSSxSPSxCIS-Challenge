// Physical layer: browser port of digital_twin/security_detector.py, the chi-square physics
// engine of the digital twin.
//
// Chi-square residuals. The station predicts range, Doppler, received power and carrier phase
// from the orbit and the link budget. Each measured residual is divided by its natural one-sigma
// spread on a clean pass (1.6 µs of frame timing, i.e. 0.48 km of range, 6.1 Hz of carrier,
// 0.23 dB of power, 1.5° of carrier phase) and the squares are summed: on a clean link the sum
// follows a chi-square law with four degrees of freedom, so the gate is its quantile for a 1e-4
// false-alarm rate. Near the horizon scintillation and multipath widen the residuals: the
// covariance grows by 1 + 2 exp(-elevation / 6°), and the gate with it.
//
// Kinematic coupling. The Doppler shift is the range rate, f_d = -f_c (dρ/dt) / c, so the range
// change since the last trusted measurement must equal the Doppler integrated over the interval
// (trapezoidal rule), whatever the orbit. A delay that steps or drifts without the matching
// Doppler, the signature of a meaconer, fails it even when the orbit model is stale.
//
// Same constants and the same verdict strings as the Python twin.

import { CARRIER_HZ, C_KM_S, EARTH_RADIUS_KM } from './geometry';

/** Natural one-sigma spread of each residual on a clean pass, above ~30° elevation. */
export const NATURAL_SIGMA = {
  rangeKm: 1.6e-6 * C_KM_S,
  dopplerHz: 6.1,
  rssiDb: 0.23,
  phaseDeg: 1.5,
} as const;

export type Residual = keyof typeof NATURAL_SIGMA;
export const RESIDUALS = Object.keys(NATURAL_SIGMA) as Residual[];

export const RESIDUAL_LABEL: Record<Residual, string> = {
  rangeKm: 'Slant range',
  dopplerHz: 'Doppler',
  rssiDb: 'Received power',
  phaseDeg: 'Carrier phase',
};

export const FALSE_ALARM_RATE = 1e-4;
/** Longest interval over which the last trusted measurement anchors the kinematic test. */
export const KINEMATIC_MAX_GAP_S = 30;
/** Speed of the ground at the equator, added to the orbital speed for a safe bound. */
export const EARTH_SURFACE_SPEED_KM_S = 0.465;
const MU_KM3_S2 = 398_600.4418;

/** Survival function of the chi-square law, exact for an even number of degrees of freedom. */
export function chiSquareSf(x: number, dof: number): number {
  if (dof % 2) throw new Error('closed form needs an even number of degrees of freedom');
  const half = x / 2;
  let term = 1;
  let total = 1;
  for (let i = 1; 2 * i < dof; i++) {
    term *= half / i;
    total += term;
  }
  return Math.exp(-half) * total;
}

/** Inverse CDF of the chi-square law, by bisection on the survival function. */
export function chiSquareQuantile(probability: number, dof: number): number {
  let low = 0;
  let high = 1000;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (low + high);
    if (1 - chiSquareSf(mid, dof) < probability) low = mid;
    else high = mid;
  }
  return 0.5 * (low + high);
}

/** Complementary error function (Numerical Recipes erfcc, fractional error below 1.2e-7). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/** z with P(|Z| > z) = falseAlarmRate for a standard normal Z, by bisection. */
export function normalTwoSidedQuantile(falseAlarmRate: number): number {
  let low = 0;
  let high = 40;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (low + high);
    if (erfc(mid / Math.SQRT2) > falseAlarmRate) low = mid;
    else high = mid;
  }
  return 0.5 * (low + high);
}

/** Variance growth of the residuals near the horizon: 3x at 0°, ~1 above 30°. */
export const elevationSpreadFactor = (elevationDeg: number): number =>
  1 + 2 * Math.exp(-Math.max(elevationDeg, 0) / 6);

/** Largest |d³ρ/dt³| of a pass (km/s³): 0.859 v³ / ρ_min², at u = 1/2. */
export const rangeJerkBound = (minRangeKm: number, relativeSpeedKmS: number): number =>
  (0.859 * relativeSpeedKmS ** 3) / minRangeKm ** 2;

/** The jerk bound for a circular orbit at `altitudeKm`, overhead. */
export function rangeJerkBoundFor(altitudeKm: number): number {
  const speed = Math.sqrt(MU_KM3_S2 / (EARTH_RADIUS_KM + altitudeKm));
  return rangeJerkBound(altitudeKm, speed + EARTH_SURFACE_SPEED_KM_S);
}

/** What the signal claims, or what the orbit and link budget say it must be. */
export interface LinkState {
  rangeKm: number;
  /** Doppler shift of the carrier, Hz (positive while the satellite approaches). */
  dopplerHz: number;
  rssiDbm: number;
  phaseDeg: number;
}

export interface KinematicResult {
  available: boolean;
  intervalS: number;
  rangeChangeKm: number;
  dopplerRangeChangeKm: number;
  residualKm: number;
  sigmaKm: number;
  z: number;
  gateZ: number;
  breach: boolean;
  verdict: 'KINEMATIC_NO_REFERENCE' | 'KINEMATIC_CONSISTENT' | 'KINEMATIC_VIOLATION';
}

export interface PhysicsResult {
  chiSquare: number;
  /** Chi-square gate at this elevation. */
  threshold: number;
  dof: number;
  residuals: Record<Residual, number>;
  normalized: Record<Residual, number>;
  dominant: Residual;
  chiSquareBreach: boolean;
  kinematic: KinematicResult;
  breach: boolean;
  verdict: 'PHYSICS_CONSISTENT' | 'PHYSICS_VIOLATION';
}

const NO_REFERENCE: KinematicResult = {
  available: false,
  intervalS: 0,
  rangeChangeKm: 0,
  dopplerRangeChangeKm: 0,
  residualKm: 0,
  sigmaKm: 0,
  z: 0,
  gateZ: 0,
  breach: false,
  verdict: 'KINEMATIC_NO_REFERENCE',
};

interface Anchor {
  t: number;
  elevationDeg: number;
  rangeKm: number;
  dopplerHz: number;
}

export class PhysicsEngine {
  readonly dof = RESIDUALS.length;
  readonly baseThreshold: number;
  readonly kinematicGateZ: number;
  readonly rangeJerkBoundKmS3: number;
  private anchor: Anchor | null = null;

  constructor({
    falseAlarmRate = FALSE_ALARM_RATE,
    rangeJerkBoundKmS3 = rangeJerkBoundFor(514),
  }: { falseAlarmRate?: number; rangeJerkBoundKmS3?: number } = {}) {
    this.baseThreshold = chiSquareQuantile(1 - falseAlarmRate, this.dof);
    this.kinematicGateZ = normalTwoSidedQuantile(falseAlarmRate);
    this.rangeJerkBoundKmS3 = rangeJerkBoundKmS3;
  }

  adaptiveThreshold(elevationDeg: number): number {
    return this.baseThreshold * elevationSpreadFactor(elevationDeg);
  }

  sigmaAt(name: Residual, elevationDeg: number): number {
    return NATURAL_SIGMA[name] * Math.sqrt(elevationSpreadFactor(elevationDeg));
  }

  /** Largest residual on one axis that, alone, stays inside the gate at this elevation. */
  axisLimit(name: Residual, elevationDeg: number): number {
    return NATURAL_SIGMA[name] * Math.sqrt(this.adaptiveThreshold(elevationDeg));
  }

  /** Chi-square of a measurement against the prediction, without touching the anchor. */
  chiSquare(rx: LinkState, truth: LinkState, elevationDeg: number) {
    const residuals = {
      rangeKm: rx.rangeKm - truth.rangeKm,
      dopplerHz: rx.dopplerHz - truth.dopplerHz,
      rssiDb: rx.rssiDbm - truth.rssiDbm,
      phaseDeg: rx.phaseDeg - truth.phaseDeg,
    };
    const normalized = {} as Record<Residual, number>;
    let chiSquare = 0;
    let dominant: Residual = RESIDUALS[0];
    for (const name of RESIDUALS) {
      const z = residuals[name] / NATURAL_SIGMA[name];
      normalized[name] = z;
      chiSquare += z * z;
      if (Math.abs(z) > Math.abs(normalized[dominant])) dominant = name;
    }
    const threshold = this.adaptiveThreshold(elevationDeg);
    return {
      chiSquare,
      threshold,
      residuals,
      normalized,
      dominant,
      chiSquareBreach: chiSquare > threshold,
    };
  }

  /** Range change since the last trusted measurement against the integrated Doppler. */
  kinematicCoupling(rx: LinkState, elevationDeg: number, t: number): KinematicResult {
    const a = this.anchor;
    if (!a || !(t - a.t > 0 && t - a.t <= KINEMATIC_MAX_GAP_S)) return NO_REFERENCE;
    const dt = t - a.t;
    // km of range per Hz of Doppler per second: f_d = -f_c (dρ/dt) / c.
    const scale = C_KM_S / CARRIER_HZ;
    const rangeChangeKm = rx.rangeKm - a.rangeKm;
    const dopplerRangeChangeKm = -scale * 0.5 * (rx.dopplerHz + a.dopplerHz) * dt;
    const residualKm = rangeChangeKm - dopplerRangeChangeKm;
    const variance =
      this.sigmaAt('rangeKm', elevationDeg) ** 2 +
      this.sigmaAt('rangeKm', a.elevationDeg) ** 2 +
      (0.5 * scale * dt) ** 2 *
        (this.sigmaAt('dopplerHz', elevationDeg) ** 2 +
          this.sigmaAt('dopplerHz', a.elevationDeg) ** 2) +
      ((this.rangeJerkBoundKmS3 * dt ** 3) / 12) ** 2;
    const sigmaKm = Math.sqrt(variance);
    const z = residualKm / sigmaKm;
    const breach = Math.abs(z) > this.kinematicGateZ;
    return {
      available: true,
      intervalS: dt,
      rangeChangeKm,
      dopplerRangeChangeKm,
      residualKm,
      sigmaKm,
      z,
      gateZ: this.kinematicGateZ,
      breach,
      verdict: breach ? 'KINEMATIC_VIOLATION' : 'KINEMATIC_CONSISTENT',
    };
  }

  /**
   * Chi-square against the prediction, kinematic coupling of range and Doppler, and the verdict.
   * `t` is real time in seconds; a consistent measurement becomes the next kinematic anchor.
   */
  evaluate(rx: LinkState, truth: LinkState, elevationDeg: number, t: number): PhysicsResult {
    const chi = this.chiSquare(rx, truth, elevationDeg);
    const kinematic = this.kinematicCoupling(rx, elevationDeg, t);
    const breach = chi.chiSquareBreach || kinematic.breach;
    if (!breach) {
      this.anchor = { t, elevationDeg, rangeKm: rx.rangeKm, dopplerHz: rx.dopplerHz };
    }
    return {
      ...chi,
      dof: this.dof,
      kinematic,
      breach,
      verdict: breach ? 'PHYSICS_VIOLATION' : 'PHYSICS_CONSISTENT',
    };
  }

  /** Forgets the kinematic anchor: the next measurement starts a new reference. */
  reset() {
    this.anchor = null;
  }
}

export type ChiSquareResult = ReturnType<PhysicsEngine['chiSquare']>;
