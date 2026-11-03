import { UPLINK } from '../../sim/geometry';
import { ATTACK_SIGNALS, CHI_SQUARE, NATURAL, SIGNAL, STEALTH } from '../../sim/linkFacts';
import type { PassSignal } from '../../sim/signalDb';
import { MINUS } from '../format';

/** "−88.0" style numbers with a real minus sign. */
const n = (v: number, digits = 1) => `${v < 0 ? MINUS : ''}${Math.abs(v).toFixed(digits)}`;

const CHANNEL = {
  carrierMHz: SIGNAL.carrierMHz,
  noiseFloorDbm: SIGNAL.noiseFloorDbm,
  noiseUvRms: SIGNAL.noiseUvRms,
  modulation: SIGNAL.modulation,
  occupiedMHz: SIGNAL.occupiedMHz,
  framePeriodS: SIGNAL.framePeriodS,
  maskElevationDeg: SIGNAL.maskElevationDeg,
};

const utc = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const day = (ms: number) =>
  new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const kHz = (hz: number) => `${hz < 0 ? MINUS : '+'}${Math.abs(hz / 1e3).toFixed(1)}`;

/** What one pass from the database delivers to the station, row by row. */
function factsFor(sig: PassSignal): { k: string; v: string; note: string }[] {
  const minutes = (sig.losMs - sig.aosMs) / 60_000;
  return [
    {
      k: 'Satellite',
      v: `${sig.name} · NORAD ${sig.noradId}`,
      note: `${Math.round(sig.altitudeKm)} km orbit · CelesTrak element set of ${day(sig.tleEpochMs)}, ${utc(sig.tleEpochMs)} UTC`,
    },
    {
      k: 'Pass over Zaghouan',
      v: `${utc(sig.aosMs)} → ${utc(sig.losMs)} UTC`,
      note: `${day(sig.aosMs)} · ${minutes.toFixed(1)} min above the ${CHANNEL.maskElevationDeg}° mask · culminates at ${sig.maxElevationDeg.toFixed(1)}°, azimuth ${Math.round(sig.culminationAzDeg)}°`,
    },
    {
      k: 'Carrier frequency',
      v: `${CHANNEL.carrierMHz} MHz`,
      note: 'the station’s X-band channel. Not random: only the Doppler shift moves it.',
    },
    {
      k: 'Doppler shift',
      v: `${kHz(sig.dopplerHz.max)} → ${kHz(sig.dopplerHz.min)} kHz`,
      note: 'from the range rate SGP4 gives: up while the satellite approaches, zero at culmination',
    },
    {
      k: 'Slant range',
      v: `${Math.round(sig.rangeKm.max)} → ${Math.round(sig.rangeKm.min)} km`,
      note: `${CHANNEL.maskElevationDeg}° mask → culmination`,
    },
    {
      k: 'Received power',
      v: `${n(sig.rxDbm.min)} → ${n(sig.rxDbm.max)} dBm`,
      note: 'the testbed’s X-band link budget: free-space loss plus the ITU-R P.618 atmosphere',
    },
    {
      k: 'Atmosphere',
      v: `${sig.atmosphereDb.max.toFixed(2)} → ${sig.atmosphereDb.min.toFixed(2)} dB`,
      note: 'ITU-R P.618, median year over Zaghouan: oxygen and water vapour; rain and clouds stay below the median',
    },
    {
      k: 'Carrier amplitude',
      v: `${sig.amplitudeUv.min.toFixed(1)} → ${sig.amplitudeUv.max.toFixed(1)} µV`,
      note: 'peak voltage across the 50 Ω receiver input, A = √(2·P·R)',
    },
    {
      k: 'Noise floor',
      v: `${n(CHANNEL.noiseFloorDbm, 0)} dBm`,
      note: `${CHANNEL.noiseUvRms.toFixed(2)} µV rms of thermal noise in the channel`,
    },
    {
      k: 'Signal-to-noise ratio',
      v: `${sig.snrDb.min.toFixed(1)} → ${sig.snrDb.max.toFixed(1)} dB`,
      note: 'over the pass, from the link budget',
    },
    {
      k: 'Modulation',
      v: `${CHANNEL.modulation} · ${CHANNEL.occupiedMHz} MHz`,
      note: `one HMAC-sealed frame every ${CHANNEL.framePeriodS} s`,
    },
    {
      k: 'Uplink carrier',
      v: `${UPLINK.carrierHz / 1e6} MHz`,
      note: `S-band telecommands from Zaghouan to the satellite: ${UPLINK.eirpDbw} dBW from the station, an omnidirectional antenna on board`,
    },
    {
      k: 'Uplink Doppler',
      v: `${kHz(sig.uplinkDopplerHz.max)} → ${kHz(sig.uplinkDopplerHz.min)} kHz`,
      note: 'what the on-board receiver sees: the same range rate at a quarter of the frequency',
    },
    {
      k: 'Received on board',
      v: `${n(sig.uplinkRxDbm.min)} → ${n(sig.uplinkRxDbm.max)} dBm`,
      note: 'free-space loss at 2 GHz plus the ITU-R P.618 atmosphere at that frequency',
    },
  ];
}

const JITTER: { k: string; natural: string; gate: string }[] = [
  {
    k: 'Carrier vs orbit model',
    natural: `±${NATURAL.carrierHz.max} Hz (σ ${NATURAL.carrierHz.sigma} Hz)`,
    gate: `±${NATURAL.carrierHz.gate.toFixed(0)} Hz`,
  },
  {
    k: 'Power vs link budget',
    natural: `±${NATURAL.powerDb.max.toFixed(1)} dB (σ ${NATURAL.powerDb.sigma} dB)`,
    gate: `±${NATURAL.powerDb.gate.toFixed(1)} dB`,
  },
  {
    k: 'Frame timing (range)',
    natural: `±${NATURAL.timingUs.max} µs (σ ${NATURAL.timingUs.sigma} µs)`,
    gate: `±${NATURAL.timingUs.gate.toFixed(1)} µs`,
  },
  {
    k: 'Carrier phase',
    natural: `±${NATURAL.phaseDeg.max}° (σ ${NATURAL.phaseDeg.sigma}°)`,
    gate: `±${NATURAL.phaseDeg.gate.toFixed(1)}°`,
  },
];

// ---------------------------------------------------------------- level and frequency rulers

const LABEL_W = 236;
const RULER_W = 470;
const ROW = 36;

interface Row {
  label: string;
  /** [from, to] on the ruler's scale; a single value draws a point. */
  span: [number, number];
  tone: 'accent' | 'warn' | 'bad' | 'jam' | 'quiet';
  value: string;
}

function Ruler({
  title,
  min,
  max,
  ticks,
  tick,
  rows,
  marker,
}: {
  title: string;
  min: number;
  max: number;
  ticks: number[];
  tick: (v: number) => string;
  rows: Row[];
  marker?: { at: number; label: string };
}) {
  const x = (v: number) => LABEL_W + ((v - min) / (max - min)) * RULER_W;
  const height = rows.length * ROW + 64;
  const axisY = rows.length * ROW + 20;
  return (
    <figure className="figure">
      <figcaption className="figure__title">{title}</figcaption>
      <svg
        viewBox={`0 0 ${LABEL_W + RULER_W + 24} ${height}`}
        role="img"
        aria-label={`${title}: ${rows.map((r) => `${r.label} ${r.value}`).join('; ')}`}
      >
        {ticks.map((v) => (
          <line key={v} x1={x(v)} x2={x(v)} y1={4} y2={axisY} className="fig-grid" />
        ))}
        {marker && (
          <line x1={x(marker.at)} x2={x(marker.at)} y1={4} y2={axisY} className="fig-marker" />
        )}
        {rows.map((r, i) => {
          const y = i * ROW + 22;
          const [a, b] = r.span;
          return (
            <g key={r.label}>
              <text x={0} y={y + 5} className="fig-label">
                {r.label}
              </text>
              {a === b ? (
                <circle cx={x(a)} cy={y} r={6} className={`fig-dot fig-dot--${r.tone}`} />
              ) : (
                <rect
                  x={x(a)}
                  y={y - 8}
                  width={Math.max(3, x(b) - x(a))}
                  height={16}
                  rx={4}
                  className={`fig-band fig-band--${r.tone}`}
                />
              )}
              <text
                x={a === b ? x(a) + 12 : Math.min(x(b) + 10, LABEL_W + RULER_W + 20)}
                y={y + 5}
                className="fig-value"
                textAnchor={x(b) + 10 > LABEL_W + RULER_W - 120 ? 'end' : 'start'}
                dx={x(b) + 10 > LABEL_W + RULER_W - 120 ? -(x(b) - x(a)) - 20 : 0}
              >
                {r.value}
              </text>
            </g>
          );
        })}
        <line x1={LABEL_W} x2={LABEL_W + RULER_W} y1={axisY} y2={axisY} className="fig-axis" />
        {ticks.map((v) => (
          <text key={v} x={x(v)} y={axisY + 22} textAnchor="middle" className="fig-tick">
            {tick(v)}
          </text>
        ))}
        {marker && (
          <text
            x={x(marker.at)}
            y={axisY + 42}
            textAnchor="middle"
            className="fig-tick fig-tick--marker"
          >
            {marker.label}
          </text>
        )}
      </svg>
    </figure>
  );
}

export function PowerLevels({ sig }: { sig: PassSignal }) {
  const spoof = ATTACK_SIGNALS.spoofPowerDropDb;
  return (
    <Ruler
      title="How strong: received power at the Zaghouan input (dBm)"
      min={-110}
      max={-70}
      ticks={[-110, -105, -100, -95, -90, -85, -80, -75, -70]}
      tick={(v) => n(v, 0)}
      marker={{ at: SIGNAL.noiseFloorDbm, label: 'thermal floor' }}
      rows={[
        {
          label: `${sig.name} carrier`,
          span: [sig.rxDbm.min, sig.rxDbm.max],
          tone: 'accent',
          value: `${sig.amplitudeUv.min.toFixed(1)}–${sig.amplitudeUv.max.toFixed(1)} µV`,
        },
        {
          label: 'Spoofer 0x99A2',
          span: [sig.rxDbm.min - spoof, sig.rxDbm.max - spoof],
          tone: 'warn',
          value: `${spoof} dB low`,
        },
        {
          label: 'Carrier, strong jamming',
          span: [ATTACK_SIGNALS.jammedRssiDbm, ATTACK_SIGNALS.jammedRssiDbm],
          tone: 'bad',
          value: `${n(ATTACK_SIGNALS.jammedRssiDbm)} dBm`,
        },
        {
          label: 'Hidden jammer, at most',
          span: [STEALTH.maxNoiseDbm, STEALTH.maxNoiseDbm],
          tone: 'jam',
          value: `${n(STEALTH.maxNoiseDbm)} dBm`,
        },
        {
          label: 'Noise floor',
          span: [SIGNAL.noiseFloorDbm, SIGNAL.noiseFloorDbm],
          tone: 'quiet',
          value: `${SIGNAL.noiseUvRms.toFixed(2)} µV rms`,
        },
      ]}
    />
  );
}

export function FrequencyPlan({ sig }: { sig: PassSignal }) {
  const c = CHANNEL.carrierMHz;
  const half = CHANNEL.occupiedMHz / 2;
  const doppler = Math.max(Math.abs(sig.dopplerHz.min), Math.abs(sig.dopplerHz.max));
  return (
    <Ruler
      title="Where: frequency around the 8477.8 MHz carrier (MHz)"
      min={c - 20}
      max={c + 20}
      ticks={[c - 20, c - 10, c, c + 10, c + 20]}
      tick={(v) => v.toFixed(1)}
      rows={[
        {
          label: `${sig.name} downlink`,
          span: [c - half, c + half],
          tone: 'accent',
          value: `±${(doppler / 1e3).toFixed(0)} kHz Doppler`,
        },
        {
          label: 'Spoofer 0x99A2',
          span: [c - half, c + half],
          tone: 'warn',
          value: 'same channel',
        },
        {
          label: 'Frequency hijacker',
          span: [ATTACK_SIGNALS.hijackMHz - 0.8, ATTACK_SIGNALS.hijackMHz + 0.8],
          tone: 'bad',
          value: `${ATTACK_SIGNALS.hijackMHz.toFixed(1)} MHz`,
        },
        { label: 'Noise jammer', span: [c - 20, c + 20], tone: 'jam', value: 'broadband' },
      ]}
    />
  );
}

/** The selected signal from the database: its parameters, the χ² envelope and the rulers. */
export function SignalFacts({ sig }: { sig: PassSignal }) {
  return (
    <div className="facts">
      <div className="facts__tables">
        <table className="facts__table">
          <caption className="sr-only">Signal parameters of the selected pass</caption>
          <tbody>
            {factsFor(sig).map((f) => (
              <tr key={f.k}>
                <th scope="row">{f.k}</th>
                <td>
                  <span className="facts__value">{f.v}</span>
                  <span className="facts__note">{f.note}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="facts__table facts__table--jitter">
          <caption className="facts__caption">
            Natural variation vs the χ² gate · Σ z² ≤ {CHI_SQUARE.gate.toFixed(1)}
          </caption>
          <thead>
            <tr>
              <th scope="col">Measured against the orbit</th>
              <th scope="col">Natural</th>
              <th scope="col">Alone in the gate</th>
            </tr>
          </thead>
          <tbody>
            {JITTER.map((j) => (
              <tr key={j.k}>
                <th scope="row">{j.k}</th>
                <td className="mono">{j.natural}</td>
                <td className="mono facts__gate">{j.gate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="facts__figures">
        <PowerLevels sig={sig} />
        <FrequencyPlan sig={sig} />
      </div>
    </div>
  );
}
