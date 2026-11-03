// Precompute the globe's land dot-grid from Natural Earth 110m (public domain, via world-atlas).
// Output: flat [lat*10, lon*10, ...] integers, so the site ships data rather than geo code.
import { readFileSync, writeFileSync } from 'node:fs';
import { geoContains } from 'd3-geo';
import { feature } from 'topojson-client';

const STEP = 1.2;
const topo = JSON.parse(
  readFileSync(new URL('../node_modules/world-atlas/land-110m.json', import.meta.url)),
);
const land = feature(topo, topo.objects.land);

const out = [];
for (let lat = -84; lat <= 84; lat += STEP) {
  // Keep spacing roughly even on the sphere by widening the longitude step toward the poles.
  const lonStep = STEP / Math.max(Math.cos((lat * Math.PI) / 180), 0.2);
  for (let lon = -180; lon < 180; lon += lonStep) {
    if (geoContains(land, [lon, lat])) out.push(Math.round(lat * 10), Math.round(lon * 10));
  }
}
writeFileSync(new URL('../src/data/land-dots.json', import.meta.url), JSON.stringify(out));
console.log(`land dots: ${out.length / 2}`);
