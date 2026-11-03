import { useEffect, useState, type CSSProperties } from 'react';

interface Spark {
  id: number;
  x: number;
  y: number;
  angle: number;
  distance: number;
}

export function ClickSpark() {
  const [sparks, setSparks] = useState<Spark[]>([]);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let nextId = 0;
    let counter = 0;
    const timers = new Set<number>();
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      counter += 1;
      const batch: Spark[] = Array.from({ length: 8 }, (_, index) => ({
        id: nextId++,
        x: event.clientX,
        y: event.clientY,
        angle: (360 / 8) * index + Math.random() * 18,
        distance: 22 + Math.random() * 20,
      }));
      setSparks((current) => [...current.slice(-40), ...batch]);
      const timer = window.setTimeout(() => {
        setSparks((current) => current.filter((spark) => !batch.includes(spark)));
        timers.delete(timer);
      }, 520);
      timers.add(timer);
      if (counter % 40 === 0) setSparks((current) => current.slice(-40));
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  return (
    <div className="click-spark" aria-hidden="true">
      {sparks.map((spark) => (
        <span
          key={spark.id}
          className="click-spark__spark"
          style={
            {
              left: spark.x,
              top: spark.y,
              '--spark-angle': `${spark.angle}deg`,
              '--spark-distance': `${spark.distance}px`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
