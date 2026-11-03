import { useEffect, useMemo, useRef, useState } from 'react';

import { SATELLITE } from '../sim/copy';
import { passProfile } from '../sim/geometry';
import { MIN_PEAK_ELEVATION_DEG } from '../sim/orbit';
import {
  HORIZON_HOURS,
  buildSignalDb,
  currentOrNextPass,
  loadCatalog,
  testbedHref,
  type Catalog,
  type PassSignal,
} from '../sim/signalDb';
import { CloseIcon, SatelliteIcon } from './icons';
import { useSkyNow } from './skyNow';
import { SkyView } from './SkyView';
import { useNow } from './useNow';

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** Loaded once, when the picker first opens. */
let fleet: Promise<{ catalog: Catalog; signals: PassSignal[] }> | null = null;
function loadFleet() {
  fleet ??= loadCatalog().then(async (catalog) => ({
    catalog,
    signals: await buildSignalDb(catalog, Date.now(), HORIZON_HOURS),
  }));
  return fleet;
}

/** The satellite button: the whole database, the sky right now, one click to switch to one. */
export function FleetPicker() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ catalog: Catalog; signals: PassSignal[] } | null>(null);
  const [query, setQuery] = useState('');
  const now = useNow(open ? 1000 : 60_000);
  const flying = passProfile().noradId;
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // Build the database in the background once the testbed is running, so the list is ready.
  useEffect(() => {
    const id = window.setTimeout(() => void loadFleet(), 5000);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!open || data) return;
    let alive = true;
    void loadFleet().then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, [open, data]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  const sky = useSkyNow(open ? (data?.catalog.satellites ?? []) : [], now);
  const inView = useMemo(() => new Map(sky.map((p) => [p.sat.noradId, p.now])), [sky]);

  // One row per satellite: in view first (highest first), then by its next good pass.
  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.catalog.satellites
      .filter((s) => !q || s.name.toLowerCase().includes(q) || String(s.noradId).includes(q))
      .map((sat) => {
        const own = data.signals.filter((p) => p.noradId === sat.noradId && p.losMs > now);
        const pass =
          own.find((p) => p.aosMs <= now) ??
          own.find((p) => p.maxElevationDeg >= MIN_PEAK_ELEVATION_DEG) ??
          own[0] ??
          null;
        return { sat, pass, live: inView.get(sat.noradId) ?? null };
      })
      .sort((a, b) => {
        if (a.live || b.live) return (b.live?.elevationDeg ?? -99) - (a.live?.elevationDeg ?? -99);
        return (a.pass?.aosMs ?? Infinity) - (b.pass?.aosMs ?? Infinity);
      });
  }, [data, query, now, inView]);

  const fly = (noradId: number) => {
    const pass = data ? currentOrNextPass(data.signals, noradId, now) : null;
    // The testbed runs in a frame under the shared top bar: navigate the whole page.
    (window.top ?? window).location.assign(pass ? testbedHref(pass) : `/?sat=${noradId}`);
  };

  return (
    <div className="fleet-wrap">
      <button
        ref={button}
        type="button"
        className={`fleet__btn ${open ? 'is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        aria-label={`Satellite flown: ${SATELLITE}, NORAD ${flying}. Change satellite`}
        title="Change satellite: fly any Earth-observation satellite of the CelesTrak database"
      >
        <SatelliteIcon size={15} />
        <span className="fleet__name">{SATELLITE}</span>
        <span className="fleet__norad mono">NORAD {flying}</span>
        <span className="fleet__cta">
          Change satellite
          <span className="fleet__caret" aria-hidden="true">
            ▾
          </span>
        </span>
      </button>
      {open && (
        <div ref={panel} className="fleet" role="dialog" aria-label="Change satellite">
          <div className="fleet__head">
            <div>
              <div className="fleet__title">Change satellite</div>
              <div className="fleet__sub">
                {data
                  ? `Pick any of ${data.catalog.satellites.length} Earth-observation satellites from CelesTrak (${sky.length} above Zaghouan now): the testbed switches to it and flies its next pass.`
                  : 'Loading the signal database…'}
              </div>
            </div>
            <button
              type="button"
              className="drawer__close"
              onClick={() => setOpen(false)}
              aria-label="Close the fleet"
            >
              <CloseIcon size={16} />
            </button>
          </div>
          <div className="fleet__body">
            <div className="fleet__sky">
              <SkyView points={sky} selected={flying} onPick={fly} />
              <p className="sky__legend">
                Live sky over Zaghouan. Click a satellite here, or a row of the list, to switch the
                testbed to it.
              </p>
            </div>
            <div className="fleet__list-wrap">
              <input
                type="search"
                className="fleet__search"
                placeholder="Satellite or NORAD number"
                aria-label="Filter satellites"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <ul className="fleet__list">
                {!data && <li className="fleet__empty">Propagating every orbit with SGP4…</li>}
                {rows.map(({ sat, pass, live }) => (
                  <li key={sat.noradId}>
                    <button
                      type="button"
                      className={`fleet__row ${sat.noradId === flying ? 'is-on' : ''}`}
                      onClick={() => fly(sat.noradId)}
                    >
                      <span className="fleet__row-name">
                        {sat.name}
                        {sat.noradId === flying && <span className="sigdb__tag">flying now</span>}
                      </span>
                      <span className={`mono fleet__row-when ${live ? 'is-live' : ''}`}>
                        {live
                          ? `in view · ${live.elevationDeg.toFixed(1)}°`
                          : pass
                            ? `rises ${hhmm(pass.aosMs)} · ${pass.maxElevationDeg.toFixed(0)}°`
                            : `no pass in ${HORIZON_HOURS} h`}
                      </span>
                      {sat.noradId !== flying && (
                        <span className="fleet__row-go" aria-hidden="true">
                          Switch to it →
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
