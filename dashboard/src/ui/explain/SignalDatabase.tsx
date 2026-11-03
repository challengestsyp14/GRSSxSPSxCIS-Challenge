import { useEffect, useMemo, useState } from 'react';

import { CARRIER_HZ, MASK_ELEVATION_DEG, UPLINK } from '../../sim/geometry';
import { MIN_PEAK_ELEVATION_DEG } from '../../sim/orbit';
import {
  HORIZON_HOURS,
  buildSignalDb,
  liveSample,
  loadCatalog,
  currentOrNextPass,
  signalCurve,
  testbedHref,
  type Catalog,
  type CatalogSatellite,
  type PassSignal,
  type SignalSample,
} from '../../sim/signalDb';
import { MINUS } from '../format';
import { SkyView } from '../SkyView';
import { useSkyNow, type SkyPoint } from '../skyNow';
import { useNow, useTween } from '../useNow';
import { SignalFacts } from './SignalFacts';

const PEAK_FILTERS = [MASK_ELEVATION_DEG, MIN_PEAK_ELEVATION_DEG, 30] as const;
/** The database is rebuilt in the background when it is older than this. */
const REBUILD_MS = 30 * 60_000;

const utc = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const sameUtcDay = (a: number, b: number) =>
  new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
const weekday = (ms: number) =>
  new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const dbm = (v: number) => `${v < 0 ? MINUS : ''}${Math.abs(v).toFixed(1)}`;
const kHz = (hz: number, digits = 1) => {
  const v = hz / 1e3;
  const r = Number(v.toFixed(digits));
  return `${r < 0 ? MINUS : r > 0 ? '+' : ''}${Math.abs(r).toFixed(digits)}`;
};

/** "in 4:07", "in 1 h 12", "4:07 left": how long until, or how long still. */
function countdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600)
    return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function sourceLine(c: Catalog): string {
  const at = new Date(c.fetchedUtc);
  const when = `${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}, ${utc(at.getTime())} UTC`;
  switch (c.source) {
    case 'celestrak':
      return `Live from CelesTrak · downloaded ${when}`;
    case 'cache':
      return `CelesTrak unreachable · last download kept in this browser, ${when}`;
    case 'snapshot':
      return `CelesTrak unreachable · snapshot of CelesTrak built into the site, ${when}`;
  }
}

/** The pass the testbed replays: TerraSAR-X's next one above 10°, else the next in the list. */
function defaultPick(signals: PassSignal[], now: number): PassSignal | null {
  const ahead = signals.filter((s) => s.losMs > now);
  return (
    ahead.find((s) => s.testbed && s.maxElevationDeg >= MIN_PEAK_ELEVATION_DEG) ??
    ahead.find((s) => s.maxElevationDeg >= MIN_PEAK_ELEVATION_DEG) ??
    ahead[0] ??
    null
  );
}

// ---------------------------------------------------------------- live readouts

function LiveTile({
  label,
  value,
  digits,
  unit,
  signed = false,
  tone,
}: {
  label: string;
  value: number | null;
  digits: number;
  unit: string;
  signed?: boolean;
  tone?: 'down' | 'up';
}) {
  const v = useTween(value ?? Number.NaN, 700);
  const text =
    value === null || !Number.isFinite(v)
      ? '—'
      : `${v < 0 ? MINUS : signed && v > 0 ? '+' : ''}${Math.abs(v).toFixed(digits)}`;
  return (
    <div className={`livetile ${tone ? `livetile--${tone}` : ''}`}>
      <span className="livetile__label">{label}</span>
      <span className="livetile__value mono">
        {text}
        {value !== null && <span className="livetile__unit"> {unit}</span>}
      </span>
    </div>
  );
}

function LiveReadout({
  sig,
  live,
  now,
}: {
  sig: PassSignal;
  live: SignalSample | null;
  now: number;
}) {
  const inPass = now >= sig.aosMs && now <= sig.losMs && live !== null;
  const status = inPass
    ? `In view · ${countdown(sig.losMs - now)} left`
    : now < sig.aosMs
      ? `Rises in ${countdown(sig.aosMs - now)}`
      : 'Pass over';
  const s = inPass ? live : null;
  return (
    <div className="livebar" aria-live="off">
      <div className={`livebar__status ${inPass ? 'is-live' : ''}`}>
        <span className="livebar__dot" aria-hidden="true" />
        <span>{status}</span>
        <span className="livebar__clock mono">{clock(now)} UTC</span>
      </div>
      <div className="livebar__tiles">
        <LiveTile label="Elevation" value={s ? s.elevationDeg : null} digits={2} unit="°" />
        <LiveTile label="Slant range" value={s ? s.rangeKm : null} digits={1} unit="km" />
        <LiveTile
          label="Downlink Doppler"
          value={s ? s.dopplerHz / 1e3 : null}
          digits={2}
          unit="kHz"
          signed
          tone="down"
        />
        <LiveTile
          label="Received at Zaghouan"
          value={s ? s.rxDbm : null}
          digits={2}
          unit="dBm"
          tone="down"
        />
        <LiveTile
          label="Uplink Doppler"
          value={s ? s.uplinkDopplerHz / 1e3 : null}
          digits={2}
          unit="kHz"
          signed
          tone="up"
        />
        <LiveTile
          label="Received on board"
          value={s ? s.uplinkRxDbm : null}
          digits={2}
          unit="dBm"
          tone="up"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the selected pass, over time

const CW = 360;
const CH = 178;
const PAD = { l: 52, r: 12, t: 34, b: 28 };

interface Line {
  name: string;
  tone: 'down' | 'up' | 'plain';
  value: (s: SignalSample) => number;
}

interface Track {
  label: string;
  unit: string;
  lines: Line[];
  fmt: (v: number) => string;
}

const signedInt = (v: number) => {
  const r = Math.round(v);
  return r === 0 ? '0' : `${r < 0 ? MINUS : '+'}${Math.abs(r)}`;
};

const TRACKS: Track[] = [
  {
    label: 'Elevation',
    unit: '°',
    lines: [{ name: 'elevation', tone: 'plain', value: (s) => s.elevationDeg }],
    fmt: (v) => v.toFixed(0),
  },
  {
    label: 'Doppler',
    unit: 'kHz',
    lines: [
      { name: 'downlink', tone: 'down', value: (s) => s.dopplerHz / 1e3 },
      { name: 'uplink', tone: 'up', value: (s) => s.uplinkDopplerHz / 1e3 },
    ],
    fmt: signedInt,
  },
  {
    label: 'Received power',
    unit: 'dBm',
    lines: [
      { name: 'at Zaghouan', tone: 'down', value: (s) => s.rxDbm },
      { name: 'on board', tone: 'up', value: (s) => s.uplinkRxDbm },
    ],
    fmt: (v) => dbm(v),
  },
];

/** One quantity of the selected pass against time, horizon to horizon, with a moving "now". */
function TrackChart({
  track,
  samples,
  sig,
  now,
}: {
  track: Track;
  samples: SignalSample[];
  sig: PassSignal;
  now: number;
}) {
  const values = samples.flatMap((s) => track.lines.map((l) => l.value(s)));
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 1e-6) hi = lo + 1;
  const top = hi;
  const bottom = lo;
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const W = CW - PAD.l - PAD.r;
  const H = CH - PAD.t - PAD.b;
  const x = (t: number) => PAD.l + ((t - sig.aosMs) / (sig.losMs - sig.aosMs)) * W;
  const y = (v: number) => PAD.t + H - ((v - lo) / (hi - lo)) * H;
  const mid = sig.aosMs + (sig.losMs - sig.aosMs) / 2;
  const inPass = now >= sig.aosMs && now <= sig.losMs;
  const k = inPass
    ? Math.min(
        samples.length - 1,
        Math.max(
          0,
          Math.round(((now - sig.aosMs) / (sig.losMs - sig.aosMs)) * (samples.length - 1)),
        ),
      )
    : -1;
  return (
    <svg
      viewBox={`0 0 ${CW} ${CH}`}
      role="img"
      aria-label={`${track.label} in ${track.unit}, between ${track.fmt(bottom)} and ${track.fmt(top)}`}
    >
      <text x={PAD.l} y={18} className="fig-label">
        {track.label} ({track.unit})
      </text>
      {track.lines.length > 1 &&
        track.lines.map((l, i) => (
          <text
            key={l.name}
            x={CW - PAD.r}
            y={12 + i * 14}
            textAnchor="end"
            className={`sigdb__legend sigdb__legend--${l.tone}`}
          >
            {l.tone === 'down' ? '↓ ' : '↑ '}
            {l.name}
          </text>
        ))}
      {[top, (top + bottom) / 2, bottom].map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={CW - PAD.r} y1={y(v)} y2={y(v)} className="fig-grid" />
          <text x={PAD.l - 7} y={y(v) + 4} textAnchor="end" className="fig-tick">
            {track.fmt(v)}
          </text>
        </g>
      ))}
      {track.lines.map((l) => (
        <path
          key={l.name}
          d={samples
            .map((s, i) => `${i ? 'L' : 'M'}${x(s.tMs).toFixed(1)},${y(l.value(s)).toFixed(1)}`)
            .join('')}
          pathLength={1}
          className={`sigdb__line sigdb__line--${l.tone}`}
        />
      ))}
      {k >= 0 && (
        <g className="sigdb__now">
          <line x1={x(now)} x2={x(now)} y1={PAD.t - 4} y2={PAD.t + H} />
          {track.lines.map((l) => (
            <circle
              key={l.name}
              cx={x(now)}
              cy={y(l.value(samples[k]))}
              r={4}
              className={`sigdb__now-dot sigdb__now-dot--${l.tone}`}
            />
          ))}
        </g>
      )}
      <text x={PAD.l} y={CH - 6} className="fig-tick">
        {clock(sig.aosMs)}
      </text>
      <text x={x(mid)} y={CH - 6} textAnchor="middle" className="fig-tick">
        {clock(mid)}
      </text>
      <text x={CW - PAD.r} y={CH - 6} textAnchor="end" className="fig-tick">
        {clock(sig.losMs)}
      </text>
    </svg>
  );
}

function SignalCurves({
  sig,
  samples,
  now,
}: {
  sig: PassSignal;
  samples: SignalSample[];
  now: number;
}) {
  return (
    <figure className="figure sigdb__curves">
      <figcaption className="figure__title">
        {sig.name} over Zaghouan, {utc(sig.aosMs)} → {utc(sig.losMs)} UTC: both links second by
        second, ↓ downlink at {CARRIER_HZ / 1e6} MHz, ↑ uplink at {UPLINK.carrierHz / 1e6} MHz
      </figcaption>
      <div className="sigdb__tracks">
        {TRACKS.map((track) => (
          <TrackChart key={track.label} track={track} samples={samples} sig={sig} now={now} />
        ))}
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------- what is up right now

function InView({
  points,
  selected,
  onPick,
}: {
  points: SkyPoint[];
  selected: number | null;
  onPick: (noradId: number) => void;
}) {
  return (
    <div className="inview">
      <div className="inview__head">
        <span className="overline">Above Zaghouan now</span>
        <span className="mono inview__count">{points.length}</span>
      </div>
      {points.length === 0 ? (
        <p className="inview__empty">No satellite of the database is above the horizon.</p>
      ) : (
        <ul className="inview__list">
          {points.map(({ sat, now }) => (
            <li key={sat.noradId}>
              <button
                type="button"
                className={`inview__row ${sat.noradId === selected ? 'is-on' : ''}`}
                onClick={() => onPick(sat.noradId)}
              >
                <span className="inview__name">{sat.name}</span>
                <span className="mono inview__el">
                  {now.rangeRateKmS < 0 ? '▲' : '▼'} {now.elevationDeg.toFixed(1)}°
                </span>
                <span className="mono inview__down">↓ {kHz(now.dopplerHz, 1)} kHz</span>
                <span className="mono inview__up">↑ {kHz(now.uplinkDopplerHz, 1)} kHz</span>
                <span className="mono inview__rx">{dbm(now.rxDbm)} dBm</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the database

export function SignalDatabase() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [signals, setSignals] = useState<PassSignal[] | null>(null);
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [builtAt, setBuiltAt] = useState(0);
  const [minPeak, setMinPeak] = useState<number>(MIN_PEAK_ELEVATION_DEG);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const c = await loadCatalog();
      if (!alive) return;
      setCatalog(c);
      const t = Date.now();
      const db = await buildSignalDb(c, t, HORIZON_HOURS, (done, total) => {
        if (alive) setProgress([done, total]);
      });
      if (!alive) return;
      setBuiltAt(t);
      setSignals(db);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Keep the 12-hour window rolling: rebuild in the background every half hour.
  const stale = signals !== null && now - builtAt > REBUILD_MS;
  useEffect(() => {
    if (!stale || !catalog) return;
    let alive = true;
    const t = Date.now();
    void buildSignalDb(catalog, t, HORIZON_HOURS).then((db) => {
      if (!alive) return;
      setBuiltAt(t);
      setSignals(db);
    });
    return () => {
      alive = false;
    };
  }, [stale, catalog]);

  const sky = useSkyNow(catalog?.satellites ?? [], now);
  const liveByNorad = useMemo(() => new Map(sky.map((p) => [p.sat.noradId, p.now])), [sky]);

  const q = query.trim().toLowerCase();
  const ahead = (signals ?? []).filter((s) => s.losMs > now);
  const rows = ahead.filter(
    (s) =>
      s.maxElevationDeg >= minPeak &&
      (!q || s.name.toLowerCase().includes(q) || String(s.noradId).includes(q)),
  );
  const chosen = picked ? signals?.find((s) => s.id === picked) : null;
  const selected =
    (chosen && chosen.losMs > now ? chosen : null) ??
    (chosen && signals ? currentOrNextPass(signals, chosen.noradId, now) : null) ??
    (signals ? defaultPick(signals, now) : null);
  const sat: CatalogSatellite | undefined =
    (selected && catalog?.satellites.find((s) => s.noradId === selected.noradId)) || undefined;
  const satellites = new Set(rows.map((s) => s.noradId)).size;

  const samples = useMemo(
    () => (sat && selected ? signalCurve(sat, selected.aosMs, selected.losMs, 2) : []),
    [sat, selected?.aosMs, selected?.losMs], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const live = sat && selected ? (liveByNorad.get(sat.noradId) ?? liveSample(sat, now)) : null;

  const pickSatellite = (noradId: number) => {
    const pass = signals ? currentOrNextPass(signals, noradId, now) : null;
    if (pass) setPicked(pass.id);
  };

  return (
    <div className="sigdb">
      <div className="sigdb__status" role="status">
        <span
          className={`sigdb__dot ${catalog?.source === 'celestrak' ? 'is-live' : catalog ? 'is-offline' : ''}`}
          aria-hidden="true"
        />
        {catalog ? (
          <span>
            {sourceLine(catalog)} · {catalog.satellites.length} Earth-observation satellites
            {signals
              ? ` · ${ahead.length} passes over Zaghouan in the next ${HORIZON_HOURS} h`
              : ` · propagating ${progress[0]}/${progress[1] || catalog.satellites.length} with SGP4…`}
          </span>
        ) : (
          <span>Loading the element sets from CelesTrak…</span>
        )}
        <span className="sigdb__clock mono">{clock(now)} UTC</span>
      </div>

      <section className="sigdb__sky" aria-label="The sky over Zaghouan, live">
        <figure className="figure sigdb__skyfig">
          <figcaption className="figure__title">
            The sky over Zaghouan, live: every satellite of the database above the horizon
          </figcaption>
          <SkyView
            points={sky}
            selected={selected?.noradId ?? null}
            track={samples}
            onPick={pickSatellite}
          />
          <p className="sky__legend">
            Zenith in the centre, horizon on the rim, north up. The inner dashed ring is 10°. The
            highlighted path is the selected pass.
          </p>
        </figure>
        <InView points={sky} selected={selected?.noradId ?? null} onPick={pickSatellite} />
      </section>

      <section className="sigdb__table-wrap" aria-label="Signal database">
        <div className="sigdb__bar">
          <label className="sigdb__search">
            <span className="sr-only">Filter by satellite name or NORAD number</span>
            <input
              type="search"
              placeholder="Satellite or NORAD number"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="seg" role="group" aria-label="Lowest culmination">
            {PEAK_FILTERS.map((el) => (
              <button
                key={el}
                type="button"
                className={`seg__btn ${minPeak === el ? 'seg__btn--on' : ''}`}
                aria-pressed={minPeak === el}
                onClick={() => setMinPeak(el)}
              >
                ≥ {el}°
              </button>
            ))}
          </div>
          <span className="sigdb__count mono" key={`${rows.length}`}>
            {signals ? `${rows.length} signals · ${satellites} satellites` : '…'}
          </span>
        </div>
        <div className="sigdb__scroll">
          <table className="sigdb__table">
            <thead>
              <tr>
                <th scope="col">Satellite</th>
                <th scope="col">Now</th>
                <th scope="col">Rises (UTC)</th>
                <th scope="col">Max el.</th>
                <th scope="col">Above mask</th>
                <th scope="col">Doppler ↓ / ↑</th>
                <th scope="col">Received power</th>
                <th scope="col">SNR</th>
              </tr>
            </thead>
            <tbody key={`${minPeak}|${q}`}>
              {signals === null && (
                <tr>
                  <td colSpan={8} className="sigdb__empty">
                    Computing every pass over Zaghouan…
                  </td>
                </tr>
              )}
              {signals !== null && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="sigdb__empty">
                    No pass matches this filter in the next {HORIZON_HOURS} h.
                  </td>
                </tr>
              )}
              {rows.map((s, i) => {
                const on = selected?.id === s.id;
                const down = Math.max(Math.abs(s.dopplerHz.min), Math.abs(s.dopplerHz.max));
                const up = Math.max(
                  Math.abs(s.uplinkDopplerHz.min),
                  Math.abs(s.uplinkDopplerHz.max),
                );
                const inPass = s.aosMs <= now;
                const liveEl = inPass ? liveByNorad.get(s.noradId)?.elevationDeg : undefined;
                return (
                  <tr
                    key={s.id}
                    className={`sigdb__row ${on ? 'is-on' : ''} ${inPass ? 'is-live' : ''}`}
                    aria-selected={on}
                    style={{ ['--i' as string]: Math.min(i, 24) }}
                  >
                    <th scope="row">
                      <button type="button" onClick={() => setPicked(s.id)}>
                        {s.name}
                        {s.testbed && <span className="sigdb__tag">testbed</span>}
                      </button>
                    </th>
                    <td className="mono sigdb__nowcell">
                      {inPass ? (
                        <span className="sigdb__inpass">
                          <span className="sigdb__pulse" aria-hidden="true" />
                          {liveEl !== undefined ? `${liveEl.toFixed(1)}°` : 'in view'}
                        </span>
                      ) : (
                        <span className="sigdb__soon">in {countdown(s.aosMs - now)}</span>
                      )}
                    </td>
                    <td className="mono">
                      {sameUtcDay(s.aosMs, now) ? '' : `${weekday(s.aosMs)} `}
                      {utc(s.aosMs)}
                    </td>
                    <td className="mono">{s.maxElevationDeg.toFixed(1)}°</td>
                    <td className="mono">{((s.losMs - s.aosMs) / 60_000).toFixed(1)} min</td>
                    <td className="mono">
                      ±{(down / 1e3).toFixed(0)} / ±{(up / 1e3).toFixed(0)} kHz
                    </td>
                    <td className="mono">
                      {dbm(s.rxDbm.min)} → {dbm(s.rxDbm.max)} dBm
                    </td>
                    <td className="mono">
                      {s.snrDb.min.toFixed(1)} → {s.snrDb.max.toFixed(1)} dB
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="sigdb__note">
          Orbits are CelesTrak’s latest element sets, propagated with SGP4. Every pass carries two
          signals: the X-band downlink the station receives (8477.8 MHz) and the S-band telecommand
          uplink the satellite receives ({UPLINK.carrierHz / 1e6} MHz). CelesTrak publishes orbits,
          not radios, so every satellite uses the station’s channels and the same link budgets and
          ITU-R P.618 atmosphere: the signals differ by their geometry, which is what the physical
          layer checks. The testbed’s default pass is marked{' '}
          <span className="sigdb__tag">testbed</span>; any pass can be flown on it.
        </p>
      </section>

      {selected && sat && (
        <section
          className="sigdb__detail"
          aria-label={`Signal of ${selected.name}`}
          key={selected.id}
        >
          <div className="sigdb__detail-head">
            <h2 className="sigdb__detail-title">
              {selected.name}
              <span className="sigdb__detail-sub mono">
                NORAD {selected.noradId} · {utc(selected.aosMs)} → {utc(selected.losMs)} UTC ·
                culminates at {selected.maxElevationDeg.toFixed(1)}°
              </span>
            </h2>
            <a className="explain__cta" href={testbedHref(selected)}>
              Switch the live testbed to this satellite →
            </a>
          </div>
          <LiveReadout sig={selected} live={live} now={now} />
          <SignalCurves sig={selected} samples={samples} now={now} />
          <SignalFacts sig={selected} />
        </section>
      )}
    </div>
  );
}
