// Live orbit: the next real pass of a real satellite over Zaghouan.
//
// The site's /api/tle function relays the latest element set (TLE) for TerraSAR-X (NORAD
// 31698) from CelesTrak's public GP service; Vercel's edge caches it for two hours, the
// refresh interval CelesTrak asks its clients to respect. The browser propagates it with SGP4
// (satellite.js), finds the next pass that culminates at least 10° high, and samples its
// elevation, slant range, range rate and Doppler second by second. That pass profile is what
// the testbed replays. The last good download is kept in the browser; when /api/tle cannot be
// reached it flies that, and with none, the TerraSAR-X element set shipped with the site.

import {
  degreesToRadians,
  ecfToLookAngles,
  eciToEcf,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
  type SatRec,
} from 'satellite.js';

import {
  CARRIER_HZ,
  C_KM_S,
  REFERENCE_PROFILE,
  sceneTiltFor,
  type PassProfile,
  type RealGeometry,
} from './geometry';

export const LIVE_NORAD_ID = 31698; // TerraSAR-X: X-band SAR, ~514 km sun-synchronous
export const TLE_ENDPOINT = '/api/tle';
/** Passes lower than this make a poor replay: the next higher one is chosen. */
export const MIN_PEAK_ELEVATION_DEG = 10;
const SEARCH_HOURS = 48;
const COARSE_STEP_S = 30;
const FETCH_TIMEOUT_MS = 4000;
const CACHE_KEY = `groundlink:tle:${LIVE_NORAD_ID}`;

/** TerraSAR-X as CelesTrak served it on 27 Oct 2026 (epoch 26 Oct 11:12 UTC): the offline orbit. */
export const BUILTIN_TLE: TleRecord = {
  name: 'TERRASAR-X',
  noradId: LIVE_NORAD_ID,
  line1: '1 31698U 07026A   26299.46724549 -.00000045  00000+0  10706-5 0  9999',
  line2: '2 31698  97.4456 305.3111 0001816  81.2566 278.8874 15.19151530 73153',
  fetchedUtc: '2026-10-27T20:02:37.594Z',
};

/** Zaghouan ground station (GS-ZAG). */
const STATION = {
  latitude: degreesToRadians(36.4),
  longitude: degreesToRadians(10.14),
  height: 0.18,
};

export interface TleRecord {
  name: string;
  noradId: number;
  line1: string;
  line2: string;
  /** When the element set was downloaded from CelesTrak, ISO 8601. */
  fetchedUtc: string;
}

/** Modulo-10 checksum of a TLE line: digits count their value, minus signs count 1. */
export function tleChecksum(line: string): number {
  let sum = 0;
  for (const c of line.slice(0, 68)) {
    if (c >= '0' && c <= '9') sum += Number(c);
    else if (c === '-') sum += 1;
  }
  return sum % 10;
}

/** A record is usable when both lines are well formed, check out and name `noradId`. */
export function isValidTle(record: Partial<TleRecord> | null, noradId = LIVE_NORAD_ID): boolean {
  if (!record || typeof record.line1 !== 'string' || typeof record.line2 !== 'string') return false;
  const lines: [string, string] = [record.line1, record.line2];
  return lines.every(
    (line, i) =>
      line.length === 69 &&
      line.startsWith(`${i + 1} `) &&
      Number(line[68]) === tleChecksum(line) &&
      Number(line.slice(2, 7)) === noradId,
  );
}

/** Epoch of a TLE line 1 as Unix milliseconds. */
export function tleEpochMs(line1: string): number {
  const yy = Number(line1.slice(18, 20));
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const day = Number(line1.slice(20, 32));
  return Date.UTC(year, 0, 1) + (day - 1) * 86_400_000;
}

export interface Look {
  azDeg: number;
  elDeg: number;
  rangeKm: number;
  /** Geodetic height of the satellite above the WGS-72 ellipsoid, km. */
  heightKm: number;
}

/** Azimuth, elevation and slant range of the satellite from Zaghouan at `ms`. */
export function lookAt(satrec: SatRec, ms: number): Look | null {
  const date = new Date(ms);
  const state = propagate(satrec, date);
  if (!state) return null;
  const gmst = gstime(date);
  const look = ecfToLookAngles(STATION, eciToEcf(state.position, gmst));
  return {
    azDeg: (look.azimuth * 180) / Math.PI,
    elDeg: (look.elevation * 180) / Math.PI,
    rangeKm: look.rangeSat,
    heightKm: eciToGeodetic(state.position, gmst).height,
  };
}

const elevation = (satrec: SatRec, ms: number) => lookAt(satrec, ms)?.elDeg ?? -90;

/** Time of a horizon crossing between t0 (on one side) and t1 (on the other), to 1 ms. */
function crossing(satrec: SatRec, t0: number, t1: number, rising: boolean): number {
  for (let i = 0; i < 30 && t1 - t0 > 1; i++) {
    const mid = (t0 + t1) / 2;
    if (elevation(satrec, mid) >= 0 === rising) t1 = mid;
    else t0 = mid;
  }
  return (t0 + t1) / 2;
}

export interface PassWindow {
  aosMs: number;
  losMs: number;
}

/**
 * Every pass, horizon to horizon, that has not set by `fromMs` and rises before `toMs`, with
 * the highest elevation seen on the coarse search grid. A pass in progress counts.
 */
export function* passWindows(
  satrec: SatRec,
  fromMs: number,
  toMs: number,
): Generator<PassWindow & { peakDeg: number }> {
  const step = COARSE_STEP_S * 1000;
  let t = fromMs - 30 * 60_000;
  let above = elevation(satrec, t) >= 0;
  let rise: number | null = null;
  let peak = -90;
  for (; t < toMs || rise !== null; t += step) {
    if (t > toMs + 3 * 3_600_000) return;
    const el = elevation(satrec, t + step);
    if (!above && el >= 0) {
      if (t > toMs) return;
      rise = crossing(satrec, t, t + step, true);
      peak = el;
    } else if (above && el >= 0) {
      peak = Math.max(peak, el);
    } else if (above && el < 0 && rise !== null) {
      const set = crossing(satrec, t, t + step, false);
      if (set > fromMs) yield { aosMs: rise, losMs: set, peakDeg: peak };
      rise = null;
    }
    above = el >= 0;
  }
}

/**
 * The first pass, horizon to horizon, that has not set by `fromMs` and culminates at least
 * `minPeakDeg` high. A pass in progress counts.
 */
export function findPass(
  satrec: SatRec,
  fromMs: number,
  minPeakDeg = MIN_PEAK_ELEVATION_DEG,
): PassWindow | null {
  for (const w of passWindows(satrec, fromMs, fromMs + SEARCH_HOURS * 3_600_000)) {
    if (w.peakDeg >= minPeakDeg) return { aosMs: w.aosMs, losMs: w.losMs };
  }
  return null;
}

/** Samples a pass once a second and wraps it as the profile the testbed replays. */
export function passProfileFor(
  record: TleRecord,
  fromMs: number,
  source: 'celestrak' | 'cache' | 'builtin',
  minPeakDeg = MIN_PEAK_ELEVATION_DEG,
): PassProfile | null {
  const satrec = twoline2satrec(record.line1, record.line2);
  const window = findPass(satrec, fromMs, minPeakDeg);
  if (!window) return null;
  const duration = (window.losMs - window.aosMs) / 1000;
  const n = Math.max(2, Math.ceil(duration));
  const looks: Look[] = [];
  for (let i = 0; i <= n; i++) {
    const look = lookAt(satrec, window.aosMs + (i / n) * duration * 1000);
    if (!look) return null;
    looks.push(look);
  }
  const dt = duration / n;
  // Range rate by central differences of the sampled slant range; Doppler follows from it.
  const geometry: RealGeometry[] = looks.map((look, i) => {
    const a = looks[Math.max(0, i - 1)];
    const b = looks[Math.min(n, i + 1)];
    const rangeRateKmS = (b.rangeKm - a.rangeKm) / (dt * (Math.min(n, i + 1) - Math.max(0, i - 1)));
    return {
      rangeKm: look.rangeKm,
      elevationDeg: look.elDeg,
      rangeRateKmS,
      dopplerHz: (-CARRIER_HZ * rangeRateKmS) / C_KM_S,
    };
  });

  const k = looks.reduce((best, look, i) => (look.elDeg > looks[best].elDeg ? i : best), 0);
  const horizontal = (look: Look) => {
    const c = Math.cos(degreesToRadians(look.elDeg));
    const az = degreesToRadians(look.azDeg);
    return [c * Math.sin(az), c * Math.cos(az)];
  };
  const [e0, n0] = horizontal(looks[Math.max(0, k - 5)]);
  const [e1, n1] = horizontal(looks[Math.min(n, k + 5)]);
  const trackAzDeg = ((Math.atan2(e1 - e0, n1 - n0) * 180) / Math.PI + 360) % 360;

  return {
    source,
    satName: record.name,
    noradId: record.noradId,
    // Height above the ellipsoid, averaged over the pass: what an observer at Zaghouan sees.
    altitudeKm: looks.reduce((sum, look) => sum + look.heightKm, 0) / looks.length,
    inclinationDeg: (satrec.inclo * 180) / Math.PI,
    realPassS: duration,
    maxElevationDeg: looks[k].elDeg,
    culminationAzDeg: looks[k].azDeg,
    trackAzDeg,
    sceneTiltDeg: sceneTiltFor(looks[k].elDeg),
    aosMs: window.aosMs,
    tleEpochMs: tleEpochMs(record.line1),
    fetchedMs: Date.parse(record.fetchedUtc),
    tleLines: [record.line1, record.line2],
    at(u: number) {
      const x = Math.min(Math.max(u, 0), 1) * n;
      const i = Math.min(Math.floor(x), n - 1);
      const f = x - i;
      const a = geometry[i];
      const b = geometry[i + 1];
      return {
        rangeKm: a.rangeKm + (b.rangeKm - a.rangeKm) * f,
        elevationDeg: a.elevationDeg + (b.elevationDeg - a.elevationDeg) * f,
        rangeRateKmS: a.rangeRateKmS + (b.rangeRateKmS - a.rangeRateKmS) * f,
        dopplerHz: a.dopplerHz + (b.dopplerHz - a.dopplerHz) * f,
      };
    },
  };
}

function readCache(): TleRecord | null {
  try {
    const record = JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? 'null') as TleRecord;
    return isValidTle(record) ? record : null;
  } catch {
    return null;
  }
}

function writeCache(record: TleRecord): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(record));
  } catch {
    // Storage blocked: only the offline fallback is lost.
  }
}

async function download(fetcher: typeof fetch): Promise<TleRecord | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(TLE_ENDPOINT, { signal: controller.signal });
    if (!response.ok) return null;
    const record = (await response.json()) as TleRecord;
    return isValidTle(record) ? record : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The pass to replay: from a fresh download, else the last good one, else the built-in
 * element set (the analytic reference only if no pass can be found). Tests run on the
 * reference pass, with no network.
 */
export async function loadPassProfile(
  nowMs = Date.now(),
  fetcher: typeof fetch | null = typeof fetch === 'function' ? fetch : null,
): Promise<PassProfile> {
  if (import.meta.env.MODE === 'test' && fetcher === fetch) return REFERENCE_PROFILE;
  const live = fetcher ? await download(fetcher) : null;
  if (live) {
    writeCache(live);
    const profile = passProfileFor(live, nowMs, 'celestrak');
    if (profile) return profile;
  }
  const cached = readCache();
  return (
    (cached && passProfileFor(cached, nowMs, 'cache')) ||
    passProfileFor(BUILTIN_TLE, nowMs, 'builtin') ||
    REFERENCE_PROFILE
  );
}
