import { useEffect, useState, type MouseEvent } from 'react';

import { useEngine, useEngineCtx } from '../engineContext';
import { ATTACK_BUTTONS, ATTACK_PROOF, UPLINK_BUTTONS, UPLINK_PROOF } from '../sim/copy';
import { C_KM_S, UPLINK } from '../sim/geometry';
import { jamToNoiseDb, type AttackKind } from '../sim/signals';
import { UPLINK_THREATS, type UplinkThreat } from '../sim/uplink';
import { ATTACK_ICONS, LockIcon, PlayIcon, SearchIcon, StopIcon } from './icons';
import { MINUS } from './format';
import { Panel } from './Panel';

/** Crypto-only attacks first: they are the ones RF monitoring alone cannot see. */
const ORDER: AttackKind[] = ['spoof', 'tamper', 'hijack', 'jam'];

function AttackButton({
  kind,
  onHover,
}: {
  kind: AttackKind;
  onHover: (k: AttackKind | null) => void;
}) {
  const engine = useEngine(15);
  const { setInspectorOpen } = useEngineCtx();
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);
  const copy = ATTACK_BUTTONS[kind];
  const Icon = ATTACK_ICONS[kind];
  const running = engine.attack?.kind === kind;
  const disabled = engine.busy || engine.demo.active;
  const attack = engine.attack;
  const progress =
    running && attack
      ? Math.min(
          1,
          (engine.s - attack.tTrigger) / Math.max(0.1, attack.tResponse + 0.6 - attack.tTrigger),
        )
      : 0;

  const click = (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const id = performance.now();
    setRipples((r) => [...r, { id, x: e.clientX - rect.left, y: e.clientY - rect.top }]);
    window.setTimeout(() => setRipples((r) => r.filter((p) => p.id !== id)), 650);
    // Open the packet drawer on the live frames, so every verdict can be inspected.
    if (engine.trigger(kind)) setInspectorOpen(true);
  };

  return (
    <button
      type="button"
      className={`attack attack--${kind} ${running ? 'attack--running' : ''}`}
      onClick={click}
      onMouseEnter={() => onHover(kind)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(kind)}
      onBlur={() => onHover(null)}
      disabled={disabled && !running}
      aria-pressed={running}
      aria-describedby="attack-proof"
    >
      <span className="attack__icon">
        <Icon size={18} />
      </span>
      <span className="attack__text">
        <span className="attack__label">{copy.label}</span>
        <span className="attack__sub">{running ? 'running…' : copy.sub}</span>
      </span>
      {running && (
        <span className="attack__progress" style={{ transform: `scaleX(${progress})` }} />
      )}
      {ripples.map((r) => (
        <span key={r.id} className="attack__ripple" style={{ left: r.x, top: r.y }} />
      ))}
    </button>
  );
}

function UplinkButton({
  threat,
  onHover,
}: {
  threat: UplinkThreat;
  onHover: (t: UplinkThreat | null) => void;
}) {
  const engine = useEngine(15);
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);
  const copy = UPLINK_BUTTONS[threat];
  const Icon = ATTACK_ICONS[threat];
  const run = engine.uplinkRun;
  const running = run?.threat === threat;
  const disabled = engine.busy || engine.demo.active;
  const progress =
    running && run ? Math.min(1, (engine.s - run.tTrigger) / (run.until - run.tTrigger)) : 0;

  const click = (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const id = performance.now();
    setRipples((r) => [...r, { id, x: e.clientX - rect.left, y: e.clientY - rect.top }]);
    window.setTimeout(() => setRipples((r) => r.filter((p) => p.id !== id)), 650);
    engine.triggerUplink(threat);
  };

  return (
    <button
      type="button"
      className={`attack attack--up ${running ? 'attack--running' : ''}`}
      onClick={click}
      onMouseEnter={() => onHover(threat)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(threat)}
      onBlur={() => onHover(null)}
      disabled={disabled && !running}
      aria-pressed={running}
      aria-describedby="attack-proof"
    >
      <span className="attack__icon">
        <Icon size={18} />
      </span>
      <span className="attack__text">
        <span className="attack__label">{copy.label}</span>
        <span className="attack__sub">
          {running && run ? `running… ${run.blocked} rejected on board` : copy.sub}
        </span>
      </span>
      {running && (
        <span className="attack__progress" style={{ transform: `scaleX(${progress})` }} />
      )}
      {ripples.map((r) => (
        <span key={r.id} className="attack__ripple" style={{ left: r.x, top: r.y }} />
      ))}
    </button>
  );
}

/** The uplink as the spacecraft sees it, live: carrier, Doppler, power, the last command. */
function UplinkLive() {
  const engine = useEngine(10);
  const pass = engine.pass;
  const last = engine.uplink[0];
  const doppler = pass.linkActive ? (-UPLINK.carrierHz * pass.rangeRateKmS) / C_KM_S / 1e3 : null;
  const st = engine.uplinkStats;
  return (
    <div className="uplive" aria-live="off">
      <div className="uplive__row">
        <span className="overline">↑ S-band {UPLINK.carrierHz / 1e6} MHz</span>
        <span className="mono uplive__doppler">
          {doppler === null
            ? 'no link'
            : `${doppler < 0 ? MINUS : '+'}${Math.abs(doppler).toFixed(2)} kHz Doppler`}
        </span>
      </div>
      <div className="uplive__row">
        <span className="mono uplive__last">
          {last
            ? `#${last.seq} ${last.opcode} · ${last.verdict}`
            : 'waiting for the first telecommand'}
        </span>
        <span className="mono uplive__count">
          {st.executed} executed · {st.rejected} rejected
        </span>
      </div>
    </div>
  );
}

function Toggle({
  label,
  on,
  onChange,
  disabled,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`toggle ${on ? 'toggle--on' : ''}`}
      onClick={() => onChange(!on)}
      disabled={disabled}
    >
      <span className="toggle__track" aria-hidden="true">
        <span className="toggle__thumb" />
      </span>
      <span className="toggle__label">{label}</span>
    </button>
  );
}

export function ControlDeckPanel() {
  const engine = useEngine(15);
  const { inspectorOpen, setInspectorOpen } = useEngineCtx();
  const [hovered, setHovered] = useState<AttackKind | null>(null);
  const [hoveredUp, setHoveredUp] = useState<UplinkThreat | null>(null);
  const [link, setLink] = useState<'down' | 'up'>('down');
  const uplinkThreat = engine.uplinkRun?.threat ?? null;
  // A running uplink attack shows the uplink side.
  useEffect(() => {
    if (uplinkThreat) setLink('up');
  }, [uplinkThreat]);
  const proofKind = hovered ?? engine.attack?.kind ?? null;
  const proofUp = hoveredUp ?? uplinkThreat;
  const power = engine.appliedPower;
  const jn = jamToNoiseDb(power);
  // The jam is read as its jammer-to-noise ratio; the other attacks as excess power.
  const powerText =
    engine.attack?.kind === 'jam' || hovered === 'jam'
      ? `J/N ${Number.isFinite(jn) ? `${jn < 0 ? MINUS : '+'}${Math.abs(jn).toFixed(1)}` : `<${MINUS}30`} dB`
      : `${power < 0 ? MINUS : '+'}${Math.abs(power).toFixed(1)} dB`;
  const statusTone =
    engine.state === 'UNDER ATTACK'
      ? 'bad'
      : engine.state === 'JAMMING' || engine.state === 'CHECKING' || engine.state === 'RECOVERING'
        ? 'warn'
        : engine.busy
          ? 'warn'
          : 'ok';
  const compromised = engine.compromisedNow;
  const remaining =
    compromised && engine.compromised
      ? Math.max(0, Math.ceil(engine.compromised.to - engine.s))
      : 0;
  const jamming = engine.attack?.kind === 'jam';

  return (
    <Panel
      badge="4"
      title="Simulate attack"
      tag="D5 · Response"
      alert={engine.state === 'UNDER ATTACK'}
      className="panel--deck"
    >
      <div className="deck__head">
        <div className="seg deck__links" role="group" aria-label="Which link to attack">
          <button
            type="button"
            className={`seg__btn ${link === 'down' ? 'seg__btn--on' : ''}`}
            aria-pressed={link === 'down'}
            onClick={() => setLink('down')}
          >
            ↓ Downlink
          </button>
          <button
            type="button"
            className={`seg__btn seg__btn--up ${link === 'up' ? 'seg__btn--on' : ''}`}
            aria-pressed={link === 'up'}
            onClick={() => setLink('up')}
          >
            ↑ Uplink
          </button>
        </div>
        <span className="deck__heldout">held-out set: {engine.heldOut ? 'on' : 'off'}</span>
      </div>
      {link === 'down' ? (
        <div className="attacks" key="down">
          {ORDER.map((k) => (
            <AttackButton key={k} kind={k} onHover={setHovered} />
          ))}
        </div>
      ) : (
        <div className="attacks attacks--up" key="up">
          {UPLINK_THREATS.map((t) => (
            <UplinkButton key={t} threat={t} onHover={setHoveredUp} />
          ))}
        </div>
      )}
      <p
        id="attack-proof"
        className={`deck__proof ${link === 'down' && proofKind ? `deck__proof--${proofKind}` : ''} ${link === 'up' && proofUp ? 'deck__proof--up' : ''}`}
        aria-live="polite"
      >
        {link === 'down'
          ? proofKind
            ? ATTACK_PROOF[proofKind]
            : 'Each scenario opens the packet drawer on the live frames'
          : proofUp
            ? UPLINK_PROOF[proofUp]
            : 'Telecommands go up from Zaghouan; the satellite verifies each one on board'}
      </p>

      {link === 'up' ? (
        <UplinkLive />
      ) : (
        <div className={`power ${jamming ? 'power--live' : ''}`}>
          <label className="overline" htmlFor="attack-power">
            Attack power
          </label>
          <input
            id="attack-power"
            type="range"
            min={0}
            max={15}
            step={0.5}
            value={power}
            disabled={engine.demo.active}
            onChange={(e) => engine.setPower(Number(e.target.value))}
            style={{ ['--fill' as string]: `${(power / 15) * 100}%` }}
            aria-valuetext={powerText}
          />
          <span className="power__value mono">{powerText}</span>
        </div>
      )}
      <p className="deck__hint">
        {link === 'up'
          ? 'Every command is sealed with HMAC-SHA256; the satellite checks the tag, then the count.'
          : jamming
            ? 'Drag the slider: jammer power drives the SNR loss and carrier power live.'
            : 'The slider sets jammer power and the hijacker’s excess power.'}
      </p>

      <div className="toggles">
        <Toggle
          label="Auto-response (quarantine; re-key on key-holder evidence)"
          on={engine.autoResponse}
          disabled={engine.demo.active}
          onChange={(v) => (engine.autoResponse = v)}
        />
        <Toggle
          label="Log every event to the ledger"
          on={engine.logEvents}
          onChange={(v) => (engine.logEvents = v)}
        />
      </div>

      <div className="deck__foot">
        <div className={`status-line status-line--${statusTone}`}>
          <span className="status-line__dot" />
          <span>{engine.statusLine}</span>
        </div>
        <button
          type="button"
          className={`inspect-button ${inspectorOpen ? 'inspect-button--active' : ''}`}
          onClick={() => setInspectorOpen(!inspectorOpen)}
          aria-expanded={inspectorOpen}
          aria-controls="packet-drawer"
        >
          <SearchIcon size={12} />
          Inspect packets
        </button>
        <button
          type="button"
          className={`demo-button ${engine.demo.active ? 'demo-button--active' : ''}`}
          onClick={() => (engine.demo.active ? engine.stopDemo() : engine.playDemo())}
          disabled={engine.busy && !engine.demo.active}
        >
          {engine.demo.active ? <StopIcon size={12} /> : <PlayIcon size={12} />}
          {engine.demo.active ? 'Stop demo' : 'Play demo'}
          {engine.demo.active && (
            <span
              className="demo-button__progress"
              style={{ transform: `scaleX(${engine.demoProgress})` }}
            />
          )}
        </button>
      </div>

      {compromised && (
        <div className="compromised" role="alert">
          <LockIcon size={28} />
          <div className="compromised__title">Compromised state</div>
          <div className="compromised__detail">Deck locked while the link is quarantined</div>
          <div className="compromised__count mono">Auto-response in 00:0{remaining}</div>
        </div>
      )}
    </Panel>
  );
}
