import { useEffect } from 'react';

import { EngineProvider, useEngineCtx } from './engineContext';
import { AnimatedContent } from './reactbits/AnimatedContent';
import { Aurora } from './reactbits/Aurora';
import { ClickSpark } from './reactbits/ClickSpark';
import { ShinyText } from './reactbits/ShinyText';
import { SATELLITE, STATION_PLACE } from './sim/copy';
import { CARRIER_HZ } from './sim/geometry';
import { useBelowGateLink } from './ui/BelowGate';
import { ControlDeckPanel } from './ui/ControlDeck';
import { Header } from './ui/Header';
import { DishIcon } from './ui/icons';
import { KpiTiles } from './ui/KpiTiles';
import { LedgerPanel } from './ui/Ledger';
import { PacketDrawer } from './ui/PacketDrawer';
import { ResiliencePanel } from './ui/Resilience';
import { TelemetryPanel } from './ui/Telemetry';
import { ThreatMatrixPanel } from './ui/ThreatMatrix';
import { ViewportPanel } from './ui/Viewport';

function Loading() {
  return (
    <div className="loading" role="status">
      <span className="loading__dish">
        <DishIcon size={34} />
      </span>
      <h1 className="loading__title">Secure Ground-Link Testbed</h1>
      <p className="loading__text">
        Training the Isolation Forest on nominal passes · loading the live orbit from CelesTrak ·
        deriving key epochs…
      </p>
      <span className="loading__bar" />
    </div>
  );
}

function SectionHead({
  id,
  index,
  title,
  note,
}: {
  id: string;
  index: string;
  title: string;
  note: string;
}) {
  return (
    <header className="section-head">
      <span className="section-head__index" aria-hidden="true">
        {index}
      </span>
      <div className="section-head__text">
        <h2 className="section-head__title" id={id}>
          {title}
        </h2>
        <p className="section-head__note">{note}</p>
      </div>
    </header>
  );
}

function HeroIntro() {
  return (
    <div className="hero__intro">
      <div className="hero__copy">
        <p className="hero__eyebrow">
          <span className="hero__eyebrow-dot" />
          Live testbed · {STATION_PLACE}
        </p>
        <h1 className="hero__title" id="hero-title">
          See a satellite link <ShinyText>defend itself</ShinyText>.
        </h1>
        <p className="hero__lead">
          A live digital twin of {SATELLITE}’s X-band downlink. Inject an attack, then watch
          cryptography, orbital physics and machine learning decide—frame by frame—what is real.
        </p>
      </div>
      <dl className="hero__facts">
        <div>
          <dt>Downlink</dt>
          <dd>X-band · {(CARRIER_HZ / 1e6).toFixed(1)} MHz</dd>
        </div>
        <div>
          <dt>Spacecraft</dt>
          <dd>{SATELLITE} · SGP4</dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd>Three independent tiers</dd>
        </div>
      </dl>
    </div>
  );
}

function Dashboard() {
  const { focus, setFocus } = useEngineCtx();
  useBelowGateLink();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && focus !== 'overview') setFocus('overview');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, setFocus]);

  return (
    <div className="app app--dashboard">
      <Aurora />
      <ClickSpark />
      <Header />
      <main className="dash-main">
        <section className="hero" aria-labelledby="hero-title">
          <HeroIntro />
          <div className="hero__stage">
            <ViewportPanel />
          </div>
        </section>

        <AnimatedContent>
          <section className="section metrics-section" aria-labelledby="metrics-title">
            <SectionHead
              id="metrics-title"
              index="01"
              title="Session metrics"
              note="Every tile is measured in this browser, on the frames of this session—not a static benchmark."
            />
            <KpiTiles />
          </section>
        </AnimatedContent>

        <AnimatedContent>
          <section className="section" id="command" aria-labelledby="command-title">
            <SectionHead
              id="command-title"
              index="02"
              title="Command & telemetry"
              note="Run one of the attacks below and follow the link from the RF front end to the trust anchor."
            />
            <div className="ops-grid">
              <ControlDeckPanel />
              <TelemetryPanel />
            </div>
          </section>
        </AnimatedContent>

        <AnimatedContent>
          <section className="section" aria-labelledby="trust-title">
            <SectionHead
              id="trust-title"
              index="03"
              title="Trust & resilience"
              note="Three verification tiers, a hash-chained audit ledger and the resilience record they produce together."
            />
            <div className="trust-grid">
              <ThreatMatrixPanel />
              <ResiliencePanel />
              <LedgerPanel />
            </div>
          </section>
        </AnimatedContent>
      </main>
      <PacketDrawer />
    </div>
  );
}

export default function App() {
  return (
    <EngineProvider fallback={<Loading />}>
      <Dashboard />
    </EngineProvider>
  );
}
