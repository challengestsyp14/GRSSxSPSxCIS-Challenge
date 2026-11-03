import { createContext, useContext, useEffect, useReducer, useState, type ReactNode } from 'react';

import { Engine } from './sim/engine';
import { readFlightPlan } from './sim/fleet';

export type Focus = 'overview' | 'sat' | 'station';

interface Ctx {
  engine: Engine;
  focus: Focus;
  setFocus: (f: Focus) => void;
  /** The packet inspection drawer. */
  inspectorOpen: boolean;
  setInspectorOpen: (open: boolean) => void;
}

const EngineContext = createContext<Ctx | null>(null);

export function EngineProvider({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [focus, setFocus] = useState<Focus>('overview');
  const [inspectorOpen, setInspectorOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Let the loading screen paint before the model trains.
    const id = window.setTimeout(() => {
      void Engine.create(readFlightPlan(window.location.search)).then((e) => {
        if (!cancelled) setEngine(e);
      });
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, []);

  useEffect(() => {
    if (!engine) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      engine.advance((now - last) / 1000);
      last = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  if (!engine) return <>{fallback}</>;
  return (
    <EngineContext.Provider value={{ engine, focus, setFocus, inspectorOpen, setInspectorOpen }}>
      {children}
    </EngineContext.Provider>
  );
}

export function useEngineCtx(): Ctx {
  const ctx = useContext(EngineContext);
  if (!ctx) throw new Error('useEngineCtx must be used inside EngineProvider');
  return ctx;
}

/** Re-renders the calling component at `hz` and on engine events. */
export function useEngine(hz = 10): Engine {
  const { engine } = useEngineCtx();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = window.setInterval(bump, 1000 / hz);
    const off = engine.subscribe(bump);
    return () => {
      window.clearInterval(id);
      off();
    };
  }, [engine, hz]);
  return engine;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}
