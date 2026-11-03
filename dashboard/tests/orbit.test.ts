import { twoline2satrec } from 'satellite.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PASS_S,
  REFERENCE_PROFILE,
  SCENE_ORBIT_RADIUS,
  passAt,
  passProfile,
  sceneTiltFor,
  setPassProfile,
} from '../src/sim/geometry';
import {
  BUILTIN_TLE,
  LIVE_NORAD_ID,
  findPass,
  isValidTle,
  loadPassProfile,
  passProfileFor,
  tleChecksum,
  type TleRecord,
} from '../src/sim/orbit';

// TerraSAR-X's built-in element set, shared with the digital twin
// (digital_twin/ephemeris_loader.py), so the browser's SGP4 passes can be checked against the
// Python twin's.
const TSX = BUILTIN_TLE;
const EPOCH_MS = Date.UTC(2026, 9, 26, 11, 12, 50);
// Another satellite's elements: TerraSAR-X's moved to the ISS's catalogue number.
const relabel = (line: string) => {
  const moved = line.slice(0, 2) + '25544' + line.slice(7, 68);
  return moved + tleChecksum(moved);
};
const OTHER: TleRecord = {
  ...TSX,
  name: 'ISS (ZARYA)',
  noradId: 25544,
  line1: relabel(TSX.line1),
  line2: relabel(TSX.line2),
};

const serve = (body: unknown, ok = true) =>
  (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 502 })) as typeof fetch;
const unreachable = (async () => {
  throw new TypeError('Failed to fetch');
}) as typeof fetch;

beforeEach(() => window.localStorage.clear());
afterEach(() => setPassProfile(REFERENCE_PROFILE));

describe('SGP4 passes over Zaghouan', () => {
  // Python twin, horizon to horizon: 16:02:38.1 → 16:12:56.8 UTC, culmination 18.539° at az
  // 69.7°, 1276.5 km; then 17:36:07.6 → 17:46:56.8, 23.335° at az 264.0°, 1103.8 km.
  it('finds the same passes as the Python digital twin', () => {
    const satrec = twoline2satrec(TSX.line1, TSX.line2);
    const first = findPass(satrec, EPOCH_MS)!;
    expect(first.aosMs / 1000).toBeCloseTo(Date.UTC(2026, 9, 26, 16, 2, 38.1) / 1000, -0.5);
    expect(first.losMs / 1000).toBeCloseTo(Date.UTC(2026, 9, 26, 16, 12, 56.8) / 1000, -0.5);

    const low = passProfileFor(TSX, EPOCH_MS, 'celestrak')!;
    expect(low.maxElevationDeg).toBeCloseTo(18.539, 1);
    expect(low.culminationAzDeg).toBeCloseTo(69.7, 0);
    expect(low.realPassS).toBeCloseTo(618.7, -0.5);

    const next = passProfileFor(TSX, first.losMs + 60_000, 'celestrak')!;
    expect(next.maxElevationDeg).toBeCloseTo(23.335, 1);
    expect(next.culminationAzDeg).toBeCloseTo(264.0, 0);
    const culmination = next.at(0.5);
    expect(culmination.rangeKm).toBeGreaterThan(1102);
    expect(culmination.rangeKm).toBeLessThan(1106);
  });

  it('samples a pass from horizon to horizon, approaching then receding', () => {
    const p = passProfileFor(TSX, EPOCH_MS + 17 * 3_600_000, 'celestrak')!;
    expect(p.at(0).elevationDeg).toBeCloseTo(0, 1);
    expect(p.at(1).elevationDeg).toBeCloseTo(0, 1);
    expect(p.at(0.02).dopplerHz).toBeGreaterThan(150e3);
    expect(p.at(0.98).dopplerHz).toBeLessThan(-150e3);
    expect(p.at(0).rangeKm).toBeGreaterThan(2500);
    expect(p.altitudeKm).toBeGreaterThan(500);
    expect(p.altitudeKm).toBeLessThan(520);
  });

  it('skips passes lower than 10 degrees', () => {
    const satrec = twoline2satrec(TSX.line1, TSX.line2);
    let from = EPOCH_MS;
    for (let i = 0; i < 6; i++) {
      const p = passProfileFor(TSX, from, 'celestrak')!;
      expect(p.maxElevationDeg).toBeGreaterThanOrEqual(10);
      from = findPass(satrec, from)!.losMs + 60_000;
    }
  });

  it('tilts the scene orbit so the scene pass culminates as high as the real one', () => {
    expect(sceneTiltFor(90)).toBeCloseTo(0, 3);
    for (const el of [10, 25, 44, 70]) {
      const tilt = (sceneTiltFor(el) * Math.PI) / 180;
      const scene = Math.atan2(
        SCENE_ORBIT_RADIUS * Math.cos(tilt) - 1,
        SCENE_ORBIT_RADIUS * Math.sin(tilt),
      );
      expect((scene * 180) / Math.PI).toBeCloseTo(el, 3);
    }
  });

  it('replays the live pass through the testbed', () => {
    const p = passProfileFor(TSX, EPOCH_MS + 17 * 3_600_000, 'celestrak')!;
    setPassProfile(p);
    expect(passProfile()).toBe(p);
    expect(passAt(PASS_S / 2).elevationDeg).toBeCloseTo(p.maxElevationDeg, 0);
    expect(passAt(PASS_S / 2).rangeKm).toBeCloseTo(p.at(0.5).rangeKm, 3);
  });
});

describe('loading the live orbit', () => {
  it('validates element sets', () => {
    expect(isValidTle(TSX)).toBe(true);
    expect(isValidTle(OTHER)).toBe(false); // another satellite
    expect(isValidTle({ ...TSX, line2: TSX.line2.slice(0, 68) + '0' })).toBe(
      tleChecksum(TSX.line2) === 0,
    );
    expect(isValidTle(null)).toBe(false);
  });

  it('flies the live download and keeps it for offline use', async () => {
    const download = { ...TSX, fetchedUtc: '2026-10-28T08:00:00.000Z' };
    const live = await loadPassProfile(EPOCH_MS, serve(download));
    expect(live.source).toBe('celestrak');
    expect(live.satName).toBe('TERRASAR-X');
    expect(live.noradId).toBe(LIVE_NORAD_ID);
    expect(live.fetchedMs).toBe(Date.parse(download.fetchedUtc));

    const offline = await loadPassProfile(EPOCH_MS, unreachable);
    expect(offline.source).toBe('cache');
    expect(offline.aosMs).toBe(live.aosMs);
    expect(offline.fetchedMs).toBe(live.fetchedMs);
  });

  it('flies the built-in TerraSAR-X element set with no download and no cache', async () => {
    for (const fetcher of [
      unreachable,
      serve({ error: 'CelesTrak down' }, false),
      serve(OTHER), // another satellite is refused
    ]) {
      window.localStorage.clear();
      const p = await loadPassProfile(EPOCH_MS, fetcher);
      expect(p.source).toBe('builtin');
      expect(p.noradId).toBe(LIVE_NORAD_ID);
      expect(p.tleEpochMs).toBeCloseTo(Date.UTC(2026, 9, 26, 11, 12, 50, 10), -1);
    }
  });

  it('stays on the reference pass in tests unless a fetcher is given', async () => {
    expect(await loadPassProfile()).toBe(REFERENCE_PROFILE);
  });
});
