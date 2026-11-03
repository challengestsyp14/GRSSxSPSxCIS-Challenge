// Number formatting with real typographic characters: − (U+2212), µs, a space before units.

export const MINUS = '−';

const sign = (v: number) => (v < 0 ? MINUS : '+');

export function signed(v: number, digits: number, unit: string): string {
  return `${sign(v)}${Math.abs(v).toFixed(digits)} ${unit}`;
}

export function fmtHz(v: number): string {
  return Math.abs(v) >= 1000 ? signed(v / 1000, 2, 'kHz') : signed(v, 1, 'Hz');
}

export function fmtUs(v: number | null): string {
  if (v === null) return 'no frames';
  return Math.abs(v) >= 1000 ? signed(v / 1000, 2, 'ms') : signed(v, 1, 'µs');
}

export const fmtDb = (v: number, digits = 1) =>
  `${v < 0 ? MINUS : ''}${Math.abs(v).toFixed(digits)} dB`;

export function fmtMs(v: number | null): string {
  if (v === null) return '—';
  if (v < 1) return `${Math.round(v * 1000)} µs`;
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
}

export const fmtInt = (v: number) => Math.round(v).toLocaleString('en-US');

export const fmtEpoch = (e: number) => `0x${e.toString(16).toUpperCase()}`;

export function utcClock(date = new Date()): string {
  return date.toISOString().slice(11, 19);
}
