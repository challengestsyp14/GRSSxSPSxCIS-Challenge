// Procedural textures drawn once on canvas: solar cells, gold multi-layer insulation,
// and a soft round sprite for points.

import * as THREE from 'three';

import { mulberry32 } from '../sim/noise';

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return { c, ctx };
}

let solar: THREE.CanvasTexture | null = null;
export function solarCellTexture(): THREE.CanvasTexture {
  if (solar) return solar;
  const { c, ctx } = canvas(512, 512);
  const g = ctx.createLinearGradient(0, 0, 512, 512);
  g.addColorStop(0, '#0d2a52');
  g.addColorStop(0.5, '#123766');
  g.addColorStop(1, '#0a2244');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  const cols = 8;
  const rows = 8;
  const cw = 512 / cols;
  const ch = 512 / rows;
  const rand = mulberry32(11);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = i * cw;
      const y = j * ch;
      const shade = 18 + rand() * 14;
      ctx.fillStyle = `hsl(214 70% ${shade}%)`;
      ctx.fillRect(x + 3, y + 3, cw - 6, ch - 6);
      // Bus bars.
      ctx.strokeStyle = 'rgba(160, 190, 230, 0.35)';
      ctx.lineWidth = 1;
      for (let k = 1; k < 4; k++) {
        ctx.beginPath();
        ctx.moveTo(x + 3, y + (ch * k) / 4);
        ctx.lineTo(x + cw - 3, y + (ch * k) / 4);
        ctx.stroke();
      }
      // Clipped corners, as on real cells.
      ctx.fillStyle = '#0a1c36';
      for (const [cx, cy] of [
        [x + 3, y + 3],
        [x + cw - 3, y + 3],
        [x + 3, y + ch - 3],
        [x + cw - 3, y + ch - 3],
      ]) {
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.strokeStyle = '#c9d4e2';
  ctx.lineWidth = 6;
  ctx.strokeRect(0, 0, 512, 512);
  solar = new THREE.CanvasTexture(c);
  solar.colorSpace = THREE.SRGBColorSpace;
  solar.anisotropy = 8;
  return solar;
}

let sar: THREE.CanvasTexture | null = null;
/**
 * Face of TerraSAR-X's phased-array radar antenna: 12 panels along its length, each a grid of
 * radiating sub-arrays, white with fine dark seams. Drawn along the canvas width.
 */
export function sarAntennaTexture(): THREE.CanvasTexture {
  if (sar) return sar;
  const { c, ctx } = canvas(1024, 128);
  ctx.fillStyle = '#5b6573';
  ctx.fillRect(0, 0, 1024, 128);
  const panels = 12;
  const pw = 1024 / panels;
  const rand = mulberry32(31);
  for (let i = 0; i < panels; i++) {
    for (let j = 0; j < 4; j++) {
      for (let k = 0; k < 2; k++) {
        const x = i * pw + 3 + k * ((pw - 6) / 2);
        const y = 4 + j * 30;
        const shade = 82 + rand() * 8;
        ctx.fillStyle = `hsl(210 10% ${shade}%)`;
        ctx.fillRect(x + 1, y + 1, (pw - 6) / 2 - 2, 28);
      }
    }
  }
  sar = new THREE.CanvasTexture(c);
  sar.colorSpace = THREE.SRGBColorSpace;
  sar.anisotropy = 8;
  return sar;
}

let foil: THREE.CanvasTexture | null = null;
export function foilBumpTexture(): THREE.CanvasTexture {
  if (foil) return foil;
  const { c, ctx } = canvas(256, 256);
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 256, 256);
  const rand = mulberry32(3);
  // Crinkled multi-layer insulation: many soft random creases.
  for (let i = 0; i < 90; i++) {
    const x = rand() * 256;
    const y = rand() * 256;
    const len = 20 + rand() * 70;
    const a = rand() * Math.PI;
    ctx.strokeStyle = rand() > 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1 + rand() * 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(
      x + Math.cos(a) * len * 0.5 + (rand() - 0.5) * 20,
      y + Math.sin(a) * len * 0.5 + (rand() - 0.5) * 20,
      x + Math.cos(a) * len,
      y + Math.sin(a) * len,
    );
    ctx.stroke();
  }
  foil = new THREE.CanvasTexture(c);
  foil.wrapS = foil.wrapT = THREE.RepeatWrapping;
  return foil;
}

let foilColor: THREE.CanvasTexture | null = null;
/** Gold MLI albedo: warm gold with brighter and darker panels where the foil folds. */
export function foilColorTexture(): THREE.CanvasTexture {
  if (foilColor) return foilColor;
  const { c, ctx } = canvas(256, 256);
  ctx.fillStyle = '#d4a445';
  ctx.fillRect(0, 0, 256, 256);
  const rand = mulberry32(11);
  for (let i = 0; i < 140; i++) {
    const x = rand() * 256;
    const y = rand() * 256;
    const r = 12 + rand() * 46;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const tone = rand();
    const color = tone > 0.6 ? '255, 214, 120' : tone > 0.3 ? '176, 122, 36' : '232, 180, 84';
    g.addColorStop(0, `rgba(${color}, ${0.25 + rand() * 0.35})`);
    g.addColorStop(1, `rgba(${color}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Tape seams between MLI blankets.
  ctx.strokeStyle = 'rgba(120, 82, 24, 0.55)';
  ctx.lineWidth = 2;
  for (const v of [85, 170]) {
    ctx.beginPath();
    ctx.moveTo(v, 0);
    ctx.lineTo(v, 256);
    ctx.stroke();
  }
  foilColor = new THREE.CanvasTexture(c);
  foilColor.colorSpace = THREE.SRGBColorSpace;
  foilColor.wrapS = foilColor.wrapT = THREE.RepeatWrapping;
  return foilColor;
}

let dot: THREE.CanvasTexture | null = null;
export function dotSprite(): THREE.CanvasTexture {
  if (dot) return dot;
  const { c, ctx } = canvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  dot = new THREE.CanvasTexture(c);
  return dot;
}
