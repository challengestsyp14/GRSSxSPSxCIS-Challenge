// @vitest-environment node
import { describe, expect, it } from 'vitest';

import * as copy from '../src/sim/copy';
import { Engine } from '../src/sim/engine';
import { DEFAULT_PLAN, loadFlight, readFlightPlan } from '../src/sim/fleet';
import { MASK_ELEVATION_DEG, REFERENCE_PROFILE } from '../src/sim/geometry';
import * as link from '../src/sim/linkDetector';
import { LIVE_NORAD_ID } from '../src/sim/orbit';
import { SNAPSHOT, currentOrNextPass, passSignals, testbedHref } from '../src/sim/signalDb';

const SENTINEL_1A = 39634;
const SNAPSHOT_MS = Date.parse(SNAPSHOT.fetchedUtc);
const unreachable = (async () => {
  throw new TypeError('Failed to fetch');
}) as typeof fetch;

describe('the flight plan in the page URL', () => {
  it('flies TerraSAR-X unless the URL names another satellite', () => {
    expect(readFlightPlan('')).toEqual(DEFAULT_PLAN);
    expect(DEFAULT_PLAN).toEqual({ noradId: LIVE_NORAD_ID, fromMs: null });
    expect(readFlightPlan('?sat=39634')).toEqual({ noradId: SENTINEL_1A, fromMs: null });
    expect(readFlightPlan('?sat=39634&from=1793000000000')).toEqual({
      noradId: SENTINEL_1A,
      fromMs: 1793000000000,
    });
    for (const bad of ['?sat=abc', '?sat=-4', '?sat=1.5', '?sat=99999999', '?sat=']) {
      expect(readFlightPlan(bad).noradId).toBe(LIVE_NORAD_ID);
    }
    expect(readFlightPlan('?sat=39634&from=soon').fromMs).toBeNull();
  });

  it('links every pass of the signal database to the testbed, a minute before it rises', () => {
    const sat = SNAPSHOT.satellites.find((s) => s.noradId === SENTINEL_1A)!;
    const passes = passSignals(sat, SNAPSHOT_MS, SNAPSHOT_MS + 24 * 3_600_000);
    const href = testbedHref(passes[0]);
    expect(href).toBe(`/?sat=${SENTINEL_1A}&from=${Math.round(passes[0].aosMs - 60_000)}`);
    expect(readFlightPlan(href.slice(1))).toEqual({
      noradId: SENTINEL_1A,
      fromMs: Math.round(passes[0].aosMs - 60_000),
    });
    const during = (passes[1].aosMs + passes[1].losMs) / 2;
    expect(currentOrNextPass(passes, SENTINEL_1A, during)).toBe(passes[1]);
    expect(currentOrNextPass(passes, SENTINEL_1A, passes[1].losMs + 1)).toBe(passes[2]);
    expect(currentOrNextPass(passes, 1, during)).toBeNull();
  });
});

describe('flying the fleet', () => {
  it("flies a database satellite's next high pass from the offline catalogue", async () => {
    const p = await loadFlight({ noradId: SENTINEL_1A, fromMs: null }, SNAPSHOT_MS, unreachable);
    expect(p.noradId).toBe(SENTINEL_1A);
    expect(p.source).toBe('builtin');
    expect(p.aosMs).toBeGreaterThan(SNAPSHOT_MS);
    expect(p.maxElevationDeg).toBeGreaterThanOrEqual(10);
    expect(p.inclinationDeg).toBeCloseTo(98.16, 1);
    expect(p.altitudeKm).toBeGreaterThan(650);
    expect(p.altitudeKm).toBeLessThan(720);
  });

  it('flies the exact pass a Signals row links to, however low', async () => {
    const sat = SNAPSHOT.satellites.find((s) => s.noradId === SENTINEL_1A)!;
    const passes = passSignals(sat, SNAPSHOT_MS, SNAPSHOT_MS + 24 * 3_600_000);
    const low = passes.reduce((a, b) => (b.maxElevationDeg < a.maxElevationDeg ? b : a));
    const plan = readFlightPlan(testbedHref(low).slice(1));
    const p = await loadFlight(plan, SNAPSHOT_MS, unreachable);
    // The testbed rises at the horizon, the database row once the satellite clears the mask.
    expect(low.aosMs - p.aosMs!).toBeGreaterThanOrEqual(0);
    expect(low.aosMs - p.aosMs!).toBeLessThan(120_000);
    expect(p.maxElevationDeg).toBeCloseTo(low.maxElevationDeg, 0);
    expect(p.maxElevationDeg).toBeGreaterThanOrEqual(MASK_ELEVATION_DEG);
  });

  it('falls back to TerraSAR-X for a satellite the database does not hold', async () => {
    const p = await loadFlight({ noradId: 1, fromMs: null }, SNAPSHOT_MS, unreachable);
    expect([LIVE_NORAD_ID, REFERENCE_PROFILE.noradId]).toContain(p.noradId);
  });

  it('gives every satellite its own identity and hardware token', () => {
    expect(link.satelliteIdFor('TERRASAR-X')).toBe('TERRASAR-X');
    expect(link.satelliteIdFor('Sentinel-2A')).toBe('SENTINEL-2A');
    expect(link.satelliteIdFor('NOAA 20 (JPSS-1)')).toBe('NOAA-20');
    expect(link.tokenFor(LIVE_NORAD_ID)).toBe('0x4FE2');
    const tokens = SNAPSHOT.satellites.map((s) => link.tokenFor(s.noradId));
    expect(tokens.every((t) => /^0x[0-9A-F]{4}$/.test(t))).toBe(true);
    expect(tokens).not.toContain(copy.ROGUE_NODE);
    expect(new Set(tokens).size).toBeGreaterThan(SNAPSHOT.satellites.length - 3);
  });

  it('starts the testbed on another satellite, under its own name', async () => {
    const engine = await Engine.create({ noradId: SENTINEL_1A, fromMs: null });
    expect(copy.SATELLITE).toBe('SENTINEL-1A');
    expect(link.SAT_ID).toBe('SENTINEL-1A');
    expect(link.SAT_TOKEN).toBe(link.tokenFor(SENTINEL_1A));
    // The element set flown is recorded by its SHA-256, with its epoch age.
    expect(engine.elementSetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(engine.terminal.some((l) => l.text.startsWith('orbit: element set sha256 '))).toBe(true);
    for (let i = 0; i < 60; i++) {
      engine.step();
      await engine.settle();
    }
    expect(engine.framesVerified).toBeGreaterThan(5);
    expect(engine.framesRejected).toBe(0);
    expect(engine.uplink.length).toBeGreaterThan(0);
    expect(engine.uplink.every((r) => r.verdict === 'EXECUTED')).toBe(true);
  });
});
