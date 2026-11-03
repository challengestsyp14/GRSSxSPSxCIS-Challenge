import { useEffect, useRef, useState } from 'react';

const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789·/';

export function ScrambleText({ text, className = '' }: { text: string; className?: string }) {
  const [display, setDisplay] = useState(text);
  const previous = useRef(text);

  useEffect(() => {
    if (previous.current === text) return;
    const from = previous.current;
    previous.current = text;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(text);
      return;
    }
    const length = Math.max(from.length, text.length);
    let frame = 0;
    const timer = window.setInterval(() => {
      frame += 1;
      const revealed = Math.floor((frame / 8) * length);
      let next = '';
      for (let index = 0; index < length; index += 1) {
        if (index < revealed) next += text[index] ?? '';
        else next += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      setDisplay(next);
      if (frame >= 8) {
        window.clearInterval(timer);
        setDisplay(text);
      }
    }, 34);
    return () => window.clearInterval(timer);
  }, [text]);

  // Screen readers get the settled text once; the scramble frames are visual only.
  return (
    <span className={className}>
      <span aria-hidden="true">{display}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
