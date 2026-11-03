import { useEngine } from '../engineContext';
import type { SystemState } from '../sim/engine';
import { ScrambleText } from '../reactbits/ScrambleText';
import { passChip } from './orbitText';
import { FleetPicker } from './FleetPicker';

const PILL: Record<SystemState, string> = {
  NOMINAL: 'ok',
  CHECKING: 'warn',
  'UNDER ATTACK': 'bad',
  JAMMING: 'warn',
  RECOVERING: 'warn',
};

/**
 * The testbed's status strip, under the site's shared top bar: the satellite flown, the pass or
 * the demo, and the link state.
 */
export function Header() {
  const engine = useEngine(4);
  const blink = engine.state === 'UNDER ATTACK' || engine.state === 'JAMMING';

  return (
    <header className="header dash-status">
      <div className="header__brand">
        <span className="dash-status__label">Satellite flown</span>
        <FleetPicker />
        <span className="dash-status__hint">Click to fly another satellite</span>
      </div>
      <span className="header__live">
        <span className="header__live-dot" />
        {engine.demo.active ? 'Demo · four scenarios' : passChip()}
      </span>
      <div className="header__right">
        <span
          className={`pill pill--${PILL[engine.state]} ${blink ? 'pill--blink' : ''}`}
          role="status"
          aria-live="polite"
        >
          <span className="pill__dot" />
          <ScrambleText text={engine.state} />
        </span>
      </div>
    </header>
  );
}
