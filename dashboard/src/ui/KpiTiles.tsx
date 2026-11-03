import { useEngine } from '../engineContext';
import { useSpotlight } from '../reactbits/SpotlightCard';
import type { Engine } from '../sim/engine';
import type { AttackKind } from '../sim/signals';
import { fmtMs } from './format';
import { AlertIcon, ATTACK_ICONS, CheckIcon } from './icons';

const ATTACKS: AttackKind[] = ['spoof', 'tamper', 'hijack', 'jam'];

/** Attack frames flagged and genuine frames held or rejected, so far in this browser. */
function measured(engine: Engine) {
  let attackFrames = 0;
  let stopped = 0;
  for (const kind of ATTACKS) {
    const st = engine.layerStats[kind];
    attackFrames += st?.frames ?? 0;
    // Flagged: held, rejected, quarantined, or a jammed frame delivered tagged as degraded.
    stopped += st?.flagged ?? 0;
  }
  const genuine = engine.layerStats.genuine;
  return {
    attackFrames,
    stopped,
    genuineFrames: genuine?.frames ?? 0,
    falseAlarms: genuine?.blocked ?? 0,
  };
}

const pct = (n: number, d: number, digits = 1) => `${((n / d) * 100).toFixed(digits)}%`;

type Tone = 'ok' | 'warn' | 'bad' | 'muted';

function Tile({
  label,
  value,
  note,
  tone = 'muted',
  alert = false,
}: {
  label: string;
  value: string;
  note: string;
  tone?: Tone;
  alert?: boolean;
}) {
  const spotlight = useSpotlight<HTMLDivElement>();
  return (
    <div
      ref={spotlight.ref}
      onPointerMove={spotlight.onPointerMove}
      className={`tile ${alert ? 'tile--alert' : ''}`}
    >
      <div className="tile__label">{label}</div>
      <div className="tile__row">
        <span className="tile__value mono">{value}</span>
        <span className={`tile__note tile__note--${tone}`}>{note}</span>
      </div>
    </div>
  );
}

function Banner() {
  const engine = useEngine(15);
  const b = engine.banner;
  if (!b) return null;
  const Icon = b.tone === 'ok' ? CheckIcon : (ATTACK_ICONS[b.kind] ?? AlertIcon);
  const since = engine.run ? engine.s - engine.run.tTrigger : engine.s - b.shownAt;
  return (
    <div
      key={`${b.kind}-${b.tone}-${b.shownAt}`}
      className={`banner banner--${b.tone}`}
      role="alert"
    >
      <span className="banner__hazard" aria-hidden="true" />
      <span className="banner__icon">
        <Icon size={22} />
      </span>
      <div className="banner__text">
        <div className="banner__headline">
          {b.tone === 'ok' ? `RESOLVED · ${b.headline}` : b.headline}
        </div>
        <div className="banner__detail">{b.detail}</div>
      </div>
      <span className="banner__time mono">T+{since.toFixed(1)} s</span>
    </div>
  );
}

export function KpiTiles() {
  const engine = useEngine(6);
  const m = measured(engine);
  const attack = engine.state === 'UNDER ATTACK';
  const jamming = engine.state === 'JAMMING';
  const overhead = engine.medianOverheadMs;
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    ?.usedJSHeapSize;
  const last = engine.lastRun;
  const integrity = engine.linkIntegrity;
  const measuredDetect = engine.medianEscalateMs;

  return (
    <div className="kpis-wrap">
      <div className="kpis">
        <Tile
          label="Frames verified"
          value={engine.framesVerified.toLocaleString('en-US')}
          note={`+${engine.verifiedPerSecond.toFixed(1)} per second`}
          tone="ok"
        />
        <Tile
          label="Detection rate"
          value={m.attackFrames ? pct(m.stopped, m.attackFrames) : '—'}
          note={m.attackFrames ? `of ${m.attackFrames} attack frames` : 'run an attack'}
          tone={m.attackFrames ? (m.stopped === m.attackFrames ? 'ok' : 'warn') : 'muted'}
        />
        <Tile
          label="False-alarm rate"
          value={m.genuineFrames ? pct(m.falseAlarms, m.genuineFrames) : '—'}
          note={m.genuineFrames ? `of ${m.genuineFrames} genuine frames` : 'three tiers'}
          tone={m.falseAlarms ? 'warn' : 'muted'}
        />
        <Tile
          label="Security overhead"
          value={overhead === null ? '—' : `+${fmtMs(overhead)}`}
          note={heap ? `per frame · ${Math.round(heap / 1048576)} MB heap` : 'per frame · measured'}
        />
        <Tile
          label="Time to detect"
          value={
            last?.escalateMs != null
              ? fmtMs(last.escalateMs)
              : measuredDetect === null
                ? '—'
                : fmtMs(measuredDetect)
          }
          note={last?.escalateMs != null ? 'last event' : 'no events yet'}
          tone={jamming ? 'warn' : attack ? 'bad' : 'muted'}
          alert={attack}
        />
        <Tile
          label="Link integrity"
          value={`${(Math.min(1, integrity) * 100).toFixed(1)}%`}
          note={integrity < 0.999 ? 'frames rejected' : 'all frames verified'}
          tone={integrity < 0.999 ? 'bad' : 'ok'}
          alert={attack}
        />
      </div>
      <Banner />
    </div>
  );
}
