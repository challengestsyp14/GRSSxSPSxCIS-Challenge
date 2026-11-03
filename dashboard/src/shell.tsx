import '@fontsource/space-grotesk/latin-600.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './index.css';
import './topbar.css';

import { StrictMode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { TopBar } from './ui/TopBar';

/** The width the testbed is laid out at, and the frame it must keep to stay on one screen. */
const DESIGN_WIDTH = 1600;
const MIN_HEIGHT = 760;
const MIN_ASPECT = 1.5;

/**
 * Lays the testbed out at a one-screen size (at least 1600 × 760, never narrower than 3:2) and
 * scales it to the space under the top bar: zoomed out on a small window, up on a large one,
 * letterboxed when the window is taller than 3:2.
 */
function fitTestbed(width: number, height: number) {
  let scale = width / DESIGN_WIDTH;
  let w = DESIGN_WIDTH;
  let h = height / scale;
  if (h < MIN_HEIGHT) {
    scale = height / MIN_HEIGHT;
    h = MIN_HEIGHT;
    w = width / scale;
  }
  // Whole pixels, a little inside 3:2, so the testbed's one-screen layout always applies.
  w = Math.floor(w);
  h = Math.floor(Math.min(h, w / MIN_ASPECT - 2));
  return {
    scale,
    width: w,
    height: h,
    left: (width - w * scale) / 2,
    top: Math.max(0, (height - h * scale) / 2),
  };
}

function Stage() {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // The query (a satellite, a pass, a below-the-gate jam) goes on to the testbed.
  const src = useMemo(() => `/testbed.html${window.location.search}${window.location.hash}`, []);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fit = fitTestbed(size.width, size.height);
  return (
    <main className="shell__stage" ref={box}>
      {size.width > 0 && (
        <iframe
          className="shell__frame"
          title="Live testbed"
          src={src}
          allow="fullscreen"
          style={{
            width: fit.width,
            height: fit.height,
            transform: `translate(${fit.left}px, ${fit.top}px) scale(${fit.scale})`,
          }}
          onLoad={(e) => e.currentTarget.focus()}
        />
      )}
    </main>
  );
}

const container = document.getElementById('root');

if (!container) {
  throw new Error('Root container #root was not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <div className="shell">
      <TopBar current="/" />
      <Stage />
    </div>
  </StrictMode>,
);
