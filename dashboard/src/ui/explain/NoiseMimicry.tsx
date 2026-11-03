import type { ComponentType } from 'react';

import { ATTACK_SIGNALS, CHI_SQUARE, NATURAL, STEALTH } from '../../sim/linkFacts';
import {
  ForestIcon,
  JamIcon,
  KeyIcon,
  OrbitIcon,
  ShieldIcon,
  SpoofIcon,
  TamperIcon,
} from '../icons';
import { StealthBudget } from './StealthBudget';

interface Technique {
  name: string;
  tone: 'jam' | 'warn' | 'tamper';
  Icon: ComponentType<{ size?: number }>;
  imitates: string;
  how: string;
  gains: string;
  givesAway: string;
}

const TECHNIQUES: Technique[] = [
  {
    name: 'Noise-shaped jamming',
    tone: 'jam',
    Icon: JamIcon,
    imitates: 'thermal noise and rain fade',
    how: 'Transmits Gaussian, white noise across the band and ramps it up slowly, so the floor creeps instead of jumping.',
    gains: 'A lower signal-to-noise ratio with no spike to see on the spectrum.',
    givesAway: `The budget depends on elevation, because the χ² gate widens near the horizon. Overhead, louder than ${Math.abs(STEALTH.maxNoiseAboveFloorDb).toFixed(1)} dB below the thermal noise, it takes more than ${STEALTH.maxSnrLossDb.toFixed(1)} dB of SNR and the χ² engine fires on the power residual alone; at the 2° mask the limit is ${Math.abs(STEALTH.atMask.maxNoiseAboveFloorDb).toFixed(1)} dB below the noise and ${STEALTH.atMask.maxSnrLossDb.toFixed(1)} dB of SNR. Quieter than that, every frame still verifies. Once the power residual alone fires, the genuine frames still reach the analyst, flagged as degraded, with a jamming alarm.`,
  },
  {
    name: 'Fade-mimicking spoofing',
    tone: 'warn',
    Icon: SpoofIcon,
    imitates: 'natural fading and the Doppler track',
    how: `Node 0x99A2 pre-corrects its carrier to the satellite’s Doppler curve and adds artificial fading: the carrier stays within tens of hertz and the power only ${ATTACK_SIGNALS.spoofPowerDropDb} dB low.`,
    gains: `It stays inside a ±${STEALTH.boxBandDb} dB band: a gate with fixed tolerances lets it through.`,
    givesAway: `The χ² engine knows the power to ${NATURAL.powerDb.sigma} dB: ${ATTACK_SIGNALS.spoofPowerDropDb} dB low is ${Math.round(ATTACK_SIGNALS.spoofPowerDropDb / NATURAL.powerDb.sigma)}σ off the link budget. It also cannot produce a valid HMAC-SHA256 tag without the key, it reuses nonces, and its emulated hardware token is wrong.`,
  },
  {
    name: 'Bit flips disguised as bit errors',
    tone: 'tamper',
    Icon: TamperIcon,
    imitates: 'random bit errors caused by noise',
    how: 'Flips chosen payload bits between the satellite and the station, then recomputes the CRC, which anyone can do.',
    gains: 'The frame looks like a noisy one that passed its checksum. No RF signature at all.',
    givesAway:
      'The HMAC tag, which needs the secret key, no longer matches: the data layer rejects the frame. One HMAC failure is treated as possibly benign and the frame is resent; a burst of 3 failures within 10 frames quarantines the link.',
  },
];

const LAYERS: { name: string; Icon: ComponentType<{ size?: number }>; body: string }[] = [
  {
    name: 'Data layer · trust anchor',
    Icon: KeyIcon,
    body: 'Every frame carries an HMAC-SHA256 tag made with a secret key, checked in constant time, then a fresh nonce and a SHA-256 chain back to the genesis block. Noise cannot produce a tag: any changed bit fails the check, and a guessed tag matches one time in 2²⁵⁶.',
  },
  {
    name: 'Statistical layer · Isolation Forest',
    Icon: ForestIcon,
    body: 'Trained on clean passes only, it reads what the χ² cannot see: the EVM of the constellation, the frame-loss rate, the jitter of the arrival time, the rate of failed tags, and how fast carrier and power changed since the last accepted frame. A disguise has to copy all of them, not just the level of one.',
  },
  {
    name: 'Physical layer · χ² engine',
    Icon: OrbitIcon,
    body: `SGP4 and the ITU-R P.618 link budget predict the range, Doppler, power and carrier phase for every second of the pass. Each residual is divided by its natural spread (${NATURAL.timingUs.sigma} µs, ${NATURAL.carrierHz.sigma} Hz, ${NATURAL.powerDb.sigma} dB, ${NATURAL.phaseDeg.sigma}°) and the squares are summed: the sum must stay under ${CHI_SQUARE.gate.toFixed(1)}, the 10⁻⁴ false-alarm quantile of a ${CHI_SQUARE.dof}-degree χ², widened up to 3× near the horizon. A disguise can cost the link at most ${STEALTH.maxSnrLossDb.toFixed(1)} dB overhead and ${STEALTH.atMask.maxSnrLossDb.toFixed(1)} dB at the 2° mask. Range and Doppler must also agree with each other: a delay without the matching Doppler fails the kinematic test, ±${CHI_SQUARE.kinematicGateZ.toFixed(2)}σ, even when the orbit is stale.`,
  },
  {
    name: 'Decision and response',
    Icon: ShieldIcon,
    body: 'Either deterministic layer, data or physical, rejects a frame; the statistical layer alone only holds it for review. A single failure is dropped and resent; two tiers at once (one of them deterministic), or a burst of 3 authentication failures within 10 frames, quarantine the link. A genuine frame whose only anomaly is its power is delivered flagged as degraded, with a jamming alarm. The key is rotated only when the data tier shows a key holder: a valid tag on a foreign hardware token, or on new content under a stale nonce. A rogue carrier, a forged tag, a replay, tampering or jamming never re-keys.',
  },
];

export function Techniques() {
  return (
    <div className="tech">
      {TECHNIQUES.map(({ name, tone, Icon, imitates, how, gains, givesAway }) => (
        <article key={name} className={`tech__card tech__card--${tone}`}>
          <header className="tech__head">
            <span className="tech__icon">
              <Icon size={18} />
            </span>
            <div>
              <h2 className="tech__name">{name}</h2>
              <p className="tech__imitates">imitates {imitates}</p>
            </div>
          </header>
          <dl className="tech__list">
            <dt>How</dt>
            <dd>{how}</dd>
            <dt>What it buys</dt>
            <dd>{gains}</dd>
            <dt>What gives it away</dt>
            <dd>{givesAway}</dd>
          </dl>
        </article>
      ))}
    </div>
  );
}

export function Protection() {
  return (
    <div className="defend">
      <StealthBudget />
      <ol className="layers">
        {LAYERS.map(({ name, Icon, body }, i) => (
          <li key={name} className="layers__item">
            <span className="layers__num mono">{i + 1}</span>
            <div>
              <h2 className="layers__name">
                <Icon size={15} /> {name}
              </h2>
              <p className="layers__body">{body}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
