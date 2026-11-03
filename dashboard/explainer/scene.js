// "Hiding in the noise" explainer. Every frame is drawn on a canvas as a pure function of time,
// so a render is reproducible frame for frame. Scene and caption timings come from
// src/noise/explainer.json (written by narrate.py). Figures on screen are the ones in
// src/sim/linkFacts.ts, and the natural noise is the dashboard's own model (src/sim/signals.ts).

const W = 1920;
const H = 1080;
const M = 120;

const C = {
  bg0: '#04070C',
  bg1: '#0A1019',
  bg2: '#0E1621',
  line: '#1E2B3A',
  text0: '#ECF2F8',
  text1: '#A3B2C4',
  text2: '#7D8EA3',
  text3: '#404F61',
  accent: '#4CC9F0',
  ok: '#34D399',
  warn: '#FBBF24',
  bad: '#F8485E',
  jam: '#A78BFA',
  tamper: '#F472B6',
  gold: '#D9A441',
};

const DISPLAY = (w, s) => `${w} ${s}px "Space Grotesk", sans-serif`;
const UI = (w, s) => `${w} ${s}px Inter, sans-serif`;
const MONO = (w, s) => `${w} ${s}px "JetBrains Mono", monospace`;

// Signal facts, as in src/sim/linkFacts.ts (tests/sim.test.ts pins them).
const F = {
  carrierMHz: 8477.8,
  altitudeKm: 514,
  dopplerKHz: 199.0,
  rxMask: -88.8,
  rxZenith: -74.4,
  ampMask: 11.4,
  ampZenith: 60.0,
  floor: -100,
  noiseUv: 2.24,
  snrMask: 11.2,
  snrZenith: 25.6,
  /** Noise above the thermal floor at which the power residual alone fires the χ² gate. */
  stealthDb: -5.3,
  /** SNR that noise costs at that point: 0.23 dB × √23.5. */
  stealthLossDb: 1.1,
  chiGate: 23.5,
  kinematicZ: 3.89,
  boxBandDb: 4,
};

/** ITU-R P.618 median atmosphere from the digital twin (src/data/p618.json), loaded in init(). */
let P618 = { elevationDeg: [0, 90], totalDb: [0, 0] };
function atmosDb(el) {
  const els = P618.elevationDeg;
  const db = P618.totalDb;
  const e = clamp(el, els[0], els[els.length - 1]);
  let i = 1;
  while (i < els.length - 1 && els[i] < e) i++;
  return db[i - 1] + ((e - els[i - 1]) / (els[i] - els[i - 1])) * (db[i] - db[i - 1]);
}

// ---------------------------------------------------------------- maths

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOut = (x) => 1 - (1 - clamp(x)) ** 3;
const easeInOut = (x) => {
  const t = clamp(x);
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
};

function h1(i) {
  let x = Math.imul(i | 0, 0x27d4eb2d) ^ 0x165667b1;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
const h2 = (a, b) => h1(Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663));
function gauss(i) {
  const u = h1(i * 2 + 11) || 1e-9;
  const v = h1(i * 2 + 12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// The dashboard's smooth noise (src/sim/noise.ts) and natural residuals (src/sim/signals.ts).
function vnoise(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = h1(i * 7919 + seed * 104729);
  const b = h1((i + 1) * 7919 + seed * 104729);
  return a + (b - a) * u;
}
const fbm = (x, s) =>
  0.5 * vnoise(x, s) + 0.3 * vnoise(x * 2.13, s + 17) + 0.2 * vnoise(x * 4.37, s + 31);
const sn = (x, s) => (fbm(x, s) - 0.5) * 2;
const natCarrier = (s) => 7 * Math.sin(s * 1.9) + 11 * sn(s * 2.4, 11) + 4 * sn(s * 9, 12);
const natPower = (s) => 0.7 * sn(s * 2.6, 31) + 0.3 * sn(s * 11, 33);
const natTiming = (s) => 2 * Math.sin(s * 2.3) + 2.4 * sn(s * 3, 21) + 0.8 * sn(s * 11, 24);

// Pass geometry and link budget (src/sim/geometry.ts).
const RE = 6371;
const RO = RE + F.altitudeKm;
const OMEGA = 1 / Math.sqrt(RO ** 3 / 398600.4418);
const CKMS = 299792.458;
function geo(phi) {
  const range = Math.sqrt(RE * RE + RO * RO - 2 * RE * RO * Math.cos(phi));
  const el = (Math.atan2(RO * Math.cos(phi) - RE, RO * Math.abs(Math.sin(phi))) * 180) / Math.PI;
  const rr = (RE * RO * Math.sin(phi) * OMEGA) / range;
  return { range, el, dopKHz: (-F.carrierMHz * 1e3 * rr) / CKMS };
}
const snrAt = (range, el) =>
  18 -
  (20 * Math.log10(range) + 20 * Math.log10(F.carrierMHz) + 32.44) -
  atmosDb(el) -
  2 +
  31 +
  228.6 -
  10 * Math.log10(300e6);
const PHI_MASK = (() => {
  let lo = 0;
  let hi = Math.acos(RE / RO);
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (geo(mid).el > 2) lo = mid;
    else hi = mid;
  }
  return lo;
})();
/** Pass state from mask rise (u = 0) to mask set (u = 1). */
function passAt(u) {
  const g = geo((2 * clamp(u) - 1) * PHI_MASK);
  return { ...g, snr: snrAt(g.range, g.el) };
}
const peakUv = (dbm) => Math.sqrt(2 * 10 ** (dbm / 10) * 1e-3 * 50) * 1e6;
const snrLoss = (above) => 10 * Math.log10(1 + 10 ** (above / 10));

// ---------------------------------------------------------------- drawing helpers

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** Typographic minus for negative numbers ("-88" becomes "−88"); hyphenated words are untouched. */
const minus = (str) => String(str).replace(/(^|[\s(→±])-(?=\d)/g, '$1−');

function text(ctx, str, x, y, font, color, align = 'left', spacing = 0) {
  str = minus(str);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(str, x, y);
  ctx.letterSpacing = '0px';
}

function wrap(ctx, str, font, maxW) {
  ctx.font = font;
  const out = [];
  let line = '';
  for (const word of str.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxW && line) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

function para(ctx, str, x, y, maxW, lineH, font, color) {
  const lines = wrap(ctx, str, font, maxW);
  lines.forEach((l, i) => text(ctx, l, x, y + i * lineH, font, color));
  return lines.length * lineH;
}

/** Draws `fn` faded and lifted in from time `at` (local seconds). */
function rise(ctx, lt, at, fn, dur = 0.7, lift = 26) {
  const p = easeOut((lt - at) / dur);
  if (p <= 0) return;
  ctx.save();
  ctx.globalAlpha *= p;
  ctx.translate(0, (1 - p) * lift);
  fn();
  ctx.restore();
}

function box(ctx, x, y, w, h, { fill = C.bg2, stroke = C.line, r = 14, lw = 1.5 } = {}) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
}

function dashed(ctx, x0, y0, x1, y1, color, lw = 2, dash = [10, 8]) {
  ctx.save();
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
}

function polyline(ctx, pts, color, lw = 2.5) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function chip(ctx, str, x, y, color, { align = 'left', size = 24 } = {}) {
  ctx.font = MONO(700, size);
  ctx.letterSpacing = '1px';
  const w = ctx.measureText(str).width + 36;
  ctx.letterSpacing = '0px';
  const x0 = align === 'right' ? x - w : x;
  box(ctx, x0, y - size - 12, w, size + 26, {
    fill: hexA(color, 0.14),
    stroke: color,
    r: 10,
    lw: 2,
  });
  text(ctx, str, x0 + 18, y + 2, MONO(700, size), color, 'left', 1);
  return w;
}

function check(ctx, x, y, s, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.16;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - s * 0.35, y);
  ctx.lineTo(x - s * 0.08, y + s * 0.28);
  ctx.lineTo(x + s * 0.4, y - s * 0.3);
  ctx.stroke();
}

function cross(ctx, x, y, s, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.16;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - s * 0.3, y - s * 0.3);
  ctx.lineTo(x + s * 0.3, y + s * 0.3);
  ctx.moveTo(x + s * 0.3, y - s * 0.3);
  ctx.lineTo(x - s * 0.3, y + s * 0.3);
  ctx.stroke();
}

/** A chart frame; returns value → pixel maps. */
function axes(ctx, a) {
  const { x, y, w, h, xmin, xmax, ymin, ymax } = a;
  const X = (v) => x + ((v - xmin) / (xmax - xmin)) * w;
  const Y = (v) => y + h - ((v - ymin) / (ymax - ymin)) * h;
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  for (const v of a.yticks ?? []) {
    ctx.beginPath();
    ctx.moveTo(x, Y(v));
    ctx.lineTo(x + w, Y(v));
    ctx.stroke();
    text(ctx, a.yfmt ? a.yfmt(v) : String(v), x - 14, Y(v) + 7, MONO(500, 20), C.text2, 'right');
  }
  for (const v of a.xticks ?? []) {
    ctx.beginPath();
    ctx.moveTo(X(v), y);
    ctx.lineTo(X(v), y + h);
    ctx.stroke();
    text(ctx, a.xfmt ? a.xfmt(v) : String(v), X(v), y + h + 32, MONO(500, 20), C.text2, 'center');
  }
  if (a.xlabel) text(ctx, a.xlabel, x + w, y + h + 66, UI(400, 22), C.text1, 'right');
  if (a.ylabel) text(ctx, a.ylabel, x, y - 18, UI(400, 22), C.text1, 'left');
  return { X, Y };
}

function heading(ctx, lt, n, eyebrow, title) {
  rise(ctx, lt, 0, () => {
    text(ctx, `${n} · ${eyebrow}`.toUpperCase(), M, 112, MONO(700, 24), C.accent, 'left', 3);
    text(ctx, title, M, 190, DISPLAY(700, 60), C.text0);
  });
}

function tile(ctx, x, y, w, h, title, value, sub, color = C.accent) {
  box(ctx, x, y, w, h, { fill: C.bg2, stroke: C.line });
  ctx.fillStyle = color;
  ctx.fillRect(x, y + 18, 4, h - 36);
  text(ctx, title, x + 28, y + 40, MONO(500, 20), C.text2, 'left', 2);
  text(ctx, value, x + 28, y + 92, MONO(700, 44), C.text0);
  text(ctx, sub, x + 28, y + 128, UI(400, 23), C.text1);
}

// ---------------------------------------------------------------- shared visuals

function background(ctx, t) {
  ctx.fillStyle = C.bg0;
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(1560, 60, 0, 1560, 60, 1400);
  g.addColorStop(0, 'rgba(32,70,104,0.42)');
  g.addColorStop(1, 'rgba(4,7,12,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 240; i++) {
    const x = h1(i * 3 + 1) * W;
    const y = h1(i * 3 + 2) * H;
    const tw = 0.5 + 0.5 * Math.sin(t * (0.5 + h1(i * 3 + 3) * 1.3) + i);
    ctx.fillStyle = `rgba(206,230,255,${0.05 + 0.2 * tw * h1(i * 7 + 5)})`;
    ctx.fillRect(x, y, 2, 2);
  }
}

/** Set while a slide is drawn: its number replaces the timeline at the foot. */
let SLIDE = null;

function chrome(ctx, t, tl, scene) {
  if (scene.id !== 'intro') {
    text(
      ctx,
      'TSYP14 · TRACK 1 · SECURE GROUND-LINK TESTBED',
      W - M,
      112,
      MONO(500, 20),
      C.text2,
      'right',
      2,
    );
  }
  const x0 = M;
  const x1 = W - M;
  const y = 1022;
  if (SLIDE) {
    ctx.fillStyle = C.line;
    ctx.fillRect(x0, y, x1 - x0, 1);
    text(ctx, scene.chapter, x0, y + 40, UI(600, 20), C.text2);
    text(ctx, SLIDE, x1, y + 40, MONO(500, 20), C.text2, 'right', 2);
    return;
  }
  ctx.fillStyle = C.line;
  ctx.fillRect(x0, y, x1 - x0, 4);
  ctx.fillStyle = C.accent;
  ctx.fillRect(x0, y, ((x1 - x0) * t) / tl.duration, 4);
  for (const s of tl.scenes.slice(1)) {
    ctx.fillStyle = C.text3;
    ctx.fillRect(x0 + ((x1 - x0) * s.start) / tl.duration - 1, y - 6, 2, 16);
  }
  text(ctx, scene.chapter, x0, y + 40, UI(600, 20), C.text2);
}

/** Thermal noise as an analyser shows it: exponential power per bin, averaged over four sweeps. */
function noiseDb(bin, q, floorDb) {
  let p = 0;
  for (let k = 0; k < 4; k++) p += -Math.log(1 - h2(bin * 4 + k, q) * 0.999999);
  return floorDb + 10 * Math.log10(p / 4);
}
const bandShape = (offMHz, widthMHz) => 1 / (1 + ((2 * offMHz) / widthMHz) ** 8);

function spectrum(ctx, a, levelDbm, floorDbm, q, color = C.accent, extra = null) {
  const { X, Y } = a;
  const n = 260;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = a.fmin + ((a.fmax - a.fmin) * i) / n;
    let p = 10 ** (noiseDb(i, q, floorDbm) / 10);
    if (levelDbm !== null) p += 10 ** (levelDbm / 10) * bandShape(f - a.center, 6);
    if (extra) p += extra(f);
    pts.push([X(f), Y(Math.max(a.ymin, Math.min(a.ymax, 10 * Math.log10(p))))]);
  }
  ctx.save();
  const grad = ctx.createLinearGradient(0, Y(a.ymax), 0, Y(a.ymin));
  grad.addColorStop(0, hexA(color, 0.35));
  grad.addColorStop(1, hexA(color, 0.02));
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.lineTo(pts[pts.length - 1][0], Y(a.ymin));
  ctx.lineTo(pts[0][0], Y(a.ymin));
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();
  polyline(ctx, pts, color, 2.2);
}

// TerraSAR-X from the side: the hexagonal body with solar cells on its upper facet, the
// radar antenna along its lower facet, gold end bulkheads and the downlink antenna on a boom.
function satellite(ctx, x, y, ang, s = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.scale(s, s);
  ctx.lineWidth = 1.5;
  // Upper facet: solar cells.
  ctx.fillStyle = '#2A5D8F';
  ctx.strokeStyle = '#7FB6E8';
  ctx.fillRect(-58, -20, 116, 13);
  ctx.beginPath();
  for (let i = -58 + 14.5; i < 58; i += 14.5) {
    ctx.moveTo(i, -20);
    ctx.lineTo(i, -7);
  }
  ctx.stroke();
  // Middle facet: silver insulation.
  ctx.fillStyle = '#C8D0DA';
  ctx.fillRect(-58, -7, 116, 14);
  // Lower facet: the phased-array radar antenna.
  ctx.fillStyle = '#E8EEF4';
  ctx.fillRect(-58, 7, 116, 13);
  ctx.strokeStyle = '#5B6573';
  ctx.beginPath();
  for (let i = -58 + 9.7; i < 58; i += 9.7) {
    ctx.moveTo(i, 7);
    ctx.lineTo(i, 20);
  }
  ctx.stroke();
  // Gold end bulkheads.
  ctx.fillStyle = C.gold;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * 58, -20);
    ctx.lineTo(side * 64, -14);
    ctx.lineTo(side * 64, 14);
    ctx.lineTo(side * 58, 20);
    ctx.closePath();
    ctx.fill();
  }
  // Downlink antenna on its boom.
  ctx.strokeStyle = '#E8EEF4';
  ctx.beginPath();
  ctx.moveTo(-26, 20);
  ctx.lineTo(-26, 44);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-26, 52, 8, Math.PI, 0);
  ctx.stroke();
  ctx.restore();
}

function dish(ctx, x, y, s = 1, color = C.text0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-14, 0);
  ctx.lineTo(14, 0);
  ctx.lineTo(4, -18);
  ctx.lineTo(-4, -18);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, -30, 24, 11, -0.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -30);
  ctx.lineTo(12, -50);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------- scenes

function intro(ctx, lt, sc, t) {
  const cx = 960;
  const cy = 2050;
  const R = 1350;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  const eg = ctx.createRadialGradient(cx + 300, cy - R, 40, cx, cy, R);
  eg.addColorStop(0, '#16405F');
  eg.addColorStop(0.5, '#0B2033');
  eg.addColorStop(1, '#050C14');
  ctx.fillStyle = eg;
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = 'rgba(76,201,240,0.09)';
  ctx.lineWidth = 1.5;
  for (let k = 1; k <= 5; k++) {
    ctx.beginPath();
    ctx.arc(cx, cy, R - k * 62, Math.PI, 2 * Math.PI);
    ctx.stroke();
  }
  for (let k = -6; k <= 6; k++) {
    ctx.beginPath();
    ctx.ellipse(cx + k * 40, cy, Math.abs(k) * 150 + 40, R, 0, Math.PI, 2 * Math.PI);
    ctx.stroke();
  }
  ctx.restore();
  for (let i = 0; i < 12; i++) {
    ctx.beginPath();
    ctx.arc(cx, cy, R + i * 3.5, Math.PI * 1.02, Math.PI * 1.98);
    ctx.strokeStyle = `rgba(76,201,240,${0.22 - i * 0.018})`;
    ctx.lineWidth = 5;
    ctx.stroke();
  }

  const as = 0.05;
  const st = [cx + R * Math.sin(as), cy - R * Math.cos(as)];
  const RO2 = R + 390;
  ctx.save();
  ctx.setLineDash([3, 12]);
  ctx.strokeStyle = 'rgba(163,178,196,0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, RO2, -Math.PI / 2 + 0.05, -Math.PI / 2 + 0.62);
  ctx.stroke();
  ctx.restore();
  const a = lerp(0.2, 0.44, lt / sc.dur);
  const sat = [cx + RO2 * Math.sin(a), cy - RO2 * Math.cos(a)];

  // The downlink, with pulses travelling down it.
  const bg = ctx.createLinearGradient(sat[0], sat[1], st[0], st[1]);
  bg.addColorStop(0, hexA(C.accent, 0.95));
  bg.addColorStop(1, hexA(C.accent, 0.35));
  ctx.strokeStyle = bg;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(sat[0], sat[1]);
  ctx.lineTo(st[0], st[1] - 40);
  ctx.stroke();
  for (let k = 0; k < 6; k++) {
    const u = (t * 0.45 + k / 6) % 1;
    ctx.fillStyle = hexA(C.accent, 0.9 * (1 - u));
    ctx.beginPath();
    ctx.arc(lerp(sat[0], st[0], u), lerp(sat[1], st[1] - 40, u), 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Natural noise around the link: snow refreshed 15 times a second.
  const q = Math.floor(t * 15);
  const attackA = smooth(sc.cues[1].s - 0.3, sc.cues[1].s + 0.8, lt);
  for (let i = 0; i < 900; i++) {
    const u = h1(i * 5 + 1);
    const off = (h1(i * 5 + 2) - 0.5) * 360;
    const px = lerp(sat[0], st[0], u) + off * 0.55 + (h2(i, q) - 0.5) * 18;
    const py = lerp(sat[1], st[1] - 40, u) + off + (h2(i + 7, q) - 0.5) * 18;
    const red = i % 9 === 0 && Math.abs(u - 0.5) < 0.22;
    const al = 0.1 + 0.4 * h2(i + 13, q);
    ctx.fillStyle =
      red && attackA > 0 ? hexA(C.bad, al + 0.4 * attackA) : `rgba(163,178,196,${al})`;
    ctx.fillRect(px, py, red && attackA > 0 ? 4 : 2.5, red && attackA > 0 ? 4 : 2.5);
  }
  satellite(ctx, sat[0], sat[1], a, 1);
  dish(ctx, st[0], st[1], 1.1, C.text0);
  text(
    ctx,
    `TerraSAR-X · ${F.altitudeKm} km`,
    sat[0] - 70,
    sat[1] - 48,
    MONO(500, 22),
    C.text1,
    'left',
  );
  text(ctx, 'Zaghouan ground station', st[0] - 30, st[1] + 52, MONO(500, 22), C.text1, 'left');

  if (attackA > 0) {
    ctx.save();
    ctx.globalAlpha *= attackA;
    const mx = lerp(sat[0], st[0], 0.5);
    const my = lerp(sat[1], st[1] - 40, 0.5);
    ctx.strokeStyle = hexA(C.bad, 0.8);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mx, my, 70, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(mx + 50, my + 50);
    ctx.lineTo(mx + 120, my + 120);
    ctx.stroke();
    text(ctx, 'an attack shaped like noise', mx + 130, my + 132, MONO(700, 24), C.bad);
    ctx.restore();
  }
  const caught = smooth(sc.cues[2].s + 1.2, sc.cues[2].s + 2, lt);
  if (caught > 0) {
    ctx.save();
    ctx.globalAlpha *= caught;
    ctx.beginPath();
    ctx.arc(st[0] - 70, st[1] - 30, 30, 0, Math.PI * 2);
    ctx.fillStyle = hexA(C.ok, 0.18);
    ctx.fill();
    ctx.strokeStyle = C.ok;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    check(ctx, st[0] - 70, st[1] - 30, 34, C.ok);
    text(ctx, 'caught at the station', st[0] - 30, st[1] + 86, MONO(700, 22), C.ok);
    ctx.restore();
  }

  rise(ctx, lt, 0.3, () =>
    text(
      ctx,
      'TSYP14 · TRACK 1 · SECURE GROUND-LINK TESTBED',
      M,
      230,
      MONO(700, 24),
      C.accent,
      'left',
      3,
    ),
  );
  rise(ctx, lt, 0.6, () => {
    text(ctx, 'Hiding in', M, 370, DISPLAY(700, 136), C.text0);
    text(ctx, 'the noise', M, 510, DISPLAY(700, 136), C.text0);
  });
  rise(ctx, lt, 1.2, () =>
    para(
      ctx,
      'How an attacker can imitate natural noise on a satellite downlink, and why our testbed still catches it.',
      M,
      590,
      780,
      48,
      UI(400, 36),
      C.text1,
    ),
  );
}

function signal(ctx, lt, sc, t) {
  heading(ctx, lt, '01', 'The signal we chose', 'A fixed X-band carrier, moved only by Doppler');
  const u = clamp(lt / sc.dur) * 0.96 + 0.02;
  const p = passAt(u);
  const level = F.floor + p.snr;
  const q = Math.floor(t * 12);

  rise(ctx, lt, 0.3, () => {
    box(ctx, M, 240, 960, 380);
    text(ctx, 'Received spectrum at Zaghouan', M + 28, 284, UI(600, 26), C.text0);
    text(ctx, 'power (dBm) vs frequency (MHz)', M + 28, 316, UI(400, 22), C.text2);
    const a = {
      x: M + 110,
      y: 340,
      w: 820,
      h: 210,
      xmin: -20,
      xmax: 20,
      ymin: -106,
      ymax: -66,
      xticks: [-20, -10, 0, 10, 20],
      yticks: [-100, -90, -80, -70],
      xfmt: (v) => (F.carrierMHz + v).toFixed(1),
    };
    const { X, Y } = axes(ctx, a);
    spectrum(
      ctx,
      { X, Y, fmin: -20, fmax: 20, center: p.dopKHz / 1e3, ymin: -106, ymax: -66 },
      level,
      F.floor,
      q,
    );
    dashed(ctx, X(-20), Y(level), X(20), Y(level), hexA(C.accent, 0.6), 1.5, [6, 6]);
    text(ctx, `${level.toFixed(1)} dBm`, X(3.6), Y(level) - 12, MONO(700, 22), C.accent);
    text(ctx, 'QPSK · 6 MHz', X(-3), Y(level) - 12, MONO(500, 20), C.text1, 'right');
    text(ctx, 'noise floor −100 dBm', X(-19.4), Y(-91), MONO(500, 20), C.text1);
  });

  rise(ctx, lt, 0.6, () => {
    box(ctx, M, 640, 960, 310);
    text(ctx, 'The same carrier in time', M + 28, 684, UI(600, 26), C.text0);
    text(
      ctx,
      'voltage at the 50 Ω receiver input · time not to scale',
      M + 28,
      716,
      UI(400, 22),
      C.text2,
    );
    const a = {
      x: M + 110,
      y: 740,
      w: 820,
      h: 180,
      xmin: 0,
      xmax: 1,
      ymin: -65,
      ymax: 65,
      yticks: [-50, 0, 50],
      yfmt: (v) => `${v} µV`,
    };
    const { X, Y } = axes(ctx, a);
    const A = peakUv(level);
    const pts = [];
    for (let i = 0; i <= 820; i++) {
      const x = i / 820;
      const v = A * Math.sin(2 * Math.PI * (14 * x - t * 0.8)) + F.noiseUv * gauss(i * 31 + q);
      pts.push([X(x), Y(v)]);
    }
    polyline(ctx, pts, C.accent, 2);
    const ax = X(0.94);
    dashed(ctx, X(0), Y(A), X(1), Y(A), hexA(C.text0, 0.35), 1.2, [5, 6]);
    ctx.strokeStyle = C.text0;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ax, Y(0));
    ctx.lineTo(ax, Y(A));
    ctx.stroke();
    text(ctx, `A = ${A.toFixed(1)} µV peak`, ax - 16, Y(A) - 12, MONO(700, 22), C.text0, 'right');
  });

  const tiles = [
    ['CARRIER', `${F.carrierMHz} MHz`, `X-band · fixed · orbit ${F.altitudeKm} km`],
    ['DOPPLER', `±${F.dopplerKHz} kHz`, 'predicted from the orbit, not random'],
    [
      'RECEIVED POWER',
      `${F.rxMask.toFixed(1)} → ${F.rxZenith} dBm`,
      `amplitude ${F.ampMask.toFixed(1)} → ${F.ampZenith.toFixed(1)} µV peak · 50 Ω`,
    ],
    [
      'NOISE FLOOR',
      `${F.floor} dBm`,
      `${F.noiseUv} µV rms · SNR ${F.snrMask.toFixed(1)} → ${F.snrZenith} dB`,
    ],
  ];
  tiles.forEach(([title, value, sub], i) =>
    rise(ctx, lt, sc.cues[i].s, () => {
      const y = 240 + i * 182;
      tile(ctx, 1150, y, 650, 162, title, value, sub);
      if (i === 1) {
        const x0 = 1600;
        const w = 170;
        const yy = y + 30;
        const hh = 100;
        ctx.strokeStyle = C.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, yy + hh / 2);
        ctx.lineTo(x0 + w, yy + hh / 2);
        ctx.stroke();
        const pts = [];
        for (let k = 0; k <= 60; k++)
          pts.push([x0 + (w * k) / 60, yy + hh / 2 - (passAt(k / 60).dopKHz / 200) * (hh / 2)]);
        polyline(ctx, pts, C.accent, 2.5);
        ctx.fillStyle = C.text0;
        ctx.beginPath();
        ctx.arc(x0 + w * u, yy + hh / 2 - (p.dopKHz / 200) * (hh / 2), 6, 0, Math.PI * 2);
        ctx.fill();
        text(
          ctx,
          `${p.dopKHz >= 0 ? '+' : '−'}${Math.abs(p.dopKHz).toFixed(1)} kHz`,
          x0 + w,
          yy + hh + 26,
          MONO(500, 19),
          C.text1,
          'right',
        );
      }
    }),
  );
}

function natural(ctx, lt, sc, t) {
  heading(ctx, lt, '02', 'What natural noise looks like', 'Natural noise has a signature');

  rise(ctx, lt, 0.2, () => {
    box(ctx, M, 240, 650, 710);
    text(ctx, 'Thermal noise', M + 28, 288, UI(600, 28), C.text0);
    text(ctx, 'Gaussian and white', M + 28, 322, UI(400, 24), C.text1);
    const x0 = M + 40;
    const w = 570;
    const y0 = 760;
    const hgt = 380;
    const bins = new Array(31).fill(0);
    const n = Math.floor(clamp((lt - sc.cues[1].s + 1.5) / 5) * 6000);
    for (let i = 0; i < n; i++) {
      const b = Math.round(gauss(i) / 0.22) + 15;
      if (b >= 0 && b < 31) bins[b]++;
    }
    const peak = 6000 * 0.22 * 0.3989;
    const bw = w / 31;
    bins.forEach((c, b) => {
      const hh = (c / peak) * hgt * 0.92;
      ctx.fillStyle = hexA(C.accent, 0.55);
      ctx.fillRect(x0 + b * bw + 2, y0 - hh, bw - 4, hh);
    });
    if (n > 2500) {
      ctx.save();
      ctx.globalAlpha *= smooth(2500, 4500, n);
      const pts = [];
      for (let k = 0; k <= 120; k++) {
        const z = (k / 120) * 31 * 0.22 - 15.5 * 0.22;
        pts.push([x0 + (k / 120) * w, y0 - Math.exp(-0.5 * z * z) * hgt * 0.92]);
      }
      polyline(ctx, pts, C.text0, 2.5);
      ctx.restore();
    }
    ctx.fillStyle = C.line;
    ctx.fillRect(x0, y0, w, 2);
    text(ctx, 'voltage samples, in units of σ', x0, y0 + 36, UI(400, 22), C.text2);
    const q = Math.floor(t * 12);
    const pts = [];
    for (let i = 0; i <= 120; i++) pts.push([x0 + (w * i) / 120, 878 - (noiseDb(i, q, 0) + 2) * 3]);
    polyline(ctx, pts, hexA(C.text1, 0.8), 1.6);
    text(ctx, 'flat floor across the band', x0, 930, UI(400, 22), C.text2);
  });

  const strips = [
    ['Carrier vs orbit model', 'Hz', 40, 30, 19, 6.1, natCarrier, (v) => `${v}`],
    ['Power vs link budget', 'dB', 1.5, 1.1, 0.82, 0.23, natPower, (v) => `${v}`],
    ['Frame timing', 'µs', 10, 7.8, 4.5, 1.6, natTiming, (v) => `${v}`],
  ];
  const envA = smooth(sc.cues[2].s, sc.cues[2].s + 1, lt);
  const hide = smooth(sc.cues[3].s, sc.cues[3].s + 0.8, lt);
  strips.forEach(([title, unit, range, gate, max, sigma, fn], i) =>
    rise(ctx, lt, 0.5 + i * 0.25, () => {
      const y = 240 + i * 240;
      box(ctx, 800, y, 1000, 222);
      text(ctx, `${title} (${unit})`, 828, y + 40, UI(600, 24), C.text0);
      const a = {
        x: 900,
        y: y + 56,
        w: 640,
        h: 140,
        xmin: 0,
        xmax: 1,
        ymin: -range,
        ymax: range,
        yticks: [-gate, 0, gate],
      };
      const { X, Y } = axes(ctx, a);
      if (envA > 0) {
        ctx.fillStyle = hexA(hide > 0 ? C.warn : C.accent, 0.12 * envA + 0.08 * hide);
        ctx.fillRect(X(0), Y(max), 640, Y(-max) - Y(max));
        if (hide > 0) {
          ctx.strokeStyle = hexA(C.warn, hide);
          ctx.lineWidth = 2;
          ctx.strokeRect(X(0), Y(max), 640, Y(-max) - Y(max));
        }
      }
      dashed(ctx, X(0), Y(gate), X(1), Y(gate), C.bad, 2);
      dashed(ctx, X(0), Y(-gate), X(1), Y(-gate), C.bad, 2);
      const pts = [];
      for (let k = 0; k <= 320; k++) {
        const s = t * 1.2 - 10 + (k / 320) * 10;
        pts.push([X(k / 320), Y(fn(s))]);
      }
      polyline(ctx, pts, C.accent, 2.2);
      text(ctx, `χ² alone ±${gate}`, 1560, Y(gate) + 7, MONO(700, 20), C.bad);
      ctx.save();
      ctx.globalAlpha *= envA;
      text(ctx, `σ ${sigma} ${unit}`, 1560, y + 128, MONO(500, 20), C.text1);
      text(ctx, `max ${max} ${unit}`, 1560, y + 158, MONO(500, 20), C.text1);
      ctx.restore();
    }),
  );
  if (hide > 0) {
    ctx.save();
    ctx.globalAlpha *= hide;
    text(ctx, 'The narrow envelope an attacker must hide in', 800, 990, MONO(700, 24), C.warn);
    ctx.restore();
  }
}

function imitate(ctx, lt, sc, t) {
  heading(ctx, lt, '03', 'How an attacker imitates it', 'Three ways to look like nature');
  const cards = [
    [
      'Noise-shaped jamming',
      'imitates thermal noise and rain fade',
      C.jam,
      'Gaussian, white, ramped slowly: no spike to see.',
    ],
    [
      'Fade-mimicking spoofing',
      'imitates fading and Doppler',
      C.warn,
      'Node 0x99A2 stays inside a ±4 dB band.',
    ],
    [
      'Bit flips like bit errors',
      'imitates random channel errors',
      C.tamper,
      'The checksum is fine; the bits are not.',
    ],
  ];
  const q = Math.floor(t * 12);
  cards.forEach(([title, sub, color, foot], i) => {
    const cue = sc.cues[i];
    const active = lt >= cue.s && (i === 2 || lt < sc.cues[i + 1].s);
    const x = M + i * 568;
    rise(ctx, lt, cue.s - 0.2, () => {
      ctx.save();
      if (!active) ctx.globalAlpha *= 0.55;
      box(ctx, x, 240, 544, 720, {
        fill: C.bg2,
        stroke: active ? color : C.line,
        lw: active ? 3 : 1.5,
      });
      box(ctx, x + 28, 270, 52, 52, { fill: hexA(color, 0.16), stroke: color, r: 10 });
      text(ctx, String(i + 1), x + 54, 308, MONO(700, 28), color, 'center');
      text(ctx, title, x + 98, 304, UI(600, 30), C.text0);
      text(ctx, sub, x + 28, 368, UI(400, 24), C.text1);
      const lt2 = lt - cue.s;
      const vx = x + 28;
      const vy = 400;
      const vw = 488;
      const vh = 380;
      box(ctx, vx, vy, vw, vh, { fill: C.bg1, stroke: C.line, r: 10 });
      if (i === 0) {
        const rise2 = easeInOut(lt2 / Math.max(1, cue.e - cue.s));
        const above = lerp(-12, F.stealthDb, rise2);
        const floor = F.floor + 10 * Math.log10(1 + 10 ** (above / 10));
        const a = {
          X: (f) => vx + 20 + ((f + 12) / 24) * (vw - 40),
          Y: (v) => vy + 40 + ((-70 - v) / 40) * 250,
          fmin: -12,
          fmax: 12,
          center: 0,
          ymin: -110,
          ymax: -70,
        };
        spectrum(ctx, a, -84, floor, q, C.jam);
        dashed(
          ctx,
          vx + 20,
          a.Y(F.floor),
          vx + vw - 20,
          a.Y(F.floor),
          hexA(C.text1, 0.6),
          1.5,
          [6, 6],
        );
        text(ctx, 'dashed: thermal floor', vx + 24, vy + 36, MONO(500, 19), C.text2);
        const loss = snrLoss(above);
        text(
          ctx,
          `jammer ${above >= 0 ? '+' : '-'}${Math.abs(above).toFixed(1)} dB vs thermal`,
          vx + 24,
          vy + vh - 58,
          MONO(700, 22),
          C.jam,
        );
        text(
          ctx,
          `floor +${loss.toFixed(1)} dB · SNR -${loss.toFixed(1)} dB`,
          vx + 24,
          vy + vh - 24,
          MONO(700, 22),
          C.text0,
        );
      } else if (i === 1) {
        const X = (k) => vx + 20 + (k / 200) * (vw - 40);
        const Y = (v) => vy + 30 + ((-70 - v) / 26) * 290;
        const g = [];
        const r = [];
        for (let k = 0; k <= 200; k++) {
          const uu = k / 200;
          const base = F.floor + passAt(uu).snr;
          const s = uu * 60 + t * 0.3;
          g.push([X(k), Y(base + natPower(s))]);
          r.push([X(k), Y(base - 3.2 + 0.4 * sn(s * 7, 36) + natPower(s + 3))]);
        }
        polyline(ctx, g, C.accent, 2.4);
        const reveal = clamp(lt2 / 2.5);
        polyline(ctx, r.slice(0, Math.max(2, Math.floor(r.length * reveal))), C.warn, 2.4);
        text(ctx, 'genuine', vx + 24, vy + 40, MONO(700, 20), C.accent);
        text(ctx, 'rogue node, −3.2 dB', vx + 24, vy + 68, MONO(700, 20), C.warn);
        text(ctx, 'power (dBm) over the pass', vx + 24, vy + vh - 24, MONO(500, 19), C.text2);
      } else {
        const rows = 7;
        const cols = 14;
        const cw = (vw - 40) / cols;
        const target = [3, 9];
        const flipped = lt2 > 2.2;
        for (let rr = 0; rr < rows; rr++) {
          for (let cc = 0; cc < cols; cc++) {
            let bit = h2(rr * 31 + cc, 7) > 0.5 ? 1 : 0;
            const natural = h2(rr * 31 + cc, Math.floor(t * 3)) < 0.025;
            const isTarget = rr === target[0] && cc === target[1];
            if (isTarget && flipped) bit ^= 1;
            const cx = vx + 20 + cc * cw;
            const cy = vy + 26 + rr * 40;
            if (natural)
              box(ctx, cx + 2, cy + 2, cw - 4, 34, {
                fill: hexA(C.text1, 0.25),
                stroke: null,
                r: 6,
              });
            if (isTarget && flipped)
              box(ctx, cx + 2, cy + 2, cw - 4, 34, {
                fill: hexA(C.tamper, 0.9),
                stroke: null,
                r: 6,
              });
            text(
              ctx,
              String(bit),
              cx + cw / 2,
              cy + 28,
              MONO(500, 22),
              isTarget && flipped ? C.bg0 : C.text1,
              'center',
            );
          }
        }
        if (flipped) {
          check(ctx, vx + 34, vy + vh - 32, 26, C.ok);
          text(ctx, 'checksum recomputed', vx + 56, vy + vh - 24, MONO(700, 22), C.ok);
        } else {
          text(
            ctx,
            'grey: random errors from noise',
            vx + 24,
            vy + vh - 24,
            MONO(500, 19),
            C.text2,
          );
        }
      }
      para(ctx, foot, x + 28, 840, 488, 34, UI(400, 26), C.text0);
      ctx.restore();
    });
  });
}

function physics(ctx, lt, sc) {
  heading(
    ctx,
    lt,
    '04',
    'Our idea · Physical layer · χ²',
    'Make every imitation visible, or bounded',
  );
  const c1 = sc.cues[2];
  const c2 = sc.cues[3];
  const XMIN = -14;
  const XMAX = 6;
  const YMAX = 6;
  let x = XMIN;
  if (lt >= c1.s) x = lerp(XMIN, F.stealthDb, easeInOut((lt - c1.s) / ((c1.e - c1.s) * 0.75)));
  if (lt >= c2.s) x = lerp(F.stealthDb, 2, easeInOut((lt - c2.s) / 1.4));
  const loss = snrLoss(x);
  const detected = x > F.stealthDb + 0.01;

  rise(ctx, lt, 0.3, () => {
    box(ctx, M, 240, 1110, 720);
    const a = {
      x: M + 110,
      y: 300,
      w: 950,
      h: 520,
      xmin: XMIN,
      xmax: XMAX,
      ymin: 0,
      ymax: YMAX,
      xticks: [-14, -10, -6, -2, 2, 6],
      yticks: [0, 1, 2, 3, 4, 5, 6],
      xfmt: (v) => `${v > 0 ? '+' : ''}${v}`,
      xlabel: 'noise injected above the thermal floor (dB)',
      ylabel: 'signal-to-noise ratio lost (dB)',
    };
    const { X, Y } = axes(ctx, a);
    const hid = smooth(c1.s + 0.5, c1.s + 1.5, lt);
    const vis = smooth(c2.s, c2.s + 0.8, lt);
    if (hid > 0) {
      ctx.fillStyle = hexA(C.ok, 0.1 * hid);
      ctx.fillRect(
        X(XMIN),
        Y(F.stealthLossDb),
        X(F.stealthDb) - X(XMIN),
        Y(0) - Y(F.stealthLossDb),
      );
      ctx.save();
      ctx.globalAlpha *= hid;
      text(ctx, 'HIDDEN · BOUNDED', X(-13.4), Y(2.6), MONO(700, 26), C.ok, 'left', 2);
      text(
        ctx,
        `at most ${F.stealthLossDb} dB lost · frames verify`,
        X(-13.4),
        Y(2.6) + 36,
        UI(400, 24),
        C.text1,
      );
      ctx.restore();
    }
    if (vis > 0) {
      ctx.fillStyle = hexA(C.bad, 0.1 * vis);
      ctx.fillRect(X(F.stealthDb), Y(YMAX), X(XMAX) - X(F.stealthDb), Y(0) - Y(YMAX));
      ctx.save();
      ctx.globalAlpha *= vis;
      text(ctx, 'VISIBLE', X(-4.4), Y(5.5), MONO(700, 26), C.bad, 'left', 2);
      text(ctx, 'the χ² gate fires', X(-4.4), Y(5.5) + 36, UI(400, 24), C.text1);
      ctx.restore();
    }
    dashed(ctx, X(XMIN), Y(F.boxBandDb), X(XMAX), Y(F.boxBandDb), hexA(C.text2, 0.8), 1.5, [5, 7]);
    text(
      ctx,
      `old box gate: ±${F.boxBandDb} dB`,
      X(-13.6),
      Y(F.boxBandDb) - 14,
      MONO(500, 20),
      C.text2,
    );
    dashed(ctx, X(XMIN), Y(F.stealthLossDb), X(XMAX), Y(F.stealthLossDb), C.bad, 2.5);
    text(
      ctx,
      `χ² gate: ${F.stealthLossDb} dB of power alone`,
      X(-1.6),
      Y(F.stealthLossDb) - 14,
      MONO(700, 22),
      C.bad,
    );
    const draw = clamp(lt / 1.4);
    const pts = [];
    for (let k = 0; k <= 180 * draw; k++) {
      const v = XMIN + (k / 180) * (XMAX - XMIN);
      pts.push([X(v), Y(Math.min(YMAX, snrLoss(v)))]);
    }
    if (pts.length > 1) polyline(ctx, pts, C.accent, 3.5);
    if (hid > 0) {
      dashed(ctx, X(F.stealthDb), Y(0), X(F.stealthDb), Y(YMAX), hexA(C.ok, hid), 2, [4, 6]);
      ctx.save();
      ctx.globalAlpha *= hid;
      text(
        ctx,
        `−${Math.abs(F.stealthDb)} dB`,
        X(F.stealthDb) + 10,
        Y(0) - 14,
        MONO(700, 22),
        C.ok,
      );
      ctx.restore();
    }
    if (lt >= c1.s) {
      const col = detected ? C.bad : C.ok;
      ctx.fillStyle = hexA(col, 0.25);
      ctx.beginPath();
      ctx.arc(X(x), Y(Math.min(YMAX, loss)), 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(X(x), Y(Math.min(YMAX, loss)), 10, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  rise(ctx, lt, c1.s, () => {
    const J = F.floor + x;
    tile(
      ctx,
      1260,
      240,
      540,
      162,
      'INJECTED NOISE',
      `${J.toFixed(1)} dBm`,
      `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)} dB vs thermal noise`,
      C.jam,
    );
    tile(
      ctx,
      1260,
      422,
      540,
      162,
      'SNR AT THE MASK',
      `${(F.snrMask - loss).toFixed(1)} dB`,
      `${F.snrMask.toFixed(1)} dB without the attack`,
    );
    tile(
      ctx,
      1260,
      604,
      540,
      162,
      'SNR OVERHEAD',
      `${(F.snrZenith - loss).toFixed(1)} dB`,
      `${F.snrZenith} dB without the attack`,
    );
    chip(
      ctx,
      detected ? 'χ² GATE FIRES' : 'HIDDEN · FRAMES VERIFY',
      1260,
      836,
      detected ? C.bad : C.ok,
    );
    text(
      ctx,
      `χ²: Σ z² ≤ ${F.chiGate} · kinematic ±${F.kinematicZ}σ`,
      1260,
      930,
      UI(400, 22),
      C.text2,
    );
  });
}

function ai(ctx, lt, sc) {
  heading(ctx, lt, '05', 'Statistical layer · AI', 'Read what the χ² cannot see');
  const c1 = sc.cues[1];
  rise(ctx, lt, 0.3, () => {
    box(ctx, M, 240, 990, 720);
    const a = {
      x: M + 120,
      y: 300,
      w: 820,
      h: 540,
      xmin: -5,
      xmax: 5,
      ymin: -5,
      ymax: 5,
      xticks: [-4, -2, 0, 2, 4],
      yticks: [-4, -2, 0, 2, 4],
      xlabel: 'power vs link budget (dB)',
      ylabel: 'change since the last reading (dB)',
    };
    const { X, Y } = axes(ctx, a);
    const n = Math.floor(clamp(lt / 2.2) * 500);
    let mr = 0;
    let ms = 0;
    for (let k = 1; k <= 500; k++) {
      const s0 = 40 + k * 0.32;
      const r = natPower(s0);
      const st = r - natPower(s0 - 0.32);
      mr = Math.max(mr, Math.abs(r));
      ms = Math.max(ms, Math.abs(st));
      if (k > n) continue;
      ctx.fillStyle = hexA(C.accent, 0.75);
      ctx.beginPath();
      ctx.arc(X(r), Y(st), 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
    const env = smooth(1.6, 2.6, lt);
    if (env > 0) {
      ctx.save();
      ctx.globalAlpha *= env;
      ctx.setLineDash([8, 7]);
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(X(0), Y(0), X(mr * 1.35) - X(0), Y(0) - Y(ms * 1.35), 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha *= env;
      text(ctx, 'clean passes', X(mr * 1.35) + 14, Y(ms * 1.35) - 6, MONO(700, 22), C.accent);
      ctx.restore();
    }
    const jump = smooth(c1.s + 0.4, c1.s + 1.2, lt);
    if (jump > 0) {
      ctx.save();
      ctx.globalAlpha *= jump;
      const jx = X(-3.2);
      const jy = Y(-3.2);
      ctx.strokeStyle = C.bad;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(jx, jy, 26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = C.bad;
      ctx.beginPath();
      ctx.arc(jx, jy, 8, 0, Math.PI * 2);
      ctx.fill();
      text(ctx, 'sudden 3 dB drop', jx + 40, jy - 4, MONO(700, 22), C.bad);
      text(ctx, 'flagged', jx + 40, jy + 26, UI(400, 22), C.text1);
      ctx.restore();
    }
    const creep = clamp((lt - c1.s - 2.4) / 3.2);
    if (creep > 0) {
      for (let k = 0; k <= 24 * creep; k++) {
        const r = lerp(-0.2, -1.1, k / 24);
        ctx.fillStyle = hexA(C.warn, 0.35 + 0.65 * (k / 24));
        ctx.beginPath();
        ctx.arc(X(r), Y(-0.12 + 0.05 * Math.sin(k)), 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.save();
      ctx.globalAlpha *= smooth(0.3, 0.7, creep);
      text(ctx, 'slow creep with natural steps:', X(-4.8), Y(-0.75), MONO(700, 22), C.warn);
      text(
        ctx,
        'capped by the χ² budget: 1.1 dB overhead, 1.7 dB at the mask',
        X(-4.8),
        Y(-0.75) + 30,
        UI(400, 22),
        C.text1,
      );
      ctx.restore();
    }
  });
  const blocks = [
    [
      'Isolation Forest',
      '256 trees, trained on clean passes only, 1% contamination threshold',
      0.4,
    ],
    [
      'What it scores',
      'what the χ² cannot see: EVM, lost frames, arrival jitter, failed tags, and how fast carrier and power changed',
      c1.s,
    ],
    ['AI confidence', 'the share of clean readings that score lower than this one', c1.s + 2],
  ];
  blocks.forEach(([title, body, at], i) =>
    rise(ctx, lt, at, () => {
      const y = 280 + i * 230;
      text(ctx, title, 1170, y, UI(600, 30), C.text0);
      para(ctx, body, 1170, y + 44, 630, 36, UI(400, 26), C.text1);
    }),
  );
}

function crypto(ctx, lt, sc, t) {
  heading(ctx, lt, '06', 'Data layer · Cryptography', 'Noise cannot forge a secret-key tag');
  const c1 = sc.cues[1];
  const c2 = sc.cues[2];
  const hex = (seed, n) =>
    Array.from({ length: n }, (_, i) => Math.floor(h2(seed, i) * 16).toString(16)).join('');
  const flip = lt > c1.s + 0.8;

  rise(ctx, lt, 0.3, () => {
    const parts = [
      ['satellite', 'TERRASAR-X', 300],
      ['sequence', '1048590', 220],
      ['payload · 16 bytes', null, 760],
      ['HMAC-SHA256 tag', `${hex(5, 6)}…${hex(6, 4)}`, 316],
    ];
    let x = M;
    for (const [label, value, w] of parts) {
      text(ctx, label.toUpperCase(), x, 270, MONO(500, 18), C.text2, 'left', 2);
      box(ctx, x, 286, w, 84, {
        fill: C.bg2,
        stroke: label.startsWith('HMAC') ? C.accent : C.line,
        r: 10,
        lw: 2,
      });
      if (value)
        text(
          ctx,
          value,
          x + w / 2,
          340,
          MONO(700, 28),
          label.startsWith('HMAC') ? C.accent : C.text0,
          'center',
        );
      else {
        const cw = w / 16;
        for (let b = 0; b < 16; b++) {
          let v = hex(100 + b, 2);
          const hit = b === 5 && flip;
          if (hit) v = (parseInt(v, 16) ^ 4).toString(16).padStart(2, '0');
          if (hit)
            box(ctx, x + b * cw + 4, 296, cw - 8, 64, { fill: C.tamper, stroke: null, r: 6 });
          text(ctx, v, x + b * cw + cw / 2, 340, MONO(500, 24), hit ? C.bg0 : C.text1, 'center');
        }
        if (flip) text(ctx, '1 bit changed', x + 5.5 * cw, 404, MONO(700, 22), C.tamper, 'center');
      }
      x += w + 12;
    }
  });

  rise(ctx, lt, c1.s + 1.6, () => {
    const rx = `${hex(5, 24)}…`;
    const rc = `${hex(9, 24)}…`;
    text(ctx, 'TAG RECEIVED', M, 470, MONO(500, 20), C.text2, 'left', 2);
    text(ctx, rx, M + 260, 470, MONO(700, 30), C.text0);
    text(ctx, 'TAG RECOMPUTED', M, 520, MONO(500, 20), C.text2, 'left', 2);
    ctx.font = MONO(700, 30);
    let xx = M + 260;
    for (let i = 0; i < rc.length; i++) {
      const ch = rc[i];
      text(ctx, ch, xx, 520, MONO(700, 30), ch === rx[i] ? C.text0 : C.bad);
      xx += ctx.measureText(ch).width;
    }
    chip(ctx, 'MAC_MISMATCH → DROP · REQUEST AGAIN', M, 606, C.bad, { size: 24 });
    const guess = 'a guessed tag matches 1 time in 2';
    text(ctx, guess, 1250, 484, UI(400, 26), C.text1);
    ctx.font = UI(400, 26);
    text(ctx, '256', 1250 + ctx.measureText(guess).width + 2, 470, UI(600, 18), C.text1);
    text(ctx, 'with the key: computed in microseconds', 1250, 524, UI(400, 26), C.text1);
  });

  rise(ctx, lt, c2.s - 0.2, () => {
    const n = 20;
    const lt2 = lt - c2.s;
    const shown = Math.floor(clamp(lt2 / 5.2) * n);
    const bad = (k) => k === 3 || (k >= 11 && k <= 16);
    text(ctx, 'FRAMES AS THEY ARRIVE', M, 690, MONO(500, 20), C.text2, 'left', 2);
    for (let k = 0; k < n; k++) {
      const x = M + k * 62;
      if (k >= shown) {
        box(ctx, x, 712, 50, 46, { fill: null, stroke: C.line, r: 8 });
        continue;
      }
      const b = bad(k);
      box(ctx, x, 712, 50, 46, {
        fill: hexA(b ? C.bad : C.ok, 0.22),
        stroke: b ? C.bad : C.ok,
        r: 8,
        lw: 2,
      });
      if (b) cross(ctx, x + 25, 735, 26, C.bad);
      else check(ctx, x + 25, 735, 26, C.ok);
    }
    if (shown > 3) {
      text(ctx, 'one failure: rejected, resent', M + 3 * 62 - 10, 800, MONO(700, 20), C.text1);
    }
    if (shown > 14) {
      text(ctx, 'a burst, 3 in 10: quarantined', M + 11 * 62, 800, MONO(700, 20), C.bad);
    }
    const lit = shown > 14;
    const single = shown >= 4 && shown <= 6;
    const dets = [
      ['PHYSICAL', false],
      ['DATA', lit || single],
      ['STATISTICAL', lit],
    ];
    if (single) text(ctx, '1 of 3 · reject, resend', 1420, 920, MONO(700, 22), C.warn);
    dets.forEach(([name, on], i) => {
      const y = 712 + i * 58;
      box(ctx, 1420, y, 380, 46, {
        fill: on ? hexA(C.bad, 0.18) : C.bg2,
        stroke: on ? C.bad : C.line,
        r: 8,
        lw: 2,
      });
      text(ctx, name, 1440, y + 32, MONO(700, 22), on ? C.bad : C.text2, 'left', 1);
      text(ctx, on ? 'FLAG' : 'PASS', 1780, y + 32, MONO(700, 22), on ? C.bad : C.ok, 'right');
    });
    if (lit) {
      ctx.save();
      ctx.globalAlpha *= smooth(0, 0.5, lt2 - 4.4);
      chip(ctx, '2 OF 3 → QUARANTINE', M, 900, C.bad, { size: 26 });
      ctx.restore();
    }
  });
}

function result(ctx, lt, sc) {
  heading(ctx, lt, '07', 'Result', 'Visible, or bounded, every time');
  const cards = [
    [
      '100%',
      'of attack packets flagged',
      '6 seeds · 15,000 attack packets per run',
      C.ok,
      sc.cues[0].s,
    ],
    [
      '0',
      'corrupted frames reached the analyst',
      'across all ten attacks',
      C.ok,
      sc.cues[0].s + 1.2,
    ],
    [
      '≈1.6%',
      'of genuine packets held back',
      '1.57% over 6 seeds, target under 2%',
      C.accent,
      sc.cues[1].s,
    ],
  ];
  cards.forEach(([big, label, sub, color, at], i) =>
    rise(ctx, lt, at, () => {
      const x = M + i * 568;
      box(ctx, x, 270, 544, 400);
      ctx.fillStyle = color;
      ctx.fillRect(x, 300, 5, 340);
      text(ctx, big, x + 44, 470, DISPLAY(700, 150), C.text0);
      para(ctx, label, x + 44, 540, 460, 40, UI(600, 32), C.text0);
      text(ctx, sub, x + 44, 640, MONO(500, 20), C.text2);
    }),
  );
  rise(ctx, lt, sc.cues[2].s, () => {
    chip(ctx, 'TRY IT LIVE · RUN THE DASHBOARD LOCALLY', M, 800, C.accent, { size: 40 });
    text(
      ctx,
      'Synthetic traffic: every figure will be re-measured on the official reference datasets.',
      M,
      900,
      UI(400, 24),
      C.text2,
    );
  });
}

const SCENES = { intro, signal, natural, imitate, physics, ai, crypto, result };

// ---------------------------------------------------------------- timeline

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let TL = null;

function render(t) {
  background(ctx, t);
  const scenes = TL.scenes;
  const i = Math.max(
    0,
    scenes.findIndex((s) => t >= s.start && t < s.end),
  );
  const draw = (sc, alpha) => {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    SCENES[sc.id](ctx, t - sc.start, sc.local, t);
    ctx.restore();
  };
  const sc = scenes[t >= TL.duration ? scenes.length - 1 : i];
  const fadeIn = sc.start === 0 ? 1 : smooth(sc.start, sc.start + 0.55, t);
  const fadeOut =
    sc === scenes[scenes.length - 1]
      ? 1 - smooth(TL.duration - 1.2, TL.duration, t)
      : 1 - smooth(sc.end - 0.45, sc.end, t);
  draw(sc, Math.min(fadeIn, fadeOut));
  chrome(ctx, Math.min(t, TL.duration), TL, sc);
}

async function init() {
  const [res, atm] = await Promise.all([
    fetch('../src/noise/explainer.json'),
    fetch('../src/data/p618.json'),
  ]);
  TL = await res.json();
  P618 = await atm.json();
  for (const s of TL.scenes) {
    s.local = {
      dur: s.end - s.start,
      cues: s.cues.map((c) => ({ s: c.start - s.start, e: c.end - s.start, text: c.text })),
    };
  }
  await Promise.all(
    [
      DISPLAY(700, 60),
      DISPLAY(500, 60),
      UI(400, 24),
      UI(600, 24),
      MONO(500, 20),
      MONO(700, 20),
    ].map((f) => document.fonts.load(f, '0123 Hiding µ±→·')),
  );
  render(0);
  return {
    duration: TL.duration,
    chapters: TL.scenes.map((s) => ({ title: s.chapter, start: s.start })),
  };
}

window.explainer = {
  ready: init(),
  render: (t) => render(t),
  frameJpeg: (t, q = 0.95) => {
    render(t);
    return canvas.toDataURL('image/jpeg', q);
  },
  slideJpeg: (t, label, q = 0.9) => {
    SLIDE = label;
    render(t);
    SLIDE = null;
    return canvas.toDataURL('image/jpeg', q);
  },
};

if (!new URLSearchParams(location.search).has('render')) {
  window.explainer.ready.then(() => {
    const t0 = performance.now();
    const loop = () => {
      render(((performance.now() - t0) / 1000) % TL.duration);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}
