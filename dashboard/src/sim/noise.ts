// Deterministic noise and easing helpers (port of the demo signal generator).

export function h1(i: number): number {
  let x = Math.imul(i | 0, 0x27d4eb2d) ^ 0x165667b1;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export function vnoise(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = h1(i * 7919 + seed * 104729);
  const b = h1((i + 1) * 7919 + seed * 104729);
  return a + (b - a) * u;
}

export function fbm(x: number, s = 0): number {
  return 0.5 * vnoise(x, s) + 0.3 * vnoise(x * 2.13, s + 17) + 0.2 * vnoise(x * 4.37, s + 31);
}

/** Signed noise, roughly [-1, 1]. */
export const sn = (x: number, s: number): number => (fbm(x, s) - 0.5) * 2;

export const clamp = (x: number, a = 0, b = 1): number => Math.max(a, Math.min(b, x));

export function smooth(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export function easeInOutCubic(x: number): number {
  const t = clamp(x);
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}

export const easeOutCubic = (x: number): number => 1 - (1 - clamp(x)) ** 3;

export const symlog = (v: number, k: number): number =>
  Math.sign(v) * Math.log10(1 + Math.abs(v) / k);

export function win(t: number, a: number, b: number, fi = 0.3, fo = 0.3): number {
  return smooth(a, a + fi, t) * (1 - smooth(b - fo, b, t));
}

/** Small seeded PRNG for reproducible model training and frame payloads. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
