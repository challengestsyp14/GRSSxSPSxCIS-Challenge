import { useRef } from 'react';

import { useEngine, useEngineCtx } from '../engineContext';
import { HANDOVER_STATION, ROGUE_NODE, SATELLITE, STATION, STATION_PLACE } from '../sim/copy';
import { CARRIER_HZ, passProfile, timeCompression } from '../sim/geometry';
import { axisFlag } from '../sim/engine';
import { evmFromSnr } from '../sim/signals';
import { fmtDb, fmtEpoch, fmtHz, MINUS } from './format';
import { BackIcon, DishIcon, SatelliteIcon } from './icons';
import { WaxSeal } from './Ledger';
import { Spectrum } from './Spectrum';
import { renderSpectrum, spectrumState, xOfHz } from './spectrumModel';
import { COLORS, FONT_DATA, FONT_UI, useCanvasLoop } from './useCanvas';

function gauss(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

/** QPSK constellation; noise follows the live SNR, attacks add their own signatures. */
function Constellation({ side }: { side: 'tx' | 'rx' }) {
  const { engine } = useEngineCtx();
  const points = useRef<{ x: number; y: number; rogue: boolean }[]>([]);
  const ref = useCanvasLoop((ctx, w, h) => {
    const size = Math.min(w, h);
    const cx = w / 2;
    const cy = h / 2;
    const scale = size * 0.3;

    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.46, cy);
    ctx.lineTo(cx + size * 0.46, cy);
    ctx.moveTo(cx, cy - size * 0.46);
    ctx.lineTo(cx, cy + size * 0.46);
    ctx.stroke();

    const x = engine.current;
    const link = engine.pass.linkActive && x !== null;
    const kind = engine.attack?.kind;
    const env = engine.attackEnvelope;
    if (link && x) {
      const snr = side === 'tx' ? 30 : x.snrDb;
      const sigma =
        side === 'tx'
          ? 0.03
          : Math.min(0.9, evmFromSnr(Math.max(snr, -5)) / 100 + (x.evmPct - x.evmModelPct) / 100);
      const lost = side === 'rx' && x.timingUs === null;
      for (let i = 0; i < 26 && !lost; i++) {
        const rogue =
          side === 'rx' &&
          (kind === 'hijack' || kind === 'spoof') &&
          env > 0.3 &&
          Math.random() < 0.6;
        // The hijacker's carrier rotates the symbols fast; node 0x99A2 sits almost on top.
        const phase = rogue ? (kind === 'hijack' ? engine.s * 7 : 0.08) : 0;
        const sym = Math.floor(Math.random() * 4);
        const a = Math.PI / 4 + (sym * Math.PI) / 2 + phase;
        points.current.push({
          x: Math.cos(a) + gauss() * sigma,
          y: Math.sin(a) + gauss() * sigma,
          rogue,
        });
      }
    }
    if (points.current.length > 520) points.current.splice(0, points.current.length - 520);

    points.current.forEach((p, i) => {
      const age = i / points.current.length;
      ctx.fillStyle = p.rogue
        ? `rgba(248, 72, 94, ${0.25 + 0.6 * age})`
        : `rgba(76, 201, 240, ${0.18 + 0.7 * age})`;
      ctx.fillRect(cx + p.x * scale - 1, cy - p.y * scale - 1, 2.2, 2.2);
    });

    // Ideal symbol positions.
    ctx.strokeStyle = 'rgba(236, 242, 248, 0.55)';
    for (let s = 0; s < 4; s++) {
      const a = Math.PI / 4 + (s * Math.PI) / 2;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * scale, cy - Math.sin(a) * scale, 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (!link) {
      ctx.fillStyle = COLORS.text2;
      ctx.font = `700 12px ${FONT_UI}`;
      ctx.textAlign = 'center';
      ctx.fillText('LOS', cx, cy - 10);
    } else if (side === 'rx' && x?.timingUs === null) {
      ctx.fillStyle = COLORS.warn;
      ctx.font = `700 12px ${FONT_UI}`;
      ctx.textAlign = 'center';
      ctx.fillText('LOCK LOST', cx, cy - 10);
    }
  }, 30);
  return (
    <canvas
      ref={ref}
      className="constellation"
      role="img"
      aria-label={`${side === 'tx' ? 'Transmitted' : 'Received'} QPSK constellation`}
    />
  );
}

/** Received spectrum waterfall around the Doppler-compensated carrier (±20 MHz). */
function Waterfall() {
  const { engine } = useEngineCtx();
  const buffer = useRef<HTMLCanvasElement | null>(null);
  const bins = useRef<Float32Array | null>(null);
  const lastT = useRef<number | null>(null);
  const ref = useCanvasLoop((ctx, w, h, t) => {
    const top = 16;
    const plotH = h - top;
    if (
      !buffer.current ||
      buffer.current.width !== Math.round(w) ||
      buffer.current.height !== Math.round(plotH)
    ) {
      buffer.current = document.createElement('canvas');
      buffer.current.width = Math.round(w);
      buffer.current.height = Math.round(plotH);
    }
    const b = buffer.current;
    const bctx = b.getContext('2d')!;

    const state = spectrumState(engine);
    if (!bins.current || bins.current.length !== b.width) bins.current = new Float32Array(b.width);
    const power = bins.current;

    // Scroll by elapsed time (40 rows per second) so the display is right at any frame rate.
    const rows =
      lastT.current === null ? 1 : Math.max(1, Math.min(24, Math.round((t - lastT.current) * 40)));
    lastT.current = t;
    bctx.drawImage(b, 0, rows);

    for (let rIdx = 0; rIdx < rows; rIdx++) {
      renderSpectrum(state, power);
      const row = bctx.createImageData(b.width, 1);
      for (let i = 0; i < b.width; i++) {
        // Same scale as the spectrum plot: thermal noise dark, 30 dB and above bright.
        const v = Math.max(0, Math.min(1, (10 * Math.log10(power[i] + 1e-9) + 4) / 32));
        // Colour map: navy → accent → ice.
        const r = v < 0.5 ? 10 + v * 2 * 66 : 76 + (v - 0.5) * 2 * 130;
        const g = v < 0.5 ? 16 + v * 2 * 185 : 201 + (v - 0.5) * 2 * 29;
        const bl = v < 0.5 ? 25 + v * 2 * 215 : 240 + (v - 0.5) * 2 * 15;
        row.data.set([r, g, bl, 255], i * 4);
      }
      bctx.putImageData(row, 0, rIdx);
    }
    ctx.drawImage(b, 0, top);

    ctx.fillStyle = COLORS.text2;
    ctx.font = `600 11px ${FONT_DATA}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(`${MINUS}20 MHz`, 2, 0);
    ctx.textAlign = 'center';
    ctx.fillText('carrier', w / 2, 0);
    ctx.textAlign = 'right';
    ctx.fillText('+20 MHz', w - 2, 0);
    const rogue = state.peaks.find((p) => p.rogue);
    if (rogue && engine.attackEnvelope > 0.3) {
      const spoof = engine.attack?.kind === 'spoof';
      ctx.fillStyle = spoof ? COLORS.warn : COLORS.bad;
      ctx.textAlign = 'center';
      const px = spoof ? w / 2 : xOfHz(rogue.hz, 0, w);
      ctx.fillText(
        spoof ? `NODE ${ROGUE_NODE}` : 'ROGUE-TX',
        Math.max(40, Math.min(w - 40, px)),
        top + 4,
      );
    }
    if (state.floorDb > 3) {
      ctx.fillStyle = COLORS.warn;
      ctx.textAlign = 'center';
      ctx.fillText('noise floor rising', w / 2, top + 4);
    }
  }, 30);
  return (
    <canvas ref={ref} className="waterfall" role="img" aria-label="Received spectrum waterfall" />
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'bad' | 'warn' | 'ok';
}) {
  return (
    <div className="metric">
      <span className="overline">{label}</span>
      <span className={`metric__value mono ${tone ? `metric__value--${tone}` : ''}`}>{value}</span>
    </div>
  );
}

function SatellitePanel() {
  const engine = useEngine(10);
  const pass = engine.pass;
  const frame = engine.txLog[0];
  const serving = engine.route === 'MAT' ? HANDOVER_STATION : STATION;
  return (
    <>
      <div className="focus__title">
        <SatelliteIcon size={18} />
        <div>
          <div className="focus__name">{SATELLITE} · downlink transmitter</div>
          <div className="focus__sub">
            X-band {(CARRIER_HZ / 1e6).toFixed(1)} MHz ·{' '}
            {Math.round(passProfile().altitudeKm * 10) / 10} km SSO ·{' '}
            {pass.linkActive ? `serving ${serving}` : 'LOS · recording on board'}
          </div>
        </div>
      </div>
      <div className="metrics">
        <Metric
          label="Elevation"
          value={pass.inView ? `${pass.elevationDeg.toFixed(1)}°` : 'below horizon'}
        />
        <Metric
          label="Slant range"
          value={pass.inView ? `${Math.round(pass.rangeKm).toLocaleString('en-US')} km` : '—'}
        />
        <Metric
          label="Range rate"
          value={
            pass.inView
              ? `${pass.rangeRateKmS < 0 ? MINUS : '+'}${Math.abs(pass.rangeRateKmS).toFixed(2)} km/s`
              : '—'
          }
        />
        <Metric label="Predicted Doppler" value={pass.inView ? fmtHz(pass.dopplerHz) : '—'} />
      </div>
      <div className="focus__split">
        <div className="focus__viz">
          <span className="overline">TX constellation · QPSK</span>
          <Constellation side="tx" />
        </div>
        <div className="frame-build">
          <span className="overline">Frame being sealed</span>
          {frame ? (
            <dl className="frame-build__fields">
              <dt>SEQ</dt>
              <dd className="mono">{frame.seq.toString(16).padStart(6, '0')}</dd>
              <dt>Frame</dt>
              <dd className="mono">{frame.frameHeader}</dd>
              <dt>Payload</dt>
              <dd className="mono">{frame.payloadHex}</dd>
              <dt>MAC</dt>
              <dd key={frame.seq} className="mono frame-build__mac">
                {frame.macHex.slice(0, 32)}…
              </dd>
              <dt>Key</dt>
              <dd className="mono">epoch {fmtEpoch(frame.epoch)} · HMAC-SHA256</dd>
            </dl>
          ) : (
            <p className="focus__empty">Waiting for the first frame…</p>
          )}
        </div>
      </div>
      <div className="focus__foot">
        <span>{engine.framesSent.toLocaleString('en-US')} frames sealed this session</span>
        <span>pass played ×{Math.round(timeCompression())} faster than real time</span>
      </div>
    </>
  );
}

function StationPanel() {
  const engine = useEngine(10);
  const x = engine.current;
  const rows = engine.ledger.slice(0, 6);
  const pointing = engine.pass.inView && engine.route === 'ZAG';
  return (
    <>
      <div className="focus__title">
        <DishIcon size={18} />
        <div>
          <div className="focus__name">{STATION_PLACE} · receiver and provenance gate</div>
          <div className="focus__sub">
            {engine.route === 'MAT'
              ? `Fallback routing via ${HANDOVER_STATION} · this station is flagged as jammed`
              : pointing
                ? `Tracking ${SATELLITE} · elevation ${engine.pass.elevationDeg.toFixed(1)}°`
                : 'Waiting for the next pass'}
          </div>
        </div>
      </div>
      <div className="metrics">
        <Metric
          label="Carrier power"
          value={x ? `${x.rssiDbm.toFixed(1)} dBm` : '—'}
          tone={
            x && x.rssiDbm < x.rssiModelDbm && axisFlag(engine.physics, 'rssiDb')
              ? 'warn'
              : undefined
          }
        />
        <Metric
          label="Carrier MHz"
          value={x ? x.carrierMHz.toFixed(2) : '—'}
          tone={axisFlag(engine.physics, 'dopplerHz') ? 'bad' : undefined}
        />
        <Metric
          label="SNR"
          value={x ? fmtDb(x.snrDb) : '—'}
          tone={axisFlag(engine.physics, 'rssiDb') ? 'bad' : undefined}
        />
        <Metric label="EVM" value={x ? `${x.evmPct.toFixed(1)}%` : '—'} />
      </div>
      <div className="focus__viz focus__viz--spectrum">
        <span className="overline">Received spectrum · amplitude vs frequency</span>
        <Spectrum className="spectrum" />
      </div>
      <div className="focus__split">
        <div className="focus__viz focus__viz--wide">
          <span className="overline">Waterfall · ±20 MHz</span>
          <Waterfall />
        </div>
        <div className="focus__viz">
          <span className="overline">RX constellation</span>
          <Constellation side="rx" />
        </div>
      </div>
      <div className="verify-feed">
        <span className="overline">Every frame, verified before the analyst sees it</span>
        <ul>
          {rows.map((r) => (
            <li key={r.id} className="verify-feed__row">
              <WaxSeal verdict={r.verdict} size={18} />
              <span className="mono">
                {r.seq === null ? '——————' : r.seq.toString(16).padStart(6, '0')}
              </span>
              <span className="verify-feed__source">{r.source}</span>
              <span
                className={`verify-feed__gate ${r.verdict === 'VERIFIED' ? 'is-pass' : 'is-held'}`}
              >
                {r.verdict === 'VERIFIED'
                  ? 'to analyst'
                  : r.verdict === 'LOST'
                    ? 'no frame'
                    : 'held at gate'}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

export function FocusOverlay() {
  const { focus, setFocus } = useEngineCtx();
  if (focus === 'overview') return null;
  return (
    <aside
      className="focus"
      aria-label={focus === 'sat' ? 'Satellite detail' : 'Ground station detail'}
    >
      <button type="button" className="focus__back" onClick={() => setFocus('overview')}>
        <BackIcon size={14} /> Back to overview <kbd>Esc</kbd>
      </button>
      {focus === 'sat' ? <SatellitePanel /> : <StationPanel />}
    </aside>
  );
}
