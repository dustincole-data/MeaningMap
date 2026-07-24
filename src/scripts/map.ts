/* Meaning Map — rendering + interaction engine.
   Ported from the locked prototype (assets/04-prototype.html); the algorithms
   (collision relaxation, per-family KDE + territory-clipped marching-squares
   coastlines, strict label level-of-detail, isolate+frame find-similar) are the
   reference implementation — carried forward, not reinvented.
   Data is import-inlined by Vite at build time: no runtime fetch, no model,
   no embeddings in the browser. find-similar is a pure neighbors.json lookup. */
'use strict';
import coordsData from '../data/coords.json';
import neighData from '../data/neighbors.json';

interface Occ {
  code: string; title: string; short_description: string;
  major_group: string; major_group_code: string; job_zone: number;
  x: number; y: number;
  employment: number | null; median_wage: number | null;
  wage_capped: boolean; wage_level: string | null;
}
interface Nbr { n: number[]; s: number[]; }

const COORDS = coordsData as unknown as Occ[];
const NEIGH = neighData as unknown as Nbr[];
const N = COORDS.length;

/* ---------- families: 22 SOC -> 10 hues; distributed = interleaving (02 finding) ---------- */
interface Fam { key: string; name: string; groups: string[]; color: string; distributed?: boolean; rgb: number[]; }
const FAMILIES: Fam[] = ([
  { key: 'stem',  name: 'Science, Tech & Engineering',  groups: ['15', '17', '19'], color: '#2f6fc4' },
  { key: 'edu',   name: 'Education, Law & Social',       groups: ['21', '23', '25'], color: '#12867a' },
  { key: 'health',name: 'Healthcare',                    groups: ['29', '31'],       color: '#d8474d' },
  { key: 'arts',  name: 'Arts & Media',                  groups: ['27'],             color: '#c94f9a' },
  { key: 'sales', name: 'Sales & Office',                groups: ['41', '43'],       color: '#a575e8', distributed: true },
  { key: 'mgmt',  name: 'Management & Business',         groups: ['11', '13'],       color: '#73b0ee', distributed: true },
  { key: 'food',  name: 'Food & Hospitality',           groups: ['35'],             color: '#e8813a' },
  { key: 'svc',   name: 'Personal & Protective Service', groups: ['33', '37', '39'], color: '#bfb800', distributed: true },
  { key: 'trade', name: 'Skilled Trades & Production',   groups: ['47', '49', '51'], color: '#9c6a3c' },
  { key: 'trans', name: 'Transportation & Farming',      groups: ['53', '45'],       color: '#3bb974' },
] as Omit<Fam, 'rgb'>[]).map((f) => ({ ...f, rgb: [] as number[] }));
const GROUP2FAM: Record<string, number> = {};
FAMILIES.forEach((f, i) => f.groups.forEach((g) => (GROUP2FAM[g] = i)));
const famOf = (d: Occ) => GROUP2FAM[d.major_group_code] ?? 5;
const rgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
FAMILIES.forEach((f) => (f.rgb = rgb(f.color)));

/* ---------- world coords ---------- */
interface Pt { i: number; wx: number; wy: number; fam: number; jz: number; }
const WORLD = 1000;
const P: Pt[] = COORDS.map((d, i) => ({ i, wx: d.x * WORLD, wy: (1 - d.y) * WORLD, fam: famOf(d), jz: d.job_zone || 2 }));
const famCount = FAMILIES.map(() => 0); P.forEach((p) => famCount[p.fam]++);

/* ---------- collision relaxation: de-overlap while holding structure ---------- */
(function relax() {
  const R = 14, R2 = R * R, maxDisp = 46, ITER = 70, cell = R;
  const ax = P.map((p) => p.wx), ay = P.map((p) => p.wy);
  for (let it = 0; it < ITER; it++) {
    const grid = new Map<string, number[]>();
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
// data bounds (for a tight fit)
let BX0 = 1e9, BY0 = 1e9, BX1 = -1e9, BY1 = -1e9;
for (const p of P) { BX0 = Math.min(BX0, p.wx); BY0 = Math.min(BY0, p.wy); BX1 = Math.max(BX1, p.wx); BY1 = Math.max(BY1, p.wy); }

/* ---------- per-family KDE (coherent families only) -> soft fill + crisp coastline ---------- */
const G = 200, SIG = 6.6;
// relaxation can push points slightly outside the nominal [0,WORLD] box; the field grid
// must cover the true point bounds (+ a 3-sigma falloff margin) or a family's density
// gets cut flat at the box edge instead of fading to zero (2026-07-24 sliced-blob bug)
const FPAD = 100;
const FX0 = BX0 - FPAD, FY0 = BY0 - FPAD, FX1 = BX1 + FPAD, FY1 = BY1 + FPAD;
const FW = FX1 - FX0, FH = FY1 - FY0;
const fieldCanvas = document.createElement('canvas'); fieldCanvas.width = G; fieldCanvas.height = G;
const coasts: { f: number; segs: number[][] }[] = [];
const labelAnchor: ({ wx: number; wy: number; v: number } | null)[] = [];
(function buildContinents() {
  const rad = Math.ceil(SIG * 3), inv2s2 = 1 / (2 * SIG * SIG);
  const grids: (Float32Array | null)[] = FAMILIES.map(() => null);
  FAMILIES.forEach((F, f) => {
    if (F.distributed) { labelAnchor[f] = null; return; }
    const a = new Float32Array(G * G);
    for (const p of P) {
      if (p.fam !== f) continue;
      const cx = (p.wx - FX0) / FW * G, cy = (p.wy - FY0) / FH * G;
      const x0 = Math.max(0, (cx - rad) | 0), x1 = Math.min(G - 1, (cx + rad) | 0), y0 = Math.max(0, (cy - rad) | 0), y1 = Math.min(G - 1, (cy + rad) | 0);
      for (let gy = y0; gy <= y1; gy++) { const dy = gy + .5 - cy; for (let gx = x0; gx <= x1; gx++) { const dx = gx + .5 - cx; a[gy * G + gx] += Math.exp(-(dx * dx + dy * dy) * inv2s2); } }
    }
    grids[f] = a;
    let mv = 0, mk = 0; for (let k = 0; k < a.length; k++) if (a[k] > mv) { mv = a[k]; mk = k; }
    labelAnchor[f] = { wx: (mk % G + .5) / G * FW + FX0, wy: ((mk / G | 0) + .5) / G * FH + FY0, v: mv };
  });
  // argmax fill among coherent families
  const img = new ImageData(G, G); let vmax = 0;
  const best = new Int8Array(G * G).fill(-1), val = new Float32Array(G * G);
  for (let k = 0; k < G * G; k++) {
    let bi = -1, bv = 0;
    for (let f = 0; f < FAMILIES.length; f++) { const g = grids[f]; if (!g) continue; if (g[k] > bv) { bv = g[k]; bi = f; } }
    best[k] = bi; val[k] = bv; if (bv > vmax) vmax = bv;
  }
  const lo = vmax * 0.12, hi = vmax * 0.28, MAXA = 0.30;
  for (let k = 0; k < G * G; k++) {
    const f = best[k]; if (f < 0) continue;
    let t = (val[k] - lo) / (hi - lo); t = t < 0 ? 0 : t > 1 ? 1 : t; t = t * t * (3 - 2 * t);
    const a = t * MAXA; if (a <= 0) continue; const c = FAMILIES[f].rgb, o = k * 4;
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = a * 255;
  }
  fieldCanvas.getContext('2d')!.putImageData(img, 0, 0);
  // marching squares coastline per coherent family at iso = per-family peak * 0.30
  FAMILIES.forEach((F, f) => {
    const a = grids[f]; if (!a) return;
    const iso = labelAnchor[f]!.v * 0.30, segs: number[][] = [];
    const at = (x: number, y: number) => a[y * G + x];
    const ip = (x0: number, y0: number, v0: number, x1: number, y1: number, v1: number) => {
      const t = (iso - v0) / (v1 - v0 || 1e-6);
      return [(x0 + (x1 - x0) * t) / G * FW + FX0, (y0 + (y1 - y0) * t) / G * FH + FY0];
    };
    for (let y = 0; y < G - 1; y++) for (let x = 0; x < G - 1; x++) {
      if (best[y * G + x] !== f) continue;                 // clip coastline to this family's own territory
      const tl = at(x, y), tr = at(x + 1, y), br = at(x + 1, y + 1), bl = at(x, y + 1);
      let c = (tl > iso ? 8 : 0) | (tr > iso ? 4 : 0) | (br > iso ? 2 : 0) | (bl > iso ? 1 : 0); if (c === 0 || c === 15) continue;
      const T = () => ip(x, y, tl, x + 1, y, tr), Rr = () => ip(x + 1, y, tr, x + 1, y + 1, br),
        B = () => ip(x, y + 1, bl, x + 1, y + 1, br), L = () => ip(x, y, tl, x, y + 1, bl);
      const push = (p: number[], q: number[]) => segs.push([p[0], p[1], q[0], q[1]]);
      switch (c) {
        case 1: case 14: push(L(), B()); break; case 2: case 13: push(B(), Rr()); break;
        case 3: case 12: push(L(), Rr()); break; case 4: case 11: push(T(), Rr()); break;
        case 5: push(L(), T()); push(B(), Rr()); break; case 6: case 9: push(T(), B()); break;
        case 7: case 8: push(L(), T()); break; case 10: push(T(), Rr()); push(L(), B()); break;
      }
    }
    coasts.push({ f, segs });
  });
})();

/* ---------- canvas + view ---------- */
const map = document.getElementById('map') as HTMLCanvasElement, ctx = map.getContext('2d')!, labels = document.getElementById('labels')!;
let DPR = Math.min(devicePixelRatio || 1, 2), Vw = 0, Vh = 0, scale = 1, ox = 0, oy = 0, sFit = 1;
const sx = (wx: number) => wx * scale + ox, sy = (wy: number) => wy * scale + oy;
function resize() { Vw = innerWidth; Vh = innerHeight; map.width = Vw * DPR; map.height = Vh * DPR; fitAll(true); }
function fitAll(instant?: boolean) {
  // the panel is full-width on mobile, so there is no side strip to reserve there
  const padL = 64, padR = (panelOpen && !isMobile() ? 360 : 64), padT = 110, padB = 140, w = BX1 - BX0, h = BY1 - BY0;
  // never let the pads out-measure the viewport: a negative band yields a negative
  // scale, and pr()'s Math.pow of it is NaN, which kills the whole render loop
  const availW = Math.max(120, Vw - padL - padR), availH = Math.max(120, Vh - padT - padB);
  const s = Math.min(availW / w, availH / h);
  const nx = padL + (availW - w * s) / 2 - BX0 * s, ny = padT + (availH - h * s) / 2 - BY0 * s;
  sFit = s; if (instant) { scale = s; ox = nx; oy = ny; draw(); } else animateTo(s, nx, ny);
}

/* ---------- animation ---------- */
let anim: { s0: number; x0: number; y0: number; s: number; x: number; y: number; t0: number; ms: number } | null = null;
function animateTo(s: number, x: number, y: number, ms = 680) {
  if (matchMedia('(prefers-reduced-motion:reduce)').matches) { scale = s; ox = x; oy = y; draw(); return; }
  anim = { s0: scale, x0: ox, y0: oy, s, x, y, t0: performance.now(), ms };
}
// Started from the go-section (after all module state is initialized — the loop
// references `selected`, which is declared below).
function loop(now: number) {
  if (anim) {
    let t = (now - anim.t0) / anim.ms; if (t > 1) t = 1; const e = 1 - Math.pow(1 - t, 4);
    scale = anim.s0 + (anim.s - anim.s0) * e; ox = anim.x0 + (anim.x - anim.x0) * e; oy = anim.y0 + (anim.y - anim.y0) * e;
    if (t >= 1) anim = null; draw();
  }
  requestAnimationFrame(loop);
}

/* ---------- state ---------- */
let selected = -1, hovered = -1, activeFam = -1, panelOpen = false;
const focusSet = new Set<number>();

/* ---------- environment ---------- */
const isMobile = () => innerWidth <= 760;
let peekIdx = -1;                                                          // touch two-stage: peeked, not yet committed

/* ---------- draw ---------- */
const PR = 3.1;                              // base point screen radius
function pr() { return Math.max(2.6, Math.min(6.5, PR * Math.pow(scale / sFit, 0.28))); }
function draw() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, Vw, Vh);
  const r = pr(), focus = selected >= 0;
  const contFade = focus ? 0.12 : Math.max(0, Math.min(1, (sFit * 3.0 - scale) / (sFit * 1.6)));

  // continents: soft fill + coastline
  if (contFade > 0.01) {
    ctx.save();
    ctx.globalAlpha = contFade * (activeFam >= 0 ? 0.5 : 1);
    ctx.setTransform(DPR * scale, 0, 0, DPR * scale, DPR * ox, DPR * oy);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(fieldCanvas, 0, 0, G, G, FX0, FY0, FW, FH);
    ctx.restore();
    ctx.save(); ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    for (const c of coasts) {
      if (activeFam >= 0 && activeFam !== c.f) continue;
      const col = FAMILIES[c.f].rgb;
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${0.34 * contFade})`;
      ctx.lineWidth = 1.1; ctx.beginPath();
      for (const s of c.segs) { ctx.moveTo(sx(s[0]), sy(s[1])); ctx.lineTo(sx(s[2]), sy(s[3])); }
      ctx.stroke();
    }
    ctx.restore();
  }

  // leaders (focus)
  if (focus) {
    const s = P[selected], SX = sx(s.wx), SY = sy(s.wy), nb = NEIGH[selected];
    for (let j = 0; j < nb.n.length; j++) {
      const p = P[nb.n[j]];
      ctx.strokeStyle = `rgba(70,76,92,${0.14 + 0.34 * (nb.s[j] - 0.55)})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(SX, SY); ctx.lineTo(sx(p.wx), sy(p.wy)); ctx.stroke();
    }
  }

  // points: halo pass then core pass
  for (let pass = 0; pass < 2; pass++) {
    for (const p of P) {
      const X = sx(p.wx), Y = sy(p.wy);
      if (!(X > -30 && X < Vw + 30 && Y > -30 && Y < Vh + 30)) continue; // cull off-screen AND reject non-finite (never feed NaN to createRadialGradient)
      const isSel = p.i === selected, isNb = focusSet.has(p.i), isHov = p.i === hovered;
      const muted = (focus && !isSel && !isNb) || (activeFam >= 0 && p.fam !== activeFam);
      const rr = r * (isSel ? 1.7 : isNb ? 1.25 : 1) * (isHov ? 1.4 : 1);
      const c = FAMILIES[p.fam].rgb;
      if (pass === 0) { // halo
        const ha = muted ? 0.0 : (isSel ? 0.42 : isNb ? 0.34 : 0.16);
        if (ha <= 0) continue;
        const g = ctx.createRadialGradient(X, Y, 0, X, Y, rr * 2.6);
        g.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${ha})`); g.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(X, Y, rr * 2.6, 0, 7); ctx.fill();
      } else {      // core
        ctx.globalAlpha = muted ? 0.14 : 1;
        ctx.beginPath(); ctx.arc(X, Y, rr, 0, 7); ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.fill();
        ctx.globalAlpha = muted ? 0.10 : 0.9; ctx.lineWidth = isSel ? 2 : 1;
        ctx.strokeStyle = isSel ? '#fff' : `rgba(255,255,255,0.6)`; ctx.stroke();
        ctx.globalAlpha = 1;
        if (isSel) { ctx.beginPath(); ctx.arc(X, Y, rr + 4, 0, 7); ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.lineWidth = 1.5; ctx.stroke(); }
      }
    }
  }

  drawLabels(focus, contFade);
}

/* ---------- labels: strict level-of-detail ---------- */
const regionEls = FAMILIES.map((F) => {
  const el = document.createElement('div'); el.className = 'region';
  el.style.color = F.color; el.innerHTML = F.name.replace(/ & /g, ' &amp; ');
  labels.appendChild(el); return el;
});
const pool: HTMLDivElement[] = [];
function estHalf(t: string) { return Math.min(78, 14 + t.length * 3.0); }
function drawLabels(focus: boolean, _contFade: number) {
  // region labels (coherent families), fade out as you zoom in
  const showReg = !focus && scale < sFit * 2.9;
  const shown: { el: HTMLDivElement; x: number; y: number }[] = [];
  regionEls.forEach((el, f) => {
    if (!showReg || !labelAnchor[f] || (activeFam >= 0 && activeFam !== f)) { el.style.opacity = '0'; return; }
    shown.push({ el, x: sx(labelAnchor[f]!.wx), y: sy(labelAnchor[f]!.wy) });
  });
  shown.sort((a, b) => a.y - b.y);
  for (let i = 1; i < shown.length; i++) { const a = shown[i - 1], b = shown[i]; if (Math.abs(b.x - a.x) < 160 && b.y - a.y < 24) b.y = a.y + 24; }
  const rf = Math.max(0, Math.min(1, (sFit * 2.9 - scale) / (sFit * 1.0)));
  shown.forEach((s) => { s.el.style.opacity = String(rf); s.el.style.left = s.x + 'px'; s.el.style.top = s.y + 'px'; });

  // point labels
  const items: { p: Pt; strong: boolean; y?: number }[] = [];
  const headerBox = (x: number) => x < 356;   // keep labels out from under the title block (top-left)
  if (focus) {
    // selected pinned; neighbours vertically de-collided so none overlap
    const yOf = (p: Pt) => sy(p.wy) - pr() - 9;
    const nbN = isMobile() ? 3 : NEIGH[selected].n.length; // mobile: list-first — only top few labels in-map (§6.4)
    const nbItems = NEIGH[selected].n.slice(0, nbN).map((ni) => ({ p: P[ni], x: sx(P[ni].wx), y: yOf(P[ni]), strong: false }));
    nbItems.sort((a, b) => a.y - b.y);
    for (let i = 1; i < nbItems.length; i++) { const a = nbItems[i - 1], b = nbItems[i]; if (Math.abs(b.x - a.x) < 130 && b.y - a.y < 17) b.y = a.y + 17; }
    items.push({ p: P[selected], strong: true, y: sy(P[selected].wy) - pr() * 1.7 - 9 });
    nbItems.forEach((it) => items.push(it));
    // the de-collision cascade below stacks labels 17px apart with no upper bound —
    // hold them inside the viewport so the tail of a dense stack can't clip off-screen
    for (const it of items) if (it.y !== undefined) it.y = Math.max(14, Math.min(Vh - 14, it.y));
  } else {
    // The hover tooltip / touch peek callout owns the hovered point's title, so the map
    // adds no label of its own for it. Two boxes on screen at once (black tip over a
    // leftover white label) was the bug.
    const cap = Math.max(0, Math.round((scale / sFit - 1.7) * 26));
    if (cap > 0) {
      const cand = P.filter((p) => {
        const X = sx(p.wx), Y = sy(p.wy), hw = estHalf(COORDS[p.i].title);
        return X - hw > 12 && X + hw < Vw - 12 && Y > 96 && Y < Vh - 118 && !(headerBox(X) && Y < 128) && p.i !== hovered;
      }).sort((a, b) => (b.jz - a.jz) || (a.wx - b.wx));
      const placed = items.map((it) => ({ x: sx(it.p.wx), y: sy(it.p.wy), hw: 60 }));
      for (const p of cand) {
        if (items.length >= cap) break;
        const X = sx(p.wx), Y = sy(p.wy), hw = estHalf(COORDS[p.i].title);
        let ok = true; for (const q of placed) { if (Math.abs(q.x - X) < hw + q.hw && Math.abs(q.y - Y) < 17) { ok = false; break; } }
        if (ok) { placed.push({ x: X, y: Y, hw }); items.push({ p, strong: false }); }
      }
    }
  }
  // same rule inside focus: a hovered neighbour is named by the tooltip, not twice
  const vis = hovered >= 0 ? items.filter((it) => it.p.i !== hovered) : items;
  while (pool.length < vis.length) { const e = document.createElement('div'); e.className = 'plabel'; labels.appendChild(e); pool.push(e); }
  pool.forEach((e, i) => {
    if (i >= vis.length) { e.style.display = 'none'; return; }
    const { p, strong, y } = vis[i];
    e.style.display = 'block'; e.textContent = COORDS[p.i].title;
    e.style.left = sx(p.wx) + 'px'; e.style.top = (y !== undefined ? y : (sy(p.wy) - pr() * (strong ? 1.7 : 1) - 9)) + 'px';
    e.className = 'plabel' + ((strong || focus) ? ' lead' : '');
    e.style.fontWeight = strong ? '700' : '500';
    e.style.color = strong ? 'var(--ink)' : 'var(--ink-soft)';
    e.style.fontSize = strong ? '12.5px' : '11px';
  });
}

/* ---------- picking ---------- */
function pick(mx: number, my: number) {
  let best = -1, bd = 1e9, r = pr() + 6;
  for (const p of P) { const d = (sx(p.wx) - mx) ** 2 + (sy(p.wy) - my) ** 2; if (d < r * r && d < bd) { bd = d; best = p.i; } }
  return best;
}

/* ---------- selection: isolate + frame the 11 relevant points ---------- */
function select(i: number) {
  selected = i; focusSet.clear(); hidePeek();
  if (i >= 0) {
    for (const ni of NEIGH[i].n) focusSet.add(ni);
    fillPanel(i); openPanel(true);
    // frame bbox of selected + neighbours
    let x0 = P[i].wx, x1 = P[i].wx, y0 = P[i].wy, y1 = P[i].wy;
    for (const ni of NEIGH[i].n) { const p = P[ni]; x0 = Math.min(x0, p.wx); x1 = Math.max(x1, p.wx); y0 = Math.min(y0, p.wy); y1 = Math.max(y1, p.wy); }
    // mobile shows the panel full-screen (§6.4), so the map frames into the whole viewport
    const mob = isMobile();
    const w = Math.max(x1 - x0, 60), h = Math.max(y1 - y0, 60);
    const padL = mob ? 28 : 110, padR = mob ? 28 : 384, padT = mob ? 96 : 150, padB = mob ? 96 : 150;
    // Frame at the scale the cluster actually fits at. A `Math.max(s, sFit * 1.3)` floor
    // used to be applied to the scale but not to nx/ny, framing for a zoom that was never
    // used; and for the few neighbour sets that span the map it forced a zoom they cannot
    // fit into either way. Fitting the bbox keeps all 11 points inside the frame, always.
    const availW = Math.max(120, Vw - padL - padR), availH = Math.max(120, Vh - padT - padB);
    const s = Math.min(availW / w, availH / h, sFit * 7);
    const nx = padL + (availW - w * s) / 2 - x0 * s, ny = padT + (availH - h * s) / 2 - y0 * s;
    animateTo(s, nx, ny);
  } else { openPanel(false); }
}

/* ---------- info panel ---------- */
function fmtWage(w: number | null, capped: boolean) {
  if (w === null) return 'Not reported';
  return (capped ? '≥ $' : '$') + w.toLocaleString('en-US');
}
function fmtEmp(e: number | null) { return e === null ? 'Not reported' : e.toLocaleString('en-US'); }
function fillPanel(i: number) {
  const d = COORDS[i], f = FAMILIES[P[i].fam], pn = document.getElementById('panel')!;
  (pn.querySelector('.fam-tag i') as HTMLElement).style.background = f.color;
  pn.querySelector('.ft-name')!.textContent = f.name;
  pn.querySelector('h2')!.textContent = d.title;
  pn.querySelector('.code')!.textContent = 'SOC ' + d.code + ' · ' + d.major_group;
  const hasBls = d.employment !== null || d.median_wage !== null;
  pn.querySelector('.meta')!.innerHTML =
    `<div>Median wage<b>${fmtWage(d.median_wage, d.wage_capped)}</b></div>` +
    `<div>Employment<b>${fmtEmp(d.employment)}</b></div>` +
    `<div>Job zone<b>${d.job_zone} of 5</b></div>`;
  // SOC-resolution caveat (spec §1): OEWS reports at broader SOC groups than O*NET.
  let caveat = pn.querySelector('.caveat') as HTMLElement | null;
  if (!caveat) { caveat = document.createElement('div'); caveat.className = 'caveat'; pn.querySelector('.meta')!.after(caveat); }
  caveat.textContent = hasBls
    ? 'Wage & employment reported by BLS at the broader occupational group level, not this specific occupation.'
    : '';
  caveat.style.display = hasBls ? 'block' : 'none';
  pn.querySelector('.desc')!.textContent = d.short_description || '';
  const nb = NEIGH[i], host = document.getElementById('nbs')!; host.innerHTML = '';
  for (let j = 0; j < nb.n.length; j++) {
    const p = nb.n[j], nd = COORDS[p], nf = FAMILIES[P[p].fam], pct = Math.round(nb.s[j] * 100);
    const b = document.createElement('button'); b.className = 'nb';
    b.innerHTML = `<span class="rk">${j + 1}</span><span class="sw" style="background:${nf.color}"></span>` +
      `<span class="t">${nd.title}<small>${nd.major_group}</small></span>` +
      `<span class="bar"><span class="track"><span class="fill" style="width:${(nb.s[j] * 100).toFixed(0)}%;background:${nf.color}"></span></span>` +
      `<span class="pct">${pct}%</span></span>`;
    b.onclick = () => select(p); host.appendChild(b);
  }
}
function openPanel(on: boolean) { panelOpen = on; document.getElementById('panel')!.classList.toggle('on', on); }

/* ---------- peek callout: touch two-stage tap (first tap = peek, second tap / "Find similar" = commit, §6.3) ---------- */
const peek = document.createElement('div'); peek.id = 'peek';
peek.innerHTML = '<span class="pk-sw"></span><span class="pk-t"></span><button class="pk-go" type="button">Find similar →</button>';
document.body.appendChild(peek);
(peek.querySelector('.pk-go') as HTMLButtonElement).onclick = (e) => { e.stopPropagation(); if (peekIdx >= 0) { const i = peekIdx; hidePeek(); select(i); } };
function showPeek(i: number) {
  peekIdx = i; const d = COORDS[i], f = FAMILIES[P[i].fam];
  (peek.querySelector('.pk-sw') as HTMLElement).style.background = f.color;
  (peek.querySelector('.pk-t') as HTMLElement).innerHTML = `${d.title}<em>${f.name}</em>`;
  peek.style.left = sx(P[i].wx) + 'px'; peek.style.top = (sy(P[i].wy) - pr() - 12) + 'px';
  peek.classList.add('on'); hovered = i; draw();
}
function hidePeek() { if (peekIdx < 0) return; peekIdx = -1; peek.classList.remove('on'); hovered = -1; draw(); }

/* ---------- events: multi-pointer pan + pinch-zoom (mobile P0, §6.1), two-stage tap on touch ---------- */
const stage = document.getElementById('stage')!;
const pointers = new Map<number, { x: number; y: number }>();
let drag = false, moved = false, lx = 0, ly = 0;
let pinch: { d: number; mx: number; my: number } | null = null;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

stage.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // set gesture state BEFORE capturing so a capture failure can't abort pinch setup
  if (pointers.size === 1) { drag = true; moved = false; lx = e.clientX; ly = e.clientY; stage.classList.add('grabbing'); pinch = null; }
  else if (pointers.size === 2) { drag = false; const p = [...pointers.values()]; pinch = { d: dist(p[0], p[1]) || 1, mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2 }; anim = null; }
  try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic / already-released pointer */ }
});
stage.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) {
    const p = [...pointers.values()], nd = dist(p[0], p[1]), mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2;
    const ns = Math.min(sFit * 9, Math.max(sFit * 0.7, scale * (nd / pinch.d))), k = ns / scale;
    ox = mx - (mx - ox) * k; oy = my - (my - oy) * k; scale = ns;
    ox += mx - pinch.mx; oy += my - pinch.my;            // pan by the two-finger midpoint travel
    pinch = { d: nd, mx, my }; moved = true; anim = null; hidePeek(); draw(); return;
  }
  if (drag) {
    const dx = e.clientX - lx, dy = e.clientY - ly; if (Math.abs(dx) + Math.abs(dy) > 3) { moved = true; hidePeek(); }
    ox += dx; oy += dy; lx = e.clientX; ly = e.clientY; anim = null; draw(); return;
  }
  if (e.pointerType === 'touch') return;                  // no hover on touch
  const i = pick(e.clientX, e.clientY); const tip = document.getElementById('tip')!;
  if (i !== hovered) {
    hovered = i; stage.classList.toggle('picking', i >= 0);
    if (i >= 0) { tip.classList.add('on'); tip.innerHTML = COORDS[i].title + `<span class="m"> · ${COORDS[i].major_group}</span>`; } else tip.classList.remove('on');
    draw();
  }
  if (i >= 0) { (tip as HTMLElement).style.left = e.clientX + 'px'; (tip as HTMLElement).style.top = e.clientY + 'px'; }
});
function endPointer(e: PointerEvent) {
  const wasSolo = pointers.size === 1 && !pinch;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 1) { const p = [...pointers.values()][0]; lx = p.x; ly = p.y; drag = true; moved = true; return; } // 2->1: keep panning, no jump/tap
  stage.classList.remove('grabbing'); drag = false;
  if (wasSolo && !moved) {                                 // a tap
    const i = pick(e.clientX, e.clientY);
    if (e.pointerType === 'touch') {
      if (i < 0) hidePeek();
      else if (i === peekIdx) { const s = i; hidePeek(); select(s); } // second tap on same dot = commit
      else showPeek(i);                                              // first tap = peek
    } else { select(i); }                                            // mouse: direct select
  }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('wheel', (e) => {
  e.preventDefault(); anim = null; hidePeek();
  const f = Math.exp(-e.deltaY * 0.0016), ns = Math.min(sFit * 9, Math.max(sFit * 0.7, scale * f)), k = ns / scale;
  ox = e.clientX - (e.clientX - ox) * k; oy = e.clientY - (e.clientY - oy) * k; scale = ns; draw();
}, { passive: false });

/* ---------- legend ---------- */
const leg = document.getElementById('legend')!;
FAMILIES.forEach((f, i) => {
  const el = document.createElement('div'); el.className = 'fam'; el.dataset.f = String(i);
  el.innerHTML = `<span class="glyph" style="background:${f.color};color:${f.color}"></span>` +
    `<span class="nm${f.distributed ? ' dist' : ''}">${f.name}</span><span class="ct">${famCount[i]}</span>`;
  el.title = f.distributed ? 'Scattered across the map — these roles sit near the work they serve' : '';
  el.onclick = () => {
    activeFam = activeFam === i ? -1 : i;
    [...leg.querySelectorAll('.fam')].forEach((x) => x.classList.toggle('off', activeFam >= 0 && +(x as HTMLElement).dataset.f! !== activeFam));
    draw();
  };
  leg.appendChild(el);
});

/* ---------- search ---------- */
const q = document.getElementById('q') as HTMLInputElement, results = document.getElementById('results')!;
q.addEventListener('input', () => {
  const v = q.value.trim().toLowerCase();
  if (!v) { results.classList.remove('on'); results.innerHTML = ''; return; }
  const hits: number[] = []; for (let i = 0; i < N && hits.length < 8; i++) if (COORDS[i].title.toLowerCase().includes(v)) hits.push(i);
  results.innerHTML = hits.map((i) => {
    const f = FAMILIES[P[i].fam];
    return `<button role="option" data-i="${i}"><span class="sw" style="background:${f.color}"></span>${COORDS[i].title}<span class="mg">${COORDS[i].major_group_code}</span></button>`;
  }).join('');
  results.classList.toggle('on', hits.length > 0);
  results.querySelectorAll('button').forEach((b) => (b as HTMLButtonElement).onclick = () => { select(+(b as HTMLElement).dataset.i!); results.classList.remove('on'); q.value = COORDS[+(b as HTMLElement).dataset.i!].title; });
});
q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const b = results.querySelector('button') as HTMLButtonElement | null; if (b) b.click(); } });

/* ---------- close ---------- */
function closePanel() { select(-1); fitAll(false); }
(document.querySelector('#panel .close') as HTMLButtonElement).onclick = closePanel;
addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });
addEventListener('resize', () => { DPR = Math.min(devicePixelRatio || 1, 2); resize(); });

// mobile: swipe the panel header down to dismiss (§6.7 — not a trap behind a tiny ✕)
{
  const pn = document.getElementById('panel')!;
  let y0 = 0, sdrag = false;
  pn.addEventListener('pointerdown', (e) => {
    if (!isMobile() || (e.target as HTMLElement).closest('#nbs, button')) return; // let the list scroll / buttons click
    y0 = e.clientY; sdrag = true;
  });
  pn.addEventListener('pointermove', (e) => { if (sdrag && e.clientY - y0 > 70) { sdrag = false; closePanel(); } });
  pn.addEventListener('pointerup', () => { sdrag = false; });
}

/* ---------- go ---------- */
resize();
requestAnimationFrame(loop);                            // start the render loop now that all state is initialized
requestAnimationFrame(() => map.classList.add('in'));   // canvas fades in over paper + wordmark (§6.6)
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => draw());
