import { Techniques } from '../ui/explain/NoiseMimicry';
import { DocPage } from './DocPage';

export function AttacksPage() {
  return (
    <DocPage
      path="/attacks"
      eyebrow="Threat"
      lead="Natural noise has a signature: Gaussian and white, slow fades, a carrier that follows the orbit. A careful attacker copies that signature so the attack blends in."
    >
      <Techniques />
    </DocPage>
  );
}
