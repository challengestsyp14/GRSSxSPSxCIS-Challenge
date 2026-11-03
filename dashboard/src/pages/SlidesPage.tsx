import { useCallback, useEffect, useRef, useState } from 'react';

import { SLIDES } from '../noise/slides';
import { DocPage } from './DocPage';

/** The explainer as still slides: arrows or the thumbnails to move, F for full screen. */
export function SlidesPage() {
  const [at, setAt] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const last = SLIDES.length - 1;
  const go = useCallback((i: number) => setAt(Math.max(0, Math.min(last, i))), [last]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        go(at + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        go(at - 1);
      } else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(last);
      else if (e.key === 'f' || e.key === 'F') void stage.current?.requestFullscreen?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [at, go, last]);

  const slide = SLIDES[at];
  return (
    <DocPage
      path="/slides"
      eyebrow={`Slides · ${SLIDES.length}`}
      lead={
        <>
          How an attacker can imitate the natural noise on the TerraSAR-X downlink, and the idea
          that keeps the ground link safe anyway, in {SLIDES.length} slides. Use the arrow keys or
          the thumbnails; F shows them full screen.
        </>
      }
    >
      <section className="slides" aria-roledescription="carousel" aria-label="Hiding in the noise">
        <div className="slides__stage" ref={stage}>
          <img
            className="slides__image"
            src={slide.src}
            alt={slide.alt}
            width={1920}
            height={1080}
            aria-live="polite"
          />
          <button
            type="button"
            className="slides__nav slides__nav--prev"
            onClick={() => go(at - 1)}
            disabled={at === 0}
            aria-label="Previous slide"
          >
            ‹
          </button>
          <button
            type="button"
            className="slides__nav slides__nav--next"
            onClick={() => go(at + 1)}
            disabled={at === last}
            aria-label="Next slide"
          >
            ›
          </button>
        </div>
        <div className="slides__bar">
          <span className="slides__count mono">
            {at + 1} / {SLIDES.length}
          </span>
          <button
            type="button"
            className="slides__full"
            onClick={() => void stage.current?.requestFullscreen?.()}
          >
            Full screen
          </button>
        </div>
        <ol className="slides__thumbs" aria-label="All slides">
          {SLIDES.map((s, i) => (
            <li key={s.src}>
              <button
                type="button"
                className={`slides__thumb ${i === at ? 'is-on' : ''}`}
                onClick={() => go(i)}
                aria-label={`Slide ${i + 1}`}
                aria-current={i === at ? 'true' : undefined}
              >
                <img src={s.src} alt="" loading="lazy" width={192} height={108} />
              </button>
            </li>
          ))}
        </ol>
        {/* Preload the next slide so the arrows never wait. */}
        {at < last && <link rel="prefetch" href={SLIDES[at + 1].src} />}
      </section>
    </DocPage>
  );
}
