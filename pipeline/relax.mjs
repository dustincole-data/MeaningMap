// Precompute the collision relaxation that used to run in the browser on every page
// load (~1.4s of the ~1.75s blocking startup) and bake the result into src/data/coords.json
// as rx/ry (world-space, post-relaxation). map.ts then reads rx/ry directly instead of
// running the relaxation itself.
//
// The algorithm below (params, loop structure, Float32Array accumulators) is copied
// verbatim from the relax() IIFE that used to live in src/scripts/map.ts — keep the two
// in sync if the params (R, ITER, maxDisp) ever change.
//
// Run: node pipeline/relax.mjs   (after join_bls.py; overwrites src/data/coords.json in place)
import fs from 'node:fs';

const DATA_URL = new URL('../src/data/coords.json', import.meta.url);
const coords = JSON.parse(fs.readFileSync(DATA_URL, 'utf8'));
const N = coords.length;
const WORLD = 1000;

const P = coords.map((d) => ({ wx: d.x * WORLD, wy: (1 - d.y) * WORLD }));

(function relax() {
  const R = 14, R2 = R * R, maxDisp = 46, ITER = 70, cell = R;
  const ax = P.map((p) => p.wx), ay = P.map((p) => p.wy);
  for (let it = 0; it < ITER; it++) {
    const grid = new Map();
    for (let i = 0; i < N; i++) { const k = ((P[i].wx / cell) | 0) + ',' + ((P[i].wy / cell) | 0); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i); }
    const dx = new Float32Array(N), dy = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const gx = (P[i].wx / cell) | 0, gy = (P[i].wy / cell) | 0;
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        const arr = grid.get((gx + ox) + ',' + (gy + oy)); if (!arr) continue;
        for (const j of arr) {
          if (j <= i) continue;
          let ddx = P[i].wx - P[j].wx, ddy = P[i].wy - P[j].wy, d2 = ddx * ddx + ddy * ddy;
          if (d2 < R2) {
            if (d2 < 1e-4) { ddx = (i % 7 - 3) * 0.1; ddy = (j % 7 - 3) * 0.1; d2 = ddx * ddx + ddy * ddy + 1e-3; }
            const d = Math.sqrt(d2), push = (R - d) / d * 0.5, px = ddx * push, py = ddy * push;
            dx[i] += px; dy[i] += py; dx[j] -= px; dy[j] -= py;
          }
        }
      }
    }
    for (let i = 0; i < N; i++) {
      P[i].wx += dx[i]; P[i].wy += dy[i];
      const ox = P[i].wx - ax[i], oy = P[i].wy - ay[i], od = Math.hypot(ox, oy);
      if (od > maxDisp) { P[i].wx = ax[i] + ox / od * maxDisp; P[i].wy = ay[i] + oy / od * maxDisp; }
    }
  }
})();

for (let i = 0; i < N; i++) { coords[i].rx = P[i].wx; coords[i].ry = P[i].wy; }

// match the existing file's formatting (Python json.dump default: ", "/": " separators,
// single line) so the diff is just the two new keys per record, not a full reformat.
const json = '[' + coords.map((rec) => (
  '{' + Object.entries(rec).map(([k, v]) => JSON.stringify(k) + ': ' + JSON.stringify(v)).join(', ') + '}'
)).join(', ') + ']';
fs.writeFileSync(DATA_URL, json);
console.log(`wrote rx/ry for ${N} occupations -> ${DATA_URL.pathname.replace(/^\/([A-Za-z]:)/, '$1')}`);
