// Pass geometry for one EO satellite over the Zaghouan ground station.
//
// The pass replayed is a pass profile: the real geometry (elevation, range, range rate,
// Doppler) from horizon to horizon. By default it is the next real pass of a live orbit,
// propagated with SGP4 from CelesTrak's latest element set (orbit.ts); before that loads, and
// whenever it cannot, it is the reference pass: an overhead pass of TerraSAR-X's circular
// 514 km sun-synchronous orbit. The 3D scene uses a stylised orbit radius so both bodies stay
// readable, with its orbit plane tilted so the scene pass culminates as high as the real one;
// the two are tied by pass fraction, so the satellite rises, culminates and sets in the scene
// exactly when the real pass does.

import p618 from '../data/p618.json';
import { clamp } from './noise';

export const EARTH_RADIUS_KM = 6371;
/** TerraSAR-X's nominal altitude. */
export const ALTITUDE_KM = 514;
export const ORBIT_RADIUS_KM = EARTH_RADIUS_KM + ALTITUDE_KM;
const MU_KM3_S2 = 398_600.4418;
/** Kepler's third law for a circular orbit. */
export const ORBIT_PERIOD_S = 2 * Math.PI * Math.sqrt(ORBIT_RADIUS_KM ** 3 / MU_KM3_S2);
export const CARRIER_HZ = 8477.8e6; // X-band downlink
export const C_KM_S = 299_792.458;
/** Receiver noise floor in the channel: RSSI = noise floor + SNR. */
export const NOISE_FLOOR_DBM = -100;

/** Link-budget parameters (illustrative X-band EO downlink, 13 m class station). */
export const LINK = { eirpDbw: 18, lossesDb: 2, gOverTDbK: 31, bandwidthHz: 300e6 };

/** Scene orbit radius in Earth radii (stylised so the pass arc fits the horizon view). */
export const SCENE_ORBIT_RADIUS = 1.6;

/** Seconds of scene time for one horizon-to-horizon pass, and for the unseen remainder. */
export const PASS_S = 66;
export const HIDDEN_S = 3;
export const PERIOD_S = PASS_S + HIDDEN_S;

export const MASK_ELEVATION_DEG = 2;

const OMEGA = (2 * Math.PI) / ORBIT_PERIOD_S;
/** Central angle at which the real satellite crosses the station's horizon. */
export const HORIZON_ANGLE = Math.acos(EARTH_RADIUS_KM / ORBIT_RADIUS_KM);
const SCENE_HORIZON_ANGLE = Math.acos(1 / SCENE_ORBIT_RADIUS);

/** Real pass duration (s) and how much the scene compresses it. */
export const REAL_PASS_S = (2 * HORIZON_ANGLE) / OMEGA;
export const TIME_COMPRESSION = REAL_PASS_S / PASS_S;

export interface PassState {
  /** Central angle from the station, rad, negative while approaching. */
  centralAngle: number;
  /** Scene orbit angle, rad. */
  sceneAngle: number;
  elevationDeg: number;
  rangeKm: number;
  rangeRateKmS: number;
  dopplerHz: number;
  inView: boolean;
  /** Frames flow only above the elevation mask. */
  linkActive: boolean;
  /** Seconds into the current pass (0 at rise). */
  passT: number;
}

export function fsplDb(dKm: number, fMhz: number): number {
  return 20 * Math.log10(dKm) + 20 * Math.log10(fMhz) + 32.44;
}

function interpolateP618(db: number[], elevationDeg: number): number {
  const els = p618.elevationDeg;
  const el = clamp(elevationDeg, els[0], els[els.length - 1]);
  let i = 1;
  while (i < els.length - 1 && els[i] < el) i++;
  const f = (el - els[i - 1]) / (els[i] - els[i - 1]);
  return db[i - 1] + f * (db[i] - db[i - 1]);
}

/**
 * Atmospheric loss exceeded for half of an average year (ITU-R P.618-13: gases, rain, clouds,
 * scintillation) at this elevation over Zaghouan, interpolated from the digital twin's model
 * (digital_twin/link_budget.py, exported by scripts/gen-p618.py).
 */
export const atmosphericLossDb = (elevationDeg: number): number =>
  interpolateP618(p618.totalDb, elevationDeg);

/** The same atmosphere for the S-band telecommand uplink. */
export const uplinkAtmosphericLossDb = (elevationDeg: number): number =>
  interpolateP618(p618.uplinkTotalDb, elevationDeg);

/**
 * Telecommand uplink, ground to satellite (illustrative S-band TT&C: 50 dBW from the station,
 * an omnidirectional antenna on board), in the 2025-2110 MHz space-operation band.
 */
export const UPLINK = {
  carrierHz: p618.uplinkCarrierMHz * 1e6,
  eirpDbw: 50,
  lossesDb: 2,
  rxGainDbi: 0,
} as const;

/** Power the satellite receives from the station's uplink at slant range d, dBm. */
export function uplinkRxDbm(dKm: number, elevationDeg = 90): number {
  const dbw =
    UPLINK.eirpDbw -
    fsplDb(dKm, UPLINK.carrierHz / 1e6) -
    uplinkAtmosphericLossDb(elevationDeg) -
    UPLINK.lossesDb +
    UPLINK.rxGainDbi;
  return dbw + 30;
}

/** Predicted SNR from the link budget at slant range d, seen at this elevation. */
export function snrPredDb(dKm: number, elevationDeg = 90): number {
  const cn0 =
    LINK.eirpDbw -
    fsplDb(dKm, CARRIER_HZ / 1e6) -
    atmosphericLossDb(elevationDeg) -
    LINK.lossesDb +
    LINK.gOverTDbK +
    228.6;
  return cn0 - 10 * Math.log10(LINK.bandwidthHz);
}

export interface RealGeometry {
  rangeKm: number;
  elevationDeg: number;
  rangeRateKmS: number;
  dopplerHz: number;
}

export interface PassProfile {
  /**
   * `celestrak`: live element set; `cache`: the last good download; `builtin`: the element set
   * shipped with the site; `reference`: the analytic overhead pass.
   */
  source: 'celestrak' | 'cache' | 'builtin' | 'reference';
  satName: string;
  noradId: number | null;
  /** Height above the ellipsoid, averaged over the pass flown, km. */
  altitudeKm: number;
  /** Inclination of the orbit, degrees. */
  inclinationDeg: number;
  /** Real duration of the pass from horizon to horizon, s. */
  realPassS: number;
  maxElevationDeg: number;
  /** Azimuth of the satellite at culmination and of its motion there, degrees from north. */
  culminationAzDeg: number;
  trackAzDeg: number;
  /** Tilt of the scene orbit plane from the station's zenith. */
  sceneTiltDeg: number;
  /** Rise of the real pass, and the element set's epoch and download time (Unix ms). */
  aosMs: number | null;
  tleEpochMs: number | null;
  fetchedMs: number | null;
  /** The two lines of the element set flown, for the ledger's SHA-256 record. */
  tleLines?: [string, string];
  /** Real geometry at fraction u of the pass, from horizon (0) to horizon (1). */
  at: (u: number) => RealGeometry;
}

function realFromCentralAngle(phi: number): RealGeometry {
  const r = EARTH_RADIUS_KM;
  const ro = ORBIT_RADIUS_KM;
  const rangeKm = Math.sqrt(r * r + ro * ro - 2 * r * ro * Math.cos(phi));
  const elevation = Math.atan2(ro * Math.cos(phi) - r, ro * Math.abs(Math.sin(phi)));
  const rangeRateKmS = (r * ro * Math.sin(phi) * OMEGA) / rangeKm;
  return {
    rangeKm,
    elevationDeg: (elevation * 180) / Math.PI,
    rangeRateKmS,
    dopplerHz: (-CARRIER_HZ * rangeRateKmS) / C_KM_S,
  };
}

/** Overhead pass of TerraSAR-X's circular 514 km orbit: the testbed's reference geometry. */
export const REFERENCE_PROFILE: PassProfile = {
  source: 'reference',
  satName: 'TERRASAR-X',
  noradId: 31698,
  altitudeKm: ALTITUDE_KM,
  inclinationDeg: 97.45,
  realPassS: REAL_PASS_S,
  maxElevationDeg: 90,
  culminationAzDeg: 90,
  trackAzDeg: 180,
  sceneTiltDeg: 10,
  aosMs: null,
  tleEpochMs: null,
  fetchedMs: null,
  at: (u) => realFromCentralAngle((clamp(u) * 2 - 1) * HORIZON_ANGLE),
};

let profile: PassProfile = REFERENCE_PROFILE;
let sceneHorizon = sceneHorizonAngle(profile.sceneTiltDeg);

/** The pass the testbed replays. */
export const passProfile = (): PassProfile => profile;

export function setPassProfile(next: PassProfile): void {
  profile = next;
  sceneHorizon = sceneHorizonAngle(next.sceneTiltDeg);
}

/** How much faster than real time the scene plays the pass. */
export const timeCompression = (): number => profile.realPassS / PASS_S;

/** Scene orbit angle, from culmination, at which the tilted scene orbit meets the horizon. */
export function sceneHorizonAngle(tiltDeg: number): number {
  return Math.acos(1 / (SCENE_ORBIT_RADIUS * Math.cos((tiltDeg * Math.PI) / 180)));
}

/** Scene orbit tilt at which the stylised pass culminates at `maxElevationDeg`. */
export function sceneTiltFor(maxElevationDeg: number): number {
  const target = (clamp(maxElevationDeg, 0, 90) * Math.PI) / 180;
  const elevationAt = (tilt: number) =>
    Math.atan2(SCENE_ORBIT_RADIUS * Math.cos(tilt) - 1, SCENE_ORBIT_RADIUS * Math.sin(tilt));
  // Elevation falls from 90° at zero tilt to 0° where the scene orbit grazes the horizon.
  let lo = 0;
  let hi = SCENE_HORIZON_ANGLE;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (elevationAt(mid) > target) lo = mid;
    else hi = mid;
  }
  return (((lo + hi) / 2) * 180) / Math.PI;
}

/** Pass state at scene time t (seconds). */
export function passAt(t: number): PassState {
  const local = ((t % PERIOD_S) + PERIOD_S) % PERIOD_S;

  if (local < PASS_S) {
    const u = local / PASS_S;
    const real = profile.at(u);
    return {
      centralAngle: (u * 2 - 1) * HORIZON_ANGLE,
      sceneAngle: (u * 2 - 1) * sceneHorizon,
      ...real,
      inView: true,
      linkActive: real.elevationDeg >= MASK_ELEVATION_DEG,
      passT: local,
    };
  }

  // Below the horizon: sweep the rest of the orbit quickly, back to the next rise.
  const u = (local - PASS_S) / HIDDEN_S;
  const sceneAngle = sceneHorizon + u * (2 * Math.PI - 2 * sceneHorizon);
  return {
    centralAngle: Math.PI,
    sceneAngle,
    elevationDeg: -30,
    rangeKm: NaN,
    rangeRateKmS: NaN,
    dopplerHz: NaN,
    inView: false,
    linkActive: false,
    passT: local,
  };
}

/** Scene time offset that puts the satellite `secondsAfterAos` past the elevation mask. */
export function timeAfterAos(secondsAfterAos: number): number {
  // Solve for the pass fraction where elevation crosses the mask (monotonic on the rise).
  let lo = 0;
  let hi = PASS_S / 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (passAt(mid).elevationDeg < MASK_ELEVATION_DEG) lo = mid;
    else hi = mid;
  }
  return hi + secondsAfterAos;
}

/** Seconds from mask rise to mask set. */
export function linkWindowS(): number {
  return PASS_S - 2 * timeAfterAos(0);
}

export const elevationWeight = (elDeg: number): number => clamp((elDeg - 5) / 40);
