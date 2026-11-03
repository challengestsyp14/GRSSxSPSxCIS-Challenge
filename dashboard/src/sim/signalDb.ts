// The signal database: every pass of every satellite in CelesTrak's Earth-resources group over
// Zaghouan in the coming hours, and the signal each one delivers to the station.
//
// /api/catalog relays the latest element sets from CelesTrak, cached two hours at the edge. Each
// is propagated with SGP4 (satellite.js) to its passes over the station; each pass is sampled
// above the 2° elevation mask and put through the testbed's X-band link budget and the digital
// twin's ITU-R P.618 atmosphere. One pass is one signal: when it rises, how high it climbs, how
// far and how fast the satellite moves, hence the Doppler, received power and SNR the station
// sees. CelesTrak publishes orbits, not radios, so every satellite is received on the station's
// channel (8477.8 MHz) with the same link budget: the signals differ by their geometry. When
// /api/catalog fails, the last good download kept in the browser is used, then the snapshot
// built into the site. The signal goes both ways: the X-band downlink the station receives,
// and the S-band telecommand uplink the satellite receives from the station.

import { twoline2satrec, type SatRec } from 'satellite.js';

import snapshot from '../data/catalog-snapshot.json';
import {
  CARRIER_HZ,
  C_KM_S,
  MASK_ELEVATION_DEG,
  NOISE_FLOOR_DBM,
  UPLINK,
  atmosphericLossDb,
  snrPredDb,
  uplinkRxDbm,
} from './geometry';
import { LIVE_NORAD_ID, isValidTle, lookAt, passWindows, tleEpochMs } from './orbit';

export const CATALOG_ENDPOINT = '/api/catalog';
/** How far ahead the database looks for passes. */
export const HORIZON_HOURS = 12;
/** Sampling of each pass for the database rows; a selected pass is sampled every second. */
const SUMMARY_STEP_S = 5;
const FETCH_TIMEOUT_MS = 6000;
const CACHE_KEY = 'groundlink:catalog:resource';
const RX_OHMS = 50;

export interface CatalogSatellite {
  name: string;
  noradId: number;
  line1: string;
  line2: string;
}

export interface Catalog {
  /** `celestrak`: downloaded now; `cache`: the last good download; `snapshot`: built in. */
  source: 'celestrak' | 'cache' | 'snapshot';
  group: string;
  fetchedUtc: string;
  satellites: CatalogSatellite[];
}

export interface Span {
  min: number;
  max: number;
}

export interface SignalSample {
  tMs: number;
  azimuthDeg: number;
  elevationDeg: number;
  rangeKm: number;
  /** Range rate, km/s, positive while the satellite recedes. */
  rangeRateKmS: number;
  /** Downlink, satellite to station. */
  dopplerHz: number;
  atmosphereDb: number;
  rxDbm: number;
  snrDb: number;
  /** Uplink, station to satellite: Doppler and power seen on board. */
  uplinkDopplerHz: number;
  uplinkRxDbm: number;
}

/** One pass, one signal: what the station receives while the satellite is above the mask. */
export interface PassSignal {
  id: string;
  name: string;
  noradId: number;
  /** The satellite the live testbed flies. */
  testbed: boolean;
  /** Mask crossings: the link is up between them. */
  aosMs: number;
  losMs: number;
  maxElevationDeg: number;
  culminationAzDeg: number;
  altitudeKm: number;
  tleEpochMs: number;
  rangeKm: Span;
  dopplerHz: Span;
  atmosphereDb: Span;
  rxDbm: Span;
  snrDb: Span;
  amplitudeUv: Span;
  uplinkDopplerHz: Span;
  uplinkRxDbm: Span;
}

/** Peak voltage (µV) of a sine carrier of `dbm` across the 50 Ω receiver input. */
const peakUv = (dbm: number) => Math.sqrt(2 * 10 ** (dbm / 10) * 1e-3 * RX_OHMS) * 1e6;

const span = (values: number[]): Span => ({
  min: Math.min(...values),
  max: Math.max(...values),
});

export const isValidSatellite = (s: Partial<CatalogSatellite> | null): s is CatalogSatellite =>
  !!s &&
  typeof s.name === 'string' &&
  typeof s.noradId === 'number' &&
  isValidTle({ line1: s.line1, line2: s.line2 }, s.noradId);

function validCatalog(raw: unknown, source: Catalog['source']): Catalog | null {
  const c = raw as Partial<Catalog> | null;
  if (!c || !Array.isArray(c.satellites) || typeof c.fetchedUtc !== 'string') return null;
  const satellites = c.satellites.filter(isValidSatellite);
  if (satellites.length === 0) return null;
  return { source, group: c.group ?? 'resource', fetchedUtc: c.fetchedUtc, satellites };
}

export const SNAPSHOT = validCatalog(snapshot, 'snapshot')!;

function readCache(): Catalog | null {
  try {
    return validCatalog(JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? 'null'), 'cache');
  } catch {
    return null;
  }
}

function writeCache(catalog: Catalog): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(catalog));
  } catch {
    // Storage blocked or full: only the offline fallback is lost.
  }
}

async function download(fetcher: typeof fetch): Promise<Catalog | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(CATALOG_ENDPOINT, { signal: controller.signal });
    if (!response.ok) return null;
    return validCatalog(await response.json(), 'celestrak');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The element sets to use: a fresh download, else the last good one, else the snapshot. */
export async function loadCatalog(
  fetcher: typeof fetch | null = typeof fetch === 'function' ? fetch : null,
): Promise<Catalog> {
  const live = fetcher ? await download(fetcher) : null;
  if (live) {
    writeCache(live);
    return live;
  }
  return readCache() ?? SNAPSHOT;
}

/** Both links at one instant, the Doppler from the range rate over ±0.5 s. */
function sampleAt(satrec: SatRec, tMs: number): SignalSample | null {
  const look = lookAt(satrec, tMs);
  const before = lookAt(satrec, tMs - 500);
  const after = lookAt(satrec, tMs + 500);
  if (!look || !before || !after) return null;
  const rangeRateKmS = after.rangeKm - before.rangeKm;
  const snrDb = snrPredDb(look.rangeKm, look.elDeg);
  return {
    tMs,
    azimuthDeg: look.azDeg,
    elevationDeg: look.elDeg,
    rangeKm: look.rangeKm,
    rangeRateKmS,
    dopplerHz: (-CARRIER_HZ * rangeRateKmS) / C_KM_S,
    atmosphereDb: atmosphericLossDb(look.elDeg),
    rxDbm: NOISE_FLOOR_DBM + snrDb,
    snrDb,
    uplinkDopplerHz: (-UPLINK.carrierHz * rangeRateKmS) / C_KM_S,
    uplinkRxDbm: uplinkRxDbm(look.rangeKm, look.elDeg),
  };
}

/** Where one satellite is and what both links look like right now, or null below the horizon. */
export function liveSample(
  sat: CatalogSatellite,
  tMs: number,
  satrecs = new Map<number, SatRec>(),
): SignalSample | null {
  let satrec = satrecs.get(sat.noradId);
  if (!satrec) {
    satrec = twoline2satrec(sat.line1, sat.line2);
    satrecs.set(sat.noradId, satrec);
  }
  const look = lookAt(satrec, tMs);
  if (!look || look.elDeg < 0) return null;
  return sampleAt(satrec, tMs);
}

/** The signal of one pass, sampled every `stepS` seconds from horizon to horizon. */
export function signalCurve(
  sat: CatalogSatellite,
  fromMs: number,
  toMs: number,
  stepS = 1,
): SignalSample[] {
  const satrec = twoline2satrec(sat.line1, sat.line2);
  const out: SignalSample[] = [];
  const n = Math.max(2, Math.ceil((toMs - fromMs) / (stepS * 1000)));
  for (let i = 0; i <= n; i++) {
    const s = sampleAt(satrec, fromMs + ((toMs - fromMs) * i) / n);
    if (s) out.push(s);
  }
  return out;
}

/** Every pass of one satellite that brings the link up between `fromMs` and `toMs`. */
export function passSignals(sat: CatalogSatellite, fromMs: number, toMs: number): PassSignal[] {
  const satrec = twoline2satrec(sat.line1, sat.line2);
  const out: PassSignal[] = [];
  for (const w of passWindows(satrec, fromMs, toMs)) {
    if (w.peakDeg < MASK_ELEVATION_DEG - 1) continue;
    const step = SUMMARY_STEP_S * 1000;
    const samples: SignalSample[] = [];
    for (let t = w.aosMs; t <= w.losMs; t += step) {
      const s = sampleAt(satrec, t);
      if (s && s.elevationDeg >= MASK_ELEVATION_DEG) samples.push(s);
    }
    if (samples.length < 2) continue;
    const top = samples.reduce((a, b) => (b.elevationDeg > a.elevationDeg ? b : a));
    const look = lookAt(satrec, top.tMs);
    // Height above the ellipsoid at culmination, as the station sees it.
    const altitudeKm = look?.heightKm ?? 0;
    const rx = span(samples.map((s) => s.rxDbm));
    out.push({
      id: `${sat.noradId}-${Math.round(w.aosMs)}`,
      name: sat.name,
      noradId: sat.noradId,
      testbed: sat.noradId === LIVE_NORAD_ID,
      aosMs: samples[0].tMs,
      losMs: samples[samples.length - 1].tMs,
      maxElevationDeg: top.elevationDeg,
      culminationAzDeg: look?.azDeg ?? 0,
      altitudeKm,
      tleEpochMs: tleEpochMs(sat.line1),
      rangeKm: span(samples.map((s) => s.rangeKm)),
      dopplerHz: span(samples.map((s) => s.dopplerHz)),
      atmosphereDb: span(samples.map((s) => s.atmosphereDb)),
      rxDbm: rx,
      snrDb: span(samples.map((s) => s.snrDb)),
      amplitudeUv: { min: peakUv(rx.min), max: peakUv(rx.max) },
      uplinkDopplerHz: span(samples.map((s) => s.uplinkDopplerHz)),
      uplinkRxDbm: span(samples.map((s) => s.uplinkRxDbm)),
    });
  }
  return out;
}

/**
 * The whole database: every satellite's passes in the next `hours`, sorted by rise time.
 * Yields to the page between satellites so it stays responsive; `onProgress` gets the count done.
 */
export async function buildSignalDb(
  catalog: Catalog,
  fromMs = Date.now(),
  hours = HORIZON_HOURS,
  onProgress?: (done: number, total: number) => void,
): Promise<PassSignal[]> {
  const toMs = fromMs + hours * 3_600_000;
  const out: PassSignal[] = [];
  const total = catalog.satellites.length;
  let last = performance.now();
  for (let i = 0; i < total; i++) {
    out.push(...passSignals(catalog.satellites[i], fromMs, toMs));
    if (performance.now() - last > 30) {
      onProgress?.(i + 1, total);
      await new Promise((resolve) => setTimeout(resolve, 0));
      last = performance.now();
    }
  }
  onProgress?.(total, total);
  return out.sort((a, b) => a.aosMs - b.aosMs);
}

/** Link to the live testbed flying this very pass. */
export const testbedHref = (sig: Pick<PassSignal, 'noradId' | 'aosMs'>) =>
  `/?sat=${sig.noradId}&from=${Math.round(sig.aosMs - 60_000)}`;

/** A satellite's pass under way at `nowMs`, else its next one. */
export function currentOrNextPass(
  signals: PassSignal[],
  noradId: number,
  nowMs: number,
): PassSignal | null {
  const own = signals.filter((s) => s.noradId === noradId && s.losMs > nowMs);
  return own.find((s) => s.aosMs <= nowMs) ?? own[0] ?? null;
}
