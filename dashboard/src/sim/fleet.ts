// The fleet: which satellite of the signal database the live testbed flies.
//
// The page URL names it: /?sat=<NORAD> flies that satellite's next pass that culminates at least
// 10° high, /?sat=<NORAD>&from=<Unix ms> the pass under way at that time (any height above the
// mask). Without either the testbed flies TerraSAR-X, from /api/tle. Other satellites come from
// the signal database's catalogue (/api/catalog, its cache, or its built-in snapshot).

import { MASK_ELEVATION_DEG, REFERENCE_PROFILE, type PassProfile } from './geometry';
import { LIVE_NORAD_ID, loadPassProfile, passProfileFor } from './orbit';
import { loadCatalog, type Catalog } from './signalDb';

export interface FlightPlan {
  noradId: number;
  /** Fly the pass under way at this time instead of the next high one. */
  fromMs: number | null;
}

export const DEFAULT_PLAN: FlightPlan = { noradId: LIVE_NORAD_ID, fromMs: null };

export function readFlightPlan(search: string): FlightPlan {
  const params = new URLSearchParams(search);
  const sat = Number(params.get('sat'));
  const from = Number(params.get('from'));
  return {
    noradId: Number.isInteger(sat) && sat > 0 && sat < 1_000_000 ? sat : LIVE_NORAD_ID,
    fromMs: Number.isFinite(from) && from > 0 ? from : null,
  };
}

const SOURCE: Record<Catalog['source'], 'celestrak' | 'cache' | 'builtin'> = {
  celestrak: 'celestrak',
  cache: 'cache',
  snapshot: 'builtin',
};

/** The pass the testbed replays for `plan`: TerraSAR-X's next one when the satellite is unknown. */
export async function loadFlight(
  plan: FlightPlan,
  nowMs = Date.now(),
  fetcher: typeof fetch | null = typeof fetch === 'function' ? fetch : null,
): Promise<PassProfile> {
  if (plan.noradId === LIVE_NORAD_ID && plan.fromMs === null) {
    return loadPassProfile(nowMs, fetcher);
  }
  const catalog = await loadCatalog(fetcher);
  const sat = catalog.satellites.find((s) => s.noradId === plan.noradId);
  const profile =
    sat &&
    passProfileFor(
      { ...sat, fetchedUtc: catalog.fetchedUtc },
      plan.fromMs ?? nowMs,
      SOURCE[catalog.source],
      plan.fromMs === null ? undefined : MASK_ELEVATION_DEG,
    );
  return profile || (await loadPassProfile(nowMs, fetcher)) || REFERENCE_PROFILE;
}
