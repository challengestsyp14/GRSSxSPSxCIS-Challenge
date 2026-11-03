import { STEALTH } from '../sim/linkFacts';
import { jamSnrLossDb, jamToNoiseDb } from '../sim/signals';
import { BELOW_GATE_DB, BELOW_GATE_HREF } from '../ui/BelowGate';
import { Protection } from '../ui/explain/NoiseMimicry';
import { JamIcon } from '../ui/icons';
import { DocPage } from './DocPage';

export function ProtectionPage() {
  return (
    <DocPage
      path="/protection"
      eyebrow="Defence"
      lead="We do not try to tell every noise from every attack by its look. Each of the three tiers makes the imitation either too weak to matter or impossible to hide."
      aside={
        <div className="npage__try">
          <a className="explain__cta" href={BELOW_GATE_HREF}>
            <JamIcon size={14} />
            Run a below-the-gate jam on the live testbed
          </a>
          <p className="explain__hint">
            Starts Noise Jamming at a jammer-to-noise ratio of J/N ={' '}
            {jamToNoiseDb(BELOW_GATE_DB).toFixed(1).replace('-', '−')} dB: the SNR dips about{' '}
            {jamSnrLossDb(BELOW_GATE_DB).toFixed(1)} dB, inside the budget at every elevation (
            {STEALTH.maxSnrLossDb.toFixed(1)} dB overhead, {STEALTH.atMask.maxSnrLossDb.toFixed(1)}{' '}
            dB at the 2° mask), so it stays inside the χ² gate, nothing escalates and every frame is
            accepted.
          </p>
        </div>
      }
    >
      <Protection />
    </DocPage>
  );
}
