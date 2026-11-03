// Scene frame: the Zaghouan station (GS-ZAG) sits on top of the globe at the origin, +Y is local up,
// -Z is north, +X is east. Earth's centre is EARTH_R below the station.

import * as THREE from 'three';

import { SCENE_ORBIT_RADIUS, passAt, passProfile, type PassProfile } from '../sim/geometry';

export const EARTH_R = 16;
export const EARTH_CENTER = new THREE.Vector3(0, -EARTH_R, 0);
export const ORBIT_R = EARTH_R * SCENE_ORBIT_RADIUS;

/** Zaghouan ground station, Tunisia. */
const ORIGIN = { lat: 36.4, lon: 10.14 };

const rad = (d: number) => (d * Math.PI) / 180;

const lat0 = rad(ORIGIN.lat);
const lon0 = rad(ORIGIN.lon);
const UP = new THREE.Vector3(
  Math.cos(lat0) * Math.cos(lon0),
  Math.cos(lat0) * Math.sin(lon0),
  Math.sin(lat0),
);
const EAST = new THREE.Vector3(-Math.sin(lon0), Math.cos(lon0), 0);
const NORTH = new THREE.Vector3(
  -Math.sin(lat0) * Math.cos(lon0),
  -Math.sin(lat0) * Math.sin(lon0),
  Math.cos(lat0),
);

/** Unit direction (from Earth's centre) for a latitude/longitude, in scene axes. */
export function directionFor(
  latDeg: number,
  lonDeg: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const la = rad(latDeg);
  const lo = rad(lonDeg);
  const p = new THREE.Vector3(
    Math.cos(la) * Math.cos(lo),
    Math.cos(la) * Math.sin(lo),
    Math.sin(la),
  );
  return out.set(p.dot(EAST), p.dot(UP), -p.dot(NORTH));
}

export function surfacePoint(latDeg: number, lonDeg: number, lift = 0): THREE.Vector3 {
  return directionFor(latDeg, lonDeg)
    .multiplyScalar(EARTH_R + lift)
    .add(EARTH_CENTER);
}

/** Orientation that puts local +Y along the surface normal at a point. */
export function surfaceQuaternion(latDeg: number, lonDeg: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    directionFor(latDeg, lonDeg),
  );
}

export interface StationDef {
  id: string;
  lat: number;
  lon: number;
}

export const STATIONS: StationDef[] = [
  { id: 'GS-SVB', lat: 78.2, lon: 15.4 },
  { id: 'GS-KIR', lat: 67.9, lon: 20.2 },
  { id: 'GS-ZAG', lat: 36.4, lon: 10.14 },
  { id: 'GS-MAT', lat: 40.65, lon: 16.7 },
  { id: 'GS-MSP', lat: 27.76, lon: -15.6 },
  { id: 'GS-HBK', lat: -25.9, lon: 27.7 },
  { id: 'GS-TRL', lat: -72.0, lon: 2.5 },
  { id: 'GS-SGP', lat: 1.35, lon: 103.8 },
  { id: 'GS-ALS', lat: -23.7, lon: 133.9 },
  { id: 'GS-INU', lat: 68.3, lon: -133.5 },
  { id: 'GS-FBK', lat: 64.8, lon: -147.7 },
  { id: 'GS-CUI', lat: -15.6, lon: -56.1 },
];

export const RELAY_LINKS: [string, string][] = [
  ['GS-ZAG', 'GS-MAT'],
  ['GS-KIR', 'GS-MAT'],
  ['GS-MSP', 'GS-MAT'],
  ['GS-MSP', 'GS-CUI'],
  ['GS-HBK', 'GS-ZAG'],
  ['GS-HBK', 'GS-SGP'],
  ['GS-SGP', 'GS-ALS'],
  ['GS-INU', 'GS-FBK'],
  ['GS-FBK', 'GS-SVB'],
  ['GS-INU', 'GS-SVB'],
  ['GS-CUI', 'GS-HBK'],
  ['GS-TRL', 'GS-HBK'],
  ['GS-MAT', 'GS-SGP'],
  ['GS-MSP', 'GS-INU'],
  ['GS-ALS', 'GS-HBK'],
];

export const ATTACKERS = {
  hijack: { lat: 36.0, lon: -3.2, label: 'ROGUE-TX +14.2 MHz' },
  spoof: { lat: 39.6, lon: 4.0, label: 'NODE 0x99A2' },
  jam: { lat: 38.1, lon: 14.2, label: 'NOISE JAMMER' },
  /** Forges or replays telecommands toward the satellite, from a boat in the Gulf of Gabès. */
  uplink: { lat: 33.9, lon: 11.0, label: 'ROGUE-UPLINK' },
} as const;

export const stationById = (id: string) => STATIONS.find((s) => s.id === id)!;

// Pass plane, from the pass profile: tilted from the zenith toward the azimuth where the real
// pass culminates, so the scene pass culminates as high, and swept along the real direction of
// travel. The reference pass descends north → south and culminates a little east of zenith.
const PLANE_UP = new THREE.Vector3();
const TRACK = new THREE.Vector3();
let planeFor: PassProfile | null = null;

/** Horizontal unit vector toward an azimuth (degrees from north, clockwise), in scene axes. */
const horizontal = (azDeg: number) =>
  new THREE.Vector3(Math.sin(rad(azDeg)), 0, -Math.cos(rad(azDeg)));

function orbitPlane(): void {
  const profile = passProfile();
  if (profile === planeFor) return;
  const tilt = rad(profile.sceneTiltDeg);
  PLANE_UP.set(0, Math.cos(tilt), 0).addScaledVector(
    horizontal(profile.culminationAzDeg),
    Math.sin(tilt),
  );
  const track = horizontal(profile.trackAzDeg);
  TRACK.copy(track).addScaledVector(PLANE_UP, -track.dot(PLANE_UP)).normalize();
  planeFor = profile;
}

export function orbitPoint(sceneAngle: number, out = new THREE.Vector3()): THREE.Vector3 {
  orbitPlane();
  return out
    .copy(PLANE_UP)
    .multiplyScalar(Math.cos(sceneAngle) * ORBIT_R)
    .addScaledVector(TRACK, Math.sin(sceneAngle) * ORBIT_R)
    .add(EARTH_CENTER);
}

/** Satellite position at engine scene time. */
export function satellitePosition(t: number, out = new THREE.Vector3()): THREE.Vector3 {
  return orbitPoint(passAt(t).sceneAngle, out);
}

/** Visible orbit arc for drawing the path. */
export function orbitArcPoints(segments = 160): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) pts.push(orbitPoint((i / segments) * Math.PI * 2));
  return pts;
}
