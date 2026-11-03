// How the site names the orbit it replays: live, cached, built in or the reference pass.

import { SATELLITE } from '../sim/copy';
import { ALTITUDE_KM, passProfile, timeCompression, type PassProfile } from '../sim/geometry';

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const KIND: Record<PassProfile['source'], string> = {
  celestrak: 'Live orbit',
  cache: 'Cached orbit',
  builtin: 'Built-in orbit',
  reference: 'Emulated pass',
};

/** Sun-synchronous at low Earth orbit: retrograde, 96–100.5° depending on the altitude. */
const sunSynchronous = (p: PassProfile) =>
  p.altitudeKm < 1500 && p.inclinationDeg > 96 && p.inclinationDeg < 100.5;

/** Viewport readout: which orbit, how high. */
export function orbitReadout(p: PassProfile = passProfile()): string {
  const km = p.source === 'reference' ? ALTITUDE_KM : Math.round(p.altitudeKm);
  return `${SATELLITE} · ${km} km ${sunSynchronous(p) ? 'SSO' : `${p.inclinationDeg.toFixed(0)}°`}`;
}

/** Header chip when no demo runs. */
export function passChip(p: PassProfile = passProfile()): string {
  if (p.source === 'reference' || p.aosMs === null) return 'Emulated pass · standard scenario';
  return `${KIND[p.source]} · pass ${hhmm(p.aosMs)} UTC`;
}

/** One sentence on where the orbit comes from, for the footer. */
export function orbitSource(p: PassProfile = passProfile()): string {
  if (p.source === 'reference' || p.aosMs === null || p.tleEpochMs === null) {
    return (
      `The orbit is the reference pass: ${SATELLITE} overhead on its ${ALTITUDE_KM} km ` +
      'sun-synchronous orbit.'
    );
  }
  const from = {
    celestrak: "CelesTrak's latest element set",
    cache: 'the last CelesTrak element set this browser downloaded (offline)',
    builtin: 'the element set built into the site (CelesTrak unreachable, offline)',
  }[p.source];
  const opening = p.source === 'celestrak' ? 'The orbit is live' : 'The orbit is real';
  return (
    `${opening}: ${SATELLITE} (NORAD ${p.noradId}) from ${from}, epoch ` +
    `${day(p.tleEpochMs)} ${hhmm(p.tleEpochMs)} UTC, propagated with SGP4 in your browser. ` +
    `The pass flown over Zaghouan rises ${day(p.aosMs)} ${hhmm(p.aosMs)} UTC and culminates at ` +
    `${p.maxElevationDeg.toFixed(1)}°; the testbed replays it ×${Math.round(timeCompression())}.`
  );
}
