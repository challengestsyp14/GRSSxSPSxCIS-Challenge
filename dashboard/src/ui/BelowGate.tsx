import { useEffect, useRef } from 'react';

import { useEngine } from '../engineContext';

/**
 * Jammer power that stays inside the chi-square gate in the engine: about 0.2 dB of SNR lost,
 * one sigma of the power residual, well inside the 1.1 dB the gate tolerates on its own.
 */
export const BELOW_GATE_DB = 2.3;

/** Link from the Protection page that opens the testbed and starts a below-the-gate jam. */
export const BELOW_GATE_HREF = '/?run=below-gate';

/**
 * Starts Noise Jamming at +{@link BELOW_GATE_DB} dB once when the dashboard is opened from
 * {@link BELOW_GATE_HREF}, then puts the attack-power slider back when the run is over.
 */
export function useBelowGateLink() {
  const engine = useEngine(4);
  const restore = useRef<number | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const url = new URL(window.location.href);
    if (url.searchParams.get('run') !== 'below-gate') return;
    url.searchParams.delete('run');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    const previous = engine.power;
    engine.setPower(BELOW_GATE_DB);
    if (engine.trigger('jam')) restore.current = previous;
    else engine.setPower(previous);
  }, [engine]);

  useEffect(() => {
    if (restore.current !== null && !engine.attack) {
      engine.setPower(restore.current);
      restore.current = null;
    }
  });
}
