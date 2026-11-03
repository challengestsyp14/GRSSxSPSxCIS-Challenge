import { beforeEach, describe, expect, it } from 'vitest';

import { CARRIER_HZ, NOISE_FLOOR_DBM, UPLINK } from '../src/sim/geometry';
import { BUILTIN_TLE, LIVE_NORAD_ID } from '../src/sim/orbit';
import {
  SNAPSHOT,
  buildSignalDb,
  isValidSatellite,
  liveSample,
  loadCatalog,
  passSignals,
  signalCurve,
  type CatalogSatellite,
} from '../src/sim/signalDb';

const TSX: CatalogSatellite = { ...BUILTIN_TLE };
const EPOCH_MS = Date.UTC(2026, 9, 26, 11, 12, 50);
const SNAPSHOT_MS = Date.parse(SNAPSHOT.fetchedUtc);

const serve = (body: unknown, ok = true) =>
  (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 502 })) as typeof fetch;
const unreachable = (async () => {
  throw new TypeError('Failed to fetch');
}) as typeof fetch;

beforeEach(() => window.localStorage.clear());

describe('the signal database source', () => {
  it("ships CelesTrak's Earth-resources group as an offline snapshot", () => {
    expect(SNAPSHOT.source).toBe('snapshot');
    expect(SNAPSHOT.group).toBe('resource');
    expect(SNAPSHOT.satellites.length).toBeGreaterThan(150);
    expect(SNAPSHOT.satellites.every(isValidSatellite)).toBe(true);
    const ids = SNAPSHOT.satellites.map((s) => s.noradId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [LIVE_NORAD_ID, 36605, 39634]) expect(ids).toContain(id); // TSX, TDX, S1A
  });

  it('flies a fresh download and keeps it for offline use', async () => {
    const live = { group: 'resource', fetchedUtc: '2026-10-29T08:00:00.000Z', satellites: [TSX] };
    const c = await loadCatalog(serve(live));
    expect(c.source).toBe('celestrak');
    expect(c.satellites).toHaveLength(1);
    const offline = await loadCatalog(unreachable);
    expect(offline.source).toBe('cache');
    expect(offline.fetchedUtc).toBe(live.fetchedUtc);
  });

  it('refuses broken element sets and falls back to the snapshot', async () => {
    const corrupt = { ...TSX, line2: TSX.line2.slice(0, 68) + ((Number(TSX.line2[68]) + 1) % 10) };
    for (const fetcher of [
      unreachable,
      serve({ error: 'CelesTrak down' }, false),
      serve({ group: 'resource', fetchedUtc: 'now', satellites: [corrupt] }),
      serve({ satellites: 'nope' }),
    ]) {
      window.localStorage.clear();
      expect((await loadCatalog(fetcher)).source).toBe('snapshot');
    }
    const mixed = await loadCatalog(
      serve({ group: 'resource', fetchedUtc: 'now', satellites: [corrupt, TSX] }),
    );
    expect(mixed.satellites).toEqual([TSX]);
  });
});

describe('signals from passes', () => {
  it("matches the digital twin's first TerraSAR-X pass and its link budget", () => {
    // Python twin, from the built-in element set: rises 16:02:38 UTC, culminates at 18.539°.
    const [first] = passSignals(TSX, EPOCH_MS, EPOCH_MS + 12 * 3_600_000);
    expect(first.testbed).toBe(true);
    expect(first.maxElevationDeg).toBeCloseTo(18.54, 1);
    // The link comes up at the 2° mask, a little after the horizon rise.
    expect(first.aosMs).toBeGreaterThan(Date.UTC(2026, 9, 26, 16, 2, 38));
    expect(first.aosMs).toBeLessThan(Date.UTC(2026, 9, 26, 16, 4, 0));
    expect(first.dopplerHz.max).toBeGreaterThan(150e3);
    expect(first.dopplerHz.min).toBeLessThan(-150e3);
    expect(first.rangeKm.min).toBeGreaterThan(1270);
    expect(first.rangeKm.min).toBeLessThan(1285);
    expect(first.rxDbm.min).toBeGreaterThan(-90);
    expect(first.rxDbm.max).toBeLessThan(-74);
    expect(first.snrDb.max).toBeCloseTo(first.rxDbm.max - NOISE_FLOOR_DBM, 9);
    expect(first.atmosphereDb.max).toBeGreaterThan(first.atmosphereDb.min);
  });

  it('samples a pass second by second, consistent with its summary', () => {
    const [sig] = passSignals(TSX, EPOCH_MS, EPOCH_MS + 12 * 3_600_000);
    const curve = signalCurve(TSX, sig.aosMs, sig.losMs, 1);
    expect(curve.length).toBeGreaterThan(400);
    expect(Math.max(...curve.map((s) => s.elevationDeg))).toBeCloseTo(sig.maxElevationDeg, 1);
    expect(Math.max(...curve.map((s) => s.rxDbm))).toBeCloseTo(sig.rxDbm.max, 1);
    expect(curve[0].dopplerHz).toBeGreaterThan(0);
    expect(curve[curve.length - 1].dopplerHz).toBeLessThan(0);
  });

  it('carries the S-band uplink on the same pass, ground to satellite', () => {
    const [sig] = passSignals(TSX, EPOCH_MS, EPOCH_MS + 12 * 3_600_000);
    const curve = signalCurve(TSX, sig.aosMs, sig.losMs, 5);
    for (const s of curve) {
      expect(s.uplinkDopplerHz).toBeCloseTo((s.dopplerHz * UPLINK.carrierHz) / CARRIER_HZ, 3);
    }
    expect(UPLINK.carrierHz).toBe(2050e6);
    expect(sig.uplinkDopplerHz.max).toBeLessThan(sig.dopplerHz.max);
    expect(sig.uplinkRxDbm.min).toBeGreaterThan(-100);
    expect(sig.uplinkRxDbm.max).toBeLessThan(-60);
    const top = curve.reduce((a, b) => (b.elevationDeg > a.elevationDeg ? b : a));
    expect(Math.max(...curve.map((s) => s.uplinkRxDbm))).toBeCloseTo(top.uplinkRxDbm, 0);
  });

  it('reads the sky live: a sample while the satellite is up, nothing once it has set', () => {
    const [sig] = passSignals(TSX, EPOCH_MS, EPOCH_MS + 12 * 3_600_000);
    const mid = (sig.aosMs + sig.losMs) / 2;
    const now = liveSample(TSX, mid)!;
    expect(now.elevationDeg).toBeGreaterThan(sig.maxElevationDeg - 2);
    expect(now.azimuthDeg).toBeGreaterThanOrEqual(0);
    expect(now.azimuthDeg).toBeLessThan(360);
    expect(Math.abs(now.rangeRateKmS)).toBeLessThan(2);
    expect(liveSample(TSX, sig.losMs + 120_000)).toBeNull();
  });

  it('builds the whole database: every satellite, every pass, sorted by rise', async () => {
    const db = await buildSignalDb(SNAPSHOT, SNAPSHOT_MS, 12);
    expect(db.length).toBeGreaterThan(200);
    expect(new Set(db.map((s) => s.noradId)).size).toBeGreaterThan(100);
    for (let i = 1; i < db.length; i++) expect(db[i].aosMs).toBeGreaterThanOrEqual(db[i - 1].aosMs);
    expect(db.every((s) => s.testbed === (s.noradId === LIVE_NORAD_ID))).toBe(true);
    expect(db.some((s) => s.testbed)).toBe(true);
    expect(new Set(db.map((s) => s.id)).size).toBe(db.length);
  });
});
