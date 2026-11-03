import { useRef, useState, type PointerEvent } from 'react';

import { SIGNAL, STEALTH, STEALTH_BY_ELEVATION, snrLossDb } from '../../sim/linkFacts';
import { MINUS } from '../format';

const XMIN = -14;
const XMAX = 6;
const YMAX = 6;
const W = 640;
const H = 330;
const PAD = { l: 56, r: 18, t: 18, b: 56 };
const PW = W - PAD.l - PAD.r;
const PH = H - PAD.t - PAD.b;
const X = (v: number) => PAD.l + ((v - XMIN) / (XMAX - XMIN)) * PW;
const Y = (v: number) => PAD.t + PH - (Math.min(v, YMAX) / YMAX) * PH;
const sign = (v: number) => (v < 0 ? MINUS : '+');
const dbm = (v: number) => `${v < 0 ? MINUS : ''}${Math.abs(v).toFixed(1)} dBm`;

const CURVE = Array.from({ length: 181 }, (_, i) => {
  const v = XMIN + ((XMAX - XMIN) * i) / 180;
  return `${i ? 'L' : 'M'}${X(v).toFixed(1)},${Y(snrLossDb(v)).toFixed(1)}`;
}).join('');

const elevationLabel = (el: number) => (el >= 90 ? 'overhead' : `${el}°`);

/**
 * How much noise an attacker can add before the chi-square engine sees it, and what that costs
 * the link: SNR lost = 10·log10(1 + J/N). The power residual alone may reach 0.23 dB × √gate
 * before the gate fires, and the gate widens near the horizon: 1.1 dB overhead (J/N −5.3 dB),
 * 1.7 dB at the 2° mask (J/N −3.1 dB). The old ±4 dB box band is drawn for comparison.
 */
export function StealthBudget() {
  const [above, setAbove] = useState(-8);
  const [at, setAt] = useState(STEALTH_BY_ELEVATION.length - 1);
  const svg = useRef<SVGSVGElement>(null);
  const budget = STEALTH_BY_ELEVATION[at];
  const loss = snrLossDb(above);
  const hidden = loss <= budget.maxSnrLossDb;
  const limit = budget.maxNoiseAboveFloorDb;

  const fromPointer = (e: PointerEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((e.clientX - box.left) / box.width) * W;
    const v = XMIN + ((px - PAD.l) / PW) * (XMAX - XMIN);
    setAbove(Math.round(Math.max(XMIN, Math.min(XMAX, v)) * 10) / 10);
  };

  return (
    <figure className="budget">
      <figcaption className="figure__title">
        The attacker’s stealth budget: drag to add noise
      </figcaption>
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className="budget__svg"
        role="img"
        aria-label={`Noise ${sign(above)}${Math.abs(above).toFixed(1)} dB above the thermal floor costs ${loss.toFixed(1)} dB of signal-to-noise ratio: ${hidden ? 'hidden, the frames still verify' : 'visible, the χ² engine fires'}`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons) fromPointer(e);
        }}
      >
        <rect
          x={X(XMIN)}
          y={Y(budget.maxSnrLossDb)}
          width={X(limit) - X(XMIN)}
          height={Y(0) - Y(budget.maxSnrLossDb)}
          className="budget__zone budget__zone--ok"
        />
        <rect
          x={X(limit)}
          y={Y(YMAX)}
          width={X(XMAX) - X(limit)}
          height={Y(0) - Y(YMAX)}
          className="budget__zone budget__zone--bad"
        />
        {[0, 1, 2, 3, 4, 5, 6].map((v) => (
          <g key={`y${v}`}>
            <line x1={X(XMIN)} x2={X(XMAX)} y1={Y(v)} y2={Y(v)} className="fig-grid" />
            <text x={PAD.l - 10} y={Y(v) + 4} textAnchor="end" className="fig-tick">
              {v}
            </text>
          </g>
        ))}
        {[-14, -10, -6, -2, 2, 6].map((v) => (
          <text key={`x${v}`} x={X(v)} y={Y(0) + 22} textAnchor="middle" className="fig-tick">
            {v > 0 ? `+${v}` : v < 0 ? `${MINUS}${-v}` : '0'}
          </text>
        ))}
        <text x={X(XMAX)} y={H - 8} textAnchor="end" className="fig-label">
          noise added above the thermal floor (dB)
        </text>
        <text x={PAD.l} y={PAD.t - 4} className="fig-label">
          SNR lost (dB)
        </text>
        <line
          x1={X(XMIN)}
          x2={X(XMAX)}
          y1={Y(STEALTH.boxBandDb)}
          y2={Y(STEALTH.boxBandDb)}
          className="budget__old"
        />
        <text x={X(XMIN) + 8} y={Y(STEALTH.boxBandDb) - 8} className="budget__old-label">
          old box gate · ±{STEALTH.boxBandDb} dB band
        </text>
        <line
          x1={X(XMIN)}
          x2={X(XMAX)}
          y1={Y(budget.maxSnrLossDb)}
          y2={Y(budget.maxSnrLossDb)}
          className="budget__gate"
        />
        <text x={X(XMIN) + 8} y={Y(budget.maxSnrLossDb) - 8} className="budget__gate-label">
          χ² gate {elevationLabel(budget.elevationDeg)} · {budget.maxSnrLossDb.toFixed(2)} dB of
          power alone
        </text>
        <line x1={X(limit)} x2={X(limit)} y1={Y(0)} y2={Y(YMAX)} className="budget__limit" />
        <text x={X(limit) + 6} y={Y(0) - 8} className="budget__limit-label">
          {sign(limit)}
          {Math.abs(limit).toFixed(1)} dB · {dbm(SIGNAL.noiseFloorDbm + limit)}
        </text>
        <path d={CURVE} className="budget__curve" />
        <circle
          cx={X(above)}
          cy={Y(loss)}
          r={9}
          className={`budget__dot ${hidden ? 'budget__dot--ok' : 'budget__dot--bad'}`}
        />
      </svg>
      <div className="budget__elevations" role="group" aria-label="Satellite elevation">
        <span className="budget__elevations-label">Elevation</span>
        {STEALTH_BY_ELEVATION.map((b, i) => (
          <button
            key={b.elevationDeg}
            type="button"
            className={`seg__btn ${i === at ? 'seg__btn--on' : ''}`}
            aria-pressed={i === at}
            onClick={() => setAt(i)}
            title={`Gate ${b.gate.toFixed(1)} (×${b.widening.toFixed(2)}) · ${b.maxSnrLossDb.toFixed(2)} dB · J/N ${b.maxNoiseAboveFloorDb.toFixed(1)} dB`}
          >
            {elevationLabel(b.elevationDeg)}
          </button>
        ))}
      </div>
      <input
        type="range"
        className="budget__range"
        min={XMIN}
        max={XMAX}
        step={0.1}
        value={above}
        onChange={(e) => setAbove(Number(e.target.value))}
        aria-label="Noise the attacker adds, in dB above the thermal floor"
        aria-valuetext={`${sign(above)}${Math.abs(above).toFixed(1)} dB`}
      />
      <dl className="budget__readout">
        <div>
          <dt>J/N</dt>
          <dd className="mono">
            {sign(above)}
            {Math.abs(above).toFixed(1)} dB
          </dd>
        </div>
        <div>
          <dt>Jammer at the receiver</dt>
          <dd className="mono">
            {dbm(SIGNAL.noiseFloorDbm + above)} · floor {dbm(SIGNAL.noiseFloorDbm)}
          </dd>
        </div>
        <div>
          <dt>SNR at the 2° mask</dt>
          <dd className="mono">{(SIGNAL.snrDb.mask - loss).toFixed(1)} dB</dd>
        </div>
        <div>
          <dt>SNR overhead</dt>
          <dd className="mono">{(SIGNAL.snrDb.zenith - loss).toFixed(1)} dB</dd>
        </div>
        <div>
          <dt>Budget {elevationLabel(budget.elevationDeg)}</dt>
          <dd className="mono">
            {budget.maxSnrLossDb.toFixed(2)} dB · J/N {sign(limit)}
            {Math.abs(limit).toFixed(1)} dB
          </dd>
        </div>
        <div>
          <dt>Outcome</dt>
          <dd className={hidden ? 'budget__ok' : 'budget__bad'}>
            {hidden ? 'Hidden: frames still verify' : 'Visible: the χ² engine fires'}
          </dd>
        </div>
      </dl>
    </figure>
  );
}
