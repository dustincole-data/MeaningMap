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
  x: number; y: number; rx: number; ry: number;
  employment: number | null; median_wage: number | null;
  wage_capped: boolean; wage_level: string | null;
}
interface Nbr { n: number[]; s: number[]; }

const COORDS = coordsData as unknown as Occ[];
const NEIGH = neighData as unknown as Nbr[];
const N = COORDS.length;

/* ---------- families: 22 SOC -> 10 hues; distributed = interleaving (02 finding) ---------- */
// `short` is the phone name: at 390 px the full names overrun the screen (a 13px tracked
// "TRANSPORTATION & FARMING" is ~330 px wide), and the region labels are the only colour key
// a phone gets — an unreadable key is no key.
interface Fam { key: string; name: string; short: string; groups: string[]; color: string; distributed?: boolean; rgb: number[]; }
const FAMILIES: Fam[] = ([
  { key: 'stem',  name: 'Science, Tech & Engineering',  short: 'Science & Tech',   groups: ['15', '17', '19'], color: '#2f6fc4' },
  { key: 'edu',   name: 'Education, Law & Social',       short: 'Education & Law', groups: ['21', '23', '25'], color: '#12867a' },
  { key: 'health',name: 'Healthcare',                    short: 'Healthcare',      groups: ['29', '31'],       color: '#d8474d' },
  { key: 'arts',  name: 'Arts & Media',                  short: 'Arts & Media',    groups: ['27'],             color: '#c94f9a' },
  { key: 'sales', name: 'Sales & Office',                short: 'Sales & Office',  groups: ['41', '43'],       color: '#a575e8', distributed: true },
  { key: 'mgmt',  name: 'Management & Business',         short: 'Management',      groups: ['11', '13'],       color: '#73b0ee', distributed: true },
  { key: 'food',  name: 'Food & Hospitality',           short: 'Food & Hotels',   groups: ['35'],             color: '#e8813a' },
  { key: 'svc',   name: 'Personal & Protective Service', short: 'Service',         groups: ['33', '37', '39'], color: '#bfb800', distributed: true },
  { key: 'trade', name: 'Skilled Trades & Production',   short: 'Trades',          groups: ['47', '49', '51'], color: '#9c6a3c' },
  { key: 'trans', name: 'Transportation & Farming',      short: 'Transport & Farm',groups: ['53', '45'],       color: '#3bb974' },
] as Omit<Fam, 'rgb'>[]).map((f) => ({ ...f, rgb: [] as number[] }));
const GROUP2FAM: Record<string, number> = {};
FAMILIES.forEach((f, i) => f.groups.forEach((g) => (GROUP2FAM[g] = i)));
const famOf = (d: Occ) => GROUP2FAM[d.major_group_code] ?? 5;
const rgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
FAMILIES.forEach((f) => (f.rgb = rgb(f.color)));

/* ---------- world coords ---------- */
// rx/ry are pre-relaxed (de-overlapped) world coords, baked by pipeline/relax.mjs —
// see that file for the collision-relaxation algorithm this used to run on every load.
interface Pt { i: number; wx: number; wy: number; fam: number; jz: number; }
const P: Pt[] = COORDS.map((d, i) => ({ i, wx: d.rx, wy: d.ry, fam: famOf(d), jz: d.job_zone || 2 }));
const famCount = FAMILIES.map(() => 0); P.forEach((p) => famCount[p.fam]++);

// data bounds (for a tight fit)
let BX0 = 1e9, BY0 = 1e9, BX1 = -1e9, BY1 = -1e9;
for (const p of P) { BX0 = Math.min(BX0, p.wx); BY0 = Math.min(BY0, p.wy); BX1 = Math.max(BX1, p.wx); BY1 = Math.max(BY1, p.wy); }

/* ---------- per-family KDE (coherent families only) -> soft fill + crisp coastline ---------- */
const G = 200, SIG = 6.6;
// relaxation can push points slightly outside the nominal [0,1000] box; the field grid
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

// one Path2D per family coastline, in world coords — built once, stroked under the view transform
const coastPath = coasts.map((c) => {
  const p = new Path2D();
  for (const s of c.segs) { p.moveTo(s[0], s[1]); p.lineTo(s[2], s[3]); }
  return p;
});

/* ---------- canvas + view ---------- */
const map = document.getElementById('map') as HTMLCanvasElement, ctx = map.getContext('2d')!, labels = document.getElementById('labels')!;
let DPR = Math.min(devicePixelRatio || 1, 2), Vw = 0, Vh = 0, scale = 1, ox = 0, oy = 0, sFit = 1;
const sx = (wx: number) => wx * scale + ox, sy = (wy: number) => wy * scale + oy;
/* Viewport size — never `innerWidth`. Any element parked off-screen (the panel used to be)
   widens the page, and mobile Chrome then reports the min-scale viewport: 780 at a 390 device.
   That lie quadrupled the canvas and framed the atlas off the visible screen (ticket 04 #2).
   The canvas box itself is the ground truth; documentElement/visualViewport are the fallbacks. */
const vpW = () => map.clientWidth || (visualViewport?.width ?? 0) || document.documentElement.clientWidth;
const vpH = () => map.clientHeight || (visualViewport?.height ?? 0) || document.documentElement.clientHeight;
function resize() { Vw = vpW(); Vh = vpH(); map.width = Vw * DPR; map.height = Vh * DPR; fitAll(true); }
function fitAll(instant?: boolean) {
  // Phone: the atlas is width-constrained on a portrait screen, so reserving bands for the
  // header and the key would shrink the map without buying anything — the leftover space
  // ABOVE and BELOW the fitted atlas is exactly where that chrome sits. Fit edge-to-edge and
  // let the chrome float in the gap (ticket 05). Desktop keeps its editorial margins.
  const mob = isMobile();
  const padL = mob ? 10 : 64, padR = mob ? 10 : (panelOpen ? 360 : 64), padT = mob ? 10 : 110,
    padB = mob ? 10 : 140, w = BX1 - BX0, h = BY1 - BY0;
  // never let the pads out-measure the viewport: a negative band yields a negative
  // scale, and pr()'s Math.pow of it is NaN, which kills the whole render loop
  const availW = Math.max(120, Vw - padL - padR), availH = Math.max(120, Vh - padT - padB);
  const s = Math.min(availW / w, availH / h);
  const nx = padL + (availW - w * s) / 2 - BX0 * s, ny = padT + (availH - h * s) / 2 - BY0 * s;
  sFit = s; if (instant) { scale = s; ox = nx; oy = ny; invalidate(); } else animateTo(s, nx, ny);
}

/* ---------- animation ---------- */
let anim: { s0: number; x0: number; y0: number; s: number; x: number; y: number; t0: number; ms: number } | null = null;
function animateTo(s: number, x: number, y: number, ms = 680) {
  if (matchMedia('(prefers-reduced-motion:reduce)').matches) { scale = s; ox = x; oy = y; invalidate(); return; }
  anim = { s0: scale, x0: ox, y0: oy, s, x, y, t0: performance.now(), ms };
}
// Started from the go-section (after all module state is initialized — the loop
// references `selected`, which is declared below).
// Every interaction marks the view dirty; the loop draws at most once per frame. Drawing
// inline in pointermove queued input behind draws and drew 2–3× per pinch frame (ticket 04 #3).
let dirty = false;
const invalidate = () => { dirty = true; };
function loop(now: number) {
  if (anim) {
    let t = (now - anim.t0) / anim.ms; if (t > 1) t = 1; const e = 1 - Math.pow(1 - t, 4);
    scale = anim.s0 + (anim.s - anim.s0) * e; ox = anim.x0 + (anim.x - anim.x0) * e; oy = anim.y0 + (anim.y - anim.y0) * e;
    if (t >= 1) anim = null; dirty = true;
  }
  if (dirty) { dirty = false; draw(); }
  requestAnimationFrame(loop);
}

/* ---------- state ---------- */
let selected = -1, hovered = -1, activeFam = -1, panelOpen = false;
const focusSet = new Set<number>();

/* ---------- environment ---------- */
const isMobile = () => vpW() <= 760;      // vpW(), not innerWidth — see resize()
let peekIdx = -1;                                                          // touch two-stage: peeked, not yet committed

/* ---------- draw ---------- */
const PR = 3.1;                              // base point screen radius
function pr() { return Math.max(2.6, Math.min(6.5, PR * Math.pow(scale / sFit, 0.28))); }

/* One halo sprite per family, baked once — no more `createRadialGradient` per point per frame.
   Ambient halos are the glow that makes the atlas feel lit, and they are the one effect that
   costs a draw call PER POINT, which is what a phone cannot afford. Measured at 4× CPU with
   893 points: ~11 ms as per-point gradients (ticket 04 #3), still ~8–15 ms as pre-baked
   sprites — the cost is the 893 calls, not the pixels, so no cheaper sprite rescues it.
   So the glow is spent from a point budget and fades out where the field is dense — which is
   fit view, where the continent wash already carries the colour and 893 overlapping halos
   blur into an undifferentiated haze anyway. Zoom in, the field thins, the glow comes back.
   The focus set (selected + its 10 neighbours) always keeps its halo: 11 calls cost nothing. */
const HALO_R = 12, HALO_FULL = 150, HALO_NONE = 320;
// reused per-frame scratch: screen coords bucketed by family × muted, plus the focus set
const buck = FAMILIES.flatMap(() => [new Float32Array(N * 2), new Float32Array(N * 2)]);
const bCount = new Int32Array(FAMILIES.length * 2);
const special: Pt[] = [];
const haloSprite = FAMILIES.map((F) => {
  const c = document.createElement('canvas'); c.width = c.height = HALO_R * 2;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(HALO_R, HALO_R, 0, HALO_R, HALO_R, HALO_R);
  gr.addColorStop(0, `rgba(${F.rgb[0]},${F.rgb[1]},${F.rgb[2]},1)`);
  gr.addColorStop(1, `rgba(${F.rgb[0]},${F.rgb[1]},${F.rgb[2]},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, HALO_R * 2, HALO_R * 2); return c;
});
function draw() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, Vw, Vh);
  const r = pr(), focus = selected >= 0;
  const contFade = focus ? 0.12 : Math.max(0, Math.min(1, (sFit * 3.0 - scale) / (sFit * 1.6)));

  // continents: soft fill + coastline
  if (contFade > 0.01) {
    ctx.save();
    ctx.globalAlpha = contFade * (activeFam >= 0 ? 0.5 : 1);
    ctx.setTransform(DPR * scale, 0, 0, DPR * scale, DPR * ox, DPR * oy);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(fieldCanvas, 0, 0, G, G, FX0, FY0, FW, FH);
    // coastlines: cached world-space paths stroked under the same transform. Re-projecting
    // 1,386 segments into screen space every frame cost 3.5 ms of the phone's frame budget.
    ctx.lineWidth = 1.1 / scale;
    for (let k = 0; k < coastPath.length; k++) {
      const c = coasts[k]; if (activeFam >= 0 && activeFam !== c.f) continue;
      const col = FAMILIES[c.f].rgb;
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${0.34 * contFade})`;
      ctx.stroke(coastPath[k]);
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

  // Points. Ordinary points are bucketed by family + muted state and drawn as ONE path per
  // bucket (≤20 canvas ops instead of 893×4); only the focus set — selected, its neighbours,
  // the hovered dot — is drawn individually, because only those vary in size and weight.
  // Buffers are module-level and reused: a pan redraws ~60 times a second, and per-frame
  // allocation was showing up as GC jitter in the frame times.
  const NF = FAMILIES.length;
  special.length = 0; bCount.fill(0);
  let plain = 0;
  for (const p of P) {
    const X = sx(p.wx), Y = sy(p.wy);
    if (!(X > -30 && X < Vw + 30 && Y > -30 && Y < Vh + 30)) continue; // cull off-screen AND reject non-finite (never feed NaN to the transform)
    if (p.i === selected || p.i === hovered || focusSet.has(p.i)) { special.push(p); continue; }
    const muted = focus || (activeFam >= 0 && p.fam !== activeFam);
    const k = p.fam * 2 + (muted ? 1 : 0), a = buck[k], n = bCount[k];
    a[n] = X; a[n + 1] = Y; bCount[k] = n + 2; plain++;
  }

  // halo pass — ambient glow first, focus-set halos on top
  const spend = (HALO_NONE - plain) / (HALO_NONE - HALO_FULL);
  const ambientA = 0.16 * (spend < 0 ? 0 : spend > 1 ? 1 : spend);
  if (ambientA > 0.004) {
    const HR = r * 2.6;
    ctx.globalAlpha = ambientA;
    for (let f = 0; f < NF; f++) {
      const a = buck[f * 2], n = bCount[f * 2]; if (!n) continue;   // muted points never had a halo
      const sp = haloSprite[f];
      for (let i = 0; i < n; i += 2) ctx.drawImage(sp, a[i] - HR, a[i + 1] - HR, HR * 2, HR * 2);
    }
    ctx.globalAlpha = 1;
  }
  for (const p of special) {
    const isSel = p.i === selected, isNb = focusSet.has(p.i), isHov = p.i === hovered;
    const muted = (focus && !isSel && !isNb) || (activeFam >= 0 && p.fam !== activeFam);
    const ha = muted ? 0 : (isSel ? 0.42 : isNb ? 0.34 : 0.16); if (ha <= 0) continue;
    const X = sx(p.wx), Y = sy(p.wy), HR = r * (isSel ? 1.7 : isNb ? 1.25 : 1) * (isHov ? 1.4 : 1) * 2.6;
    ctx.globalAlpha = ha; ctx.drawImage(haloSprite[p.fam], X - HR, Y - HR, HR * 2, HR * 2);
  }
  ctx.globalAlpha = 1;

  // core pass — batched: one path per (family, muted) bucket, built straight on the context
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  for (let f = 0; f < NF; f++) for (let m = 0; m < 2; m++) {
    const a = buck[f * 2 + m], n = bCount[f * 2 + m]; if (!n) continue;
    ctx.beginPath();
    for (let i = 0; i < n; i += 2) { ctx.moveTo(a[i] + r, a[i + 1]); ctx.arc(a[i], a[i + 1], r, 0, 7); }
    const c = FAMILIES[f].rgb;
    ctx.globalAlpha = m ? 0.14 : 1; ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.fill();
    ctx.globalAlpha = m ? 0.10 : 0.9; ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const p of special) {
    const isSel = p.i === selected, isNb = focusSet.has(p.i), isHov = p.i === hovered;
    const muted = (focus && !isSel && !isNb) || (activeFam >= 0 && p.fam !== activeFam);
    const rr = r * (isSel ? 1.7 : isNb ? 1.25 : 1) * (isHov ? 1.4 : 1), c = FAMILIES[p.fam].rgb;
    const X = sx(p.wx), Y = sy(p.wy);
    ctx.globalAlpha = muted ? 0.14 : 1;
    ctx.beginPath(); ctx.arc(X, Y, rr, 0, 7); ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.fill();
    ctx.globalAlpha = muted ? 0.10 : 0.9; ctx.lineWidth = isSel ? 2 : 1;
    ctx.strokeStyle = isSel ? '#fff' : `rgba(255,255,255,0.6)`; ctx.stroke();
    ctx.globalAlpha = 1;
    // ring the selected point — and the peeked one, whose card is docked at the bottom of the
    // screen on a phone and so needs the map to say which dot it is talking about
    if (isSel || (isHov && !muted)) {
      ctx.beginPath(); ctx.arc(X, Y, rr + 4, 0, 7);
      ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.lineWidth = 1.5; ctx.stroke();
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
// The region names are set once per breakpoint (they are the phone's colour key, so they must
// fit it) and their half-widths cached — measuring 7 elements every frame would thrash layout.
let regionMode = -1;
const regionHalf: number[] = [];
function syncRegionText() {
  const m = isMobile() ? 1 : 0; if (m === regionMode) return; regionMode = m;
  regionEls.forEach((el, f) => {
    el.innerHTML = (m ? FAMILIES[f].short : FAMILIES[f].name).replace(/ & /g, ' &amp; ');
    el.style.opacity = '0'; regionHalf[f] = 0;
  });
}
const pool: HTMLDivElement[] = [];
// Half-width estimate at 11px Archivo (~5.6 px/char). The old 78px ceiling under-measured every
// long title — "Environmental Scientists and Specialists, Including Health" is ~165px per side —
// so the collision test cleared labels that then overlapped. Cheap estimate, no forced layout.
function estHalf(t: string) { return Math.min(190, 10 + t.length * 2.85); }
function drawLabels(focus: boolean, _contFade: number) {
  // region labels (coherent families), fade out as you zoom in
  syncRegionText();
  const showReg = !focus && scale < sFit * 2.9;
  const shown: { el: HTMLDivElement; x: number; y: number; f: number }[] = [];
  regionEls.forEach((el, f) => {
    if (!showReg || !labelAnchor[f] || (activeFam >= 0 && activeFam !== f)) { el.style.opacity = '0'; return; }
    shown.push({ el, x: sx(labelAnchor[f]!.wx), y: sy(labelAnchor[f]!.wy), f });
  });
  shown.sort((a, b) => a.y - b.y);
  for (let i = 1; i < shown.length; i++) { const a = shown[i - 1], b = shown[i]; if (Math.abs(b.x - a.x) < 160 && b.y - a.y < 24) b.y = a.y + 24; }
  const rf = Math.max(0, Math.min(1, (sFit * 2.9 - scale) / (sFit * 1.0)));
  shown.forEach((s) => {
    // hold the whole label on screen — a key that runs off the edge is not a key
    if (!regionHalf[s.f]) regionHalf[s.f] = s.el.offsetWidth / 2;
    const hw = regionHalf[s.f] + 8;
    s.el.style.opacity = String(rf);
    s.el.style.left = Math.max(hw, Math.min(Vw - hw, s.x)) + 'px';
    s.el.style.top = Math.max(11, Math.min(Vh - 11, s.y)) + 'px';
  });

  // point labels
  const items: { p: Pt; strong: boolean; y?: number }[] = [];
  const headerBox = (x: number) => x < 356;   // keep labels out from under the title block (top-left)
  if (focus) {
    // selected pinned; neighbours vertically de-collided so none overlap
    const yOf = (p: Pt) => sy(p.wy) - pr() - 9;
    // Phone: name ONLY the selected job. Even three neighbour labels crowded the narrow band
    // above the sheet into unreadability, and the neighbours are already named — in rank order,
    // with their similarity — by the list right below. The dots stay; the list is the legend,
    // and tapping a dot points at its row (highlightNb) instead of naming it twice.
    const nbN = isMobile() ? 0 : NEIGH[selected].n.length;
    const nbItems = NEIGH[selected].n.slice(0, nbN).map((ni) => ({ p: P[ni], x: sx(P[ni].wx), y: yOf(P[ni]), strong: false }));
    nbItems.sort((a, b) => a.y - b.y);
    for (let i = 1; i < nbItems.length; i++) { const a = nbItems[i - 1], b = nbItems[i]; if (Math.abs(b.x - a.x) < 130 && b.y - a.y < 17) b.y = a.y + 17; }
    items.push({ p: P[selected], strong: true, y: sy(P[selected].wy) - pr() * 1.7 - 9 });
    nbItems.forEach((it) => items.push(it));
    // the de-collision cascade below stacks labels 17px apart with no upper bound —
    // hold them inside the *visible band*: on a phone the bottom sheet covers the lower
    // half of the viewport, and a label that lands under it is a label nobody reads
    const floor = (isMobile() && panelOpen ? Vh - document.getElementById('panel')!.offsetHeight : Vh) - 14;
    for (const it of items) if (it.y !== undefined) it.y = Math.max(14, Math.min(floor, it.y));
  } else {
    // The hover tooltip / touch peek callout owns the hovered point's title, so the map
    // adds no label of its own for it. Two boxes on screen at once (black tip over a
    // leftover white label) was the bug.
    // fewer in-map labels on a phone: same zoom, a third of the width to place them in
    const cap = Math.max(0, Math.round((scale / sFit - 1.7) * (isMobile() ? 10 : 26)));
    if (cap > 0) {
      // keep labels out from under the chrome. On a phone that chrome spans the full width —
      // wordmark + thesis + search bar on top, key + sources at the bottom — so the exclusion
      // is a band, not the desktop's top-left box.
      const mob = isMobile(), topBand = mob ? 148 : 96, botBand = mob ? 132 : 118;
      const cand = P.filter((p) => {
        const X = sx(p.wx), Y = sy(p.wy), hw = estHalf(COORDS[p.i].title);
        return X - hw > 12 && X + hw < Vw - 12 && Y > topBand && Y < Vh - botBand
          && (mob || !(headerBox(X) && Y < 128)) && p.i !== hovered;
      }).sort((a, b) => (b.jz - a.jz) || (a.wx - b.wx));
      const placed = items.map((it) => ({ x: sx(it.p.wx), y: sy(it.p.wy), hw: 60 }));
      const vGap = isMobile() ? 22 : 17;   // a phone has a third of the width to place them in
      for (const p of cand) {
        if (items.length >= cap) break;
        const X = sx(p.wx), Y = sy(p.wy), hw = estHalf(COORDS[p.i].title);
        let ok = true; for (const q of placed) { if (Math.abs(q.x - X) < hw + q.hw && Math.abs(q.y - Y) < vGap) { ok = false; break; } }
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
    // hold the label on screen (estimated half-width — measuring 11 elements a frame thrashes
    // layout); a job title clipped by the screen edge names nothing
    const hw = Math.min(COORDS[p.i].title.length * 2.8 + 8, Vw / 2 - 6);
    e.style.left = Math.max(hw, Math.min(Vw - hw, sx(p.wx))) + 'px';
    e.style.top = (y !== undefined ? y : (sy(p.wy) - pr() * (strong ? 1.7 : 1) - 9)) + 'px';
    e.className = 'plabel' + ((strong || focus) ? ' lead' : '');
    e.style.fontWeight = strong ? '700' : '500';
    e.style.color = strong ? 'var(--ink)' : 'var(--ink-soft)';
    e.style.fontSize = strong ? '12.5px' : '11px';
  });
}

/* ---------- picking ---------- */
// A fingertip is ~9 mm; a fitted dot is ~3 px. Touch gets a 22 px catch radius (nearest wins)
// instead of the cursor's 6 — safe because the first tap only *peeks*, it doesn't commit.
function pick(mx: number, my: number, touch?: boolean) {
  let best = -1, bd = 1e9, r = pr() + (touch ? 22 : 6);
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
    // Mobile: the detail is a bottom sheet, not a full-screen takeover — the constellation of
    // 11 related jobs stays visible in the band above it, so "jobs like this" reads spatially
    // and as a list at the same time (ticket 05). Reserve the sheet's own height, measured
    // from the element (offsetHeight ignores the slide-in transform).
    const mob = isMobile();
    const w = Math.max(x1 - x0, 60), h = Math.max(y1 - y0, 60);
    const sheet = mob ? document.getElementById('panel')!.offsetHeight : 0;
    const padL = mob ? 22 : 110, padR = mob ? 22 : 384, padT = mob ? 22 : 150, padB = mob ? sheet + 22 : 150;
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
  syncClamp(pn.querySelector('.desc')!.parentElement as HTMLElement, false);
  const nb = NEIGH[i], host = document.getElementById('nbs')!; host.innerHTML = '';
  for (let j = 0; j < nb.n.length; j++) {
    const p = nb.n[j], nd = COORDS[p], nf = FAMILIES[P[p].fam], pct = Math.round(nb.s[j] * 100);
    const b = document.createElement('button'); b.className = 'nb';
    b.dataset.i = String(p);                    // lets a tap on the dot find this row (highlightNb)
    b.innerHTML = `<span class="rk">${j + 1}</span><span class="sw" style="background:${nf.color}"></span>` +
      `<span class="t">${nd.title}<small>${nd.major_group}</small></span>` +
      `<span class="bar"><span class="track"><span class="fill" style="width:${(nb.s[j] * 100).toFixed(0)}%;background:${nf.color}"></span></span>` +
      `<span class="pct">${pct}%</span></span>`;
    b.onclick = () => select(p); host.appendChild(b);
  }
  host.scrollTop = 0;
}

/* A tap on a neighbour dot answers itself in the list: no re-select, no re-frame. Re-selecting
   moved the ground under the user — a new neighbour set, a new camera — when all they asked was
   "which one is that?". So the dot rings, and its ranked row scrolls up and lights. */
function highlightNb(i: number) {
  const host = document.getElementById('nbs')!;
  const el = host.querySelector(`.nb[data-i="${i}"]`) as HTMLElement | null;
  if (!el) return;
  host.querySelectorAll('.nb.hi').forEach((x) => x.classList.remove('hi'));
  el.classList.add('hi');
  // scroll the row into the middle of the list's own scroller. Deliberately NOT
  // scrollIntoView(): that walks up and scrolls ancestors too, and on iOS scrolling the
  // document out from under a fixed layout is exactly the class of bug we are chasing.
  const top = host.scrollTop + el.getBoundingClientRect().top - host.getBoundingClientRect().top
    - (host.clientHeight - el.offsetHeight) / 2;
  host.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  hovered = i; invalidate();
}

/* ---------- clamped copy: show the control only when something is actually hidden ---------- */
function syncClamp(wrap: HTMLElement, keepOpen: boolean) {
  const btn = wrap.querySelector('.more') as HTMLButtonElement | null;
  const txt = wrap.querySelector('p, .desc') as HTMLElement | null;
  if (!btn || !txt) return;
  if (!keepOpen) { wrap.classList.remove('open'); btn.textContent = 'More'; btn.setAttribute('aria-expanded', 'false'); }
  // measured against the collapsed box, so it must run while collapsed; a blurb that already
  // fits gets no control at all (a "More" that reveals nothing is the same lie as the cut).
  btn.hidden = wrap.classList.contains('open') ? false : txt.scrollHeight <= txt.clientHeight + 1;
}
// The header and the search bar are both absolutely positioned, so nothing reflows when the
// thesis grows — the revealed line would simply land under the search box (and be unclickable).
// Publish the header's measured height instead of hard-coding a second magic top.
function layoutHead() {
  document.documentElement.style.setProperty('--search-top', document.getElementById('head')!.offsetHeight + 'px');
}
document.querySelectorAll<HTMLElement>('.clamp-wrap').forEach((wrap) => {
  const btn = wrap.querySelector('.more') as HTMLButtonElement | null;
  if (!btn) return;
  btn.onclick = (e) => {
    e.stopPropagation();
    const open = wrap.classList.toggle('open');
    btn.textContent = open ? 'Less' : 'More';
    btn.setAttribute('aria-expanded', String(open));
    if (!open) syncClamp(wrap, false);
    layoutHead();
  };
});
function openPanel(on: boolean) {
  panelOpen = on; document.getElementById('panel')!.classList.toggle('on', on);
  // mobile: the sheet owns the bottom half, so the entry chrome (wordmark, search, key) steps
  // aside — the map band above the sheet is small enough that every pixel of it counts
  document.body.classList.toggle('panel-open', on);
}

/* ---------- peek callout: touch two-stage tap (first tap = peek, second tap / "Find similar" = commit, §6.3) ---------- */
const peek = document.createElement('div'); peek.id = 'peek';
peek.innerHTML = '<span class="pk-sw"></span><span class="pk-t"></span><button class="pk-go" type="button">Find similar →</button>';
document.body.appendChild(peek);
(peek.querySelector('.pk-go') as HTMLButtonElement).onclick = (e) => { e.stopPropagation(); if (peekIdx >= 0) { const i = peekIdx; hidePeek(); select(i); } };
function showPeek(i: number) {
  peekIdx = i; const d = COORDS[i], f = FAMILIES[P[i].fam];
  (peek.querySelector('.pk-sw') as HTMLElement).style.background = f.color;
  (peek.querySelector('.pk-t') as HTMLElement).innerHTML = `${d.title}<em>${f.name}</em>`;
  peek.classList.add('on'); document.body.classList.add('peeking');
  if (isMobile()) { peek.style.left = peek.style.top = ''; }   // docked by CSS — see below
  else {
    // clamp inside the viewport: the callout is wide and dots go right to the screen edge
    const hw = peek.offsetWidth / 2 + 10, X = sx(P[i].wx), Y = sy(P[i].wy) - pr() - 12;
    peek.style.left = Math.max(hw, Math.min(Vw - hw, X)) + 'px';
    peek.style.top = Math.max(peek.offsetHeight + 8, Y) + 'px';
  }
  hovered = i; invalidate();
}
function hidePeek() {
  if (peekIdx < 0) return;
  peekIdx = -1; peek.classList.remove('on'); document.body.classList.remove('peeking');
  hovered = -1; invalidate();
}

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
    pinch = { d: nd, mx, my }; moved = true; anim = null; hidePeek(); invalidate(); return;
  }
  if (drag) {
    const dx = e.clientX - lx, dy = e.clientY - ly; if (Math.abs(dx) + Math.abs(dy) > 3) { moved = true; hidePeek(); }
    ox += dx; oy += dy; lx = e.clientX; ly = e.clientY; anim = null; invalidate(); return;
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
    const i = pick(e.clientX, e.clientY, e.pointerType === 'touch');
    if (e.pointerType === 'touch') {
      // inside a phone's focus view the neighbour dots are unlabelled, so a tap on one is a
      // question — "which of these is that?" — not a request to go there. Answer it in the list.
      if (i >= 0 && isMobile() && selected >= 0 && focusSet.has(i)) { hidePeek(); highlightNb(i); return; }
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
  ox = e.clientX - (e.clientX - ox) * k; oy = e.clientY - (e.clientY - oy) * k; scale = ns; invalidate();
}, { passive: false });

/* ---------- legend ---------- */
const leg = document.getElementById('legend')!;
FAMILIES.forEach((f, i) => {
  const el = document.createElement('div'); el.className = 'fam' + (f.distributed ? ' scatter' : '');
  el.dataset.f = String(i);
  // both names ship; CSS picks one. On a phone the legend is the ONLY key for the three
  // distributed families (they get no region label because they have no territory).
  el.innerHTML = `<span class="glyph${f.distributed ? ' dist' : ''}" style="background:${f.color};color:${f.color}"></span>` +
    `<span class="nm${f.distributed ? ' dist' : ''}">${f.name}</span>` +
    `<span class="nm-s${f.distributed ? ' dist' : ''}">${f.short}</span><span class="ct">${famCount[i]}</span>`;
  el.title = f.distributed ? 'Scattered across the map — these roles sit near the work they serve' : '';
  el.onclick = () => {
    activeFam = activeFam === i ? -1 : i;
    [...leg.querySelectorAll('.fam')].forEach((x) => {
      const on = activeFam === +(x as HTMLElement).dataset.f!;
      x.classList.toggle('off', activeFam >= 0 && !on); x.classList.toggle('on', on);
    });
    invalidate();
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
addEventListener('resize', () => { DPR = Math.min(devicePixelRatio || 1, 2); resize(); syncClamps(); });
/* The canvas box is `position:fixed; inset:0`, so iOS Safari resizes it whenever the URL bar
   collapses or expands — and that does not reliably fire window's `resize`. Vw/Vh would stay
   stale, the Vh*DPR-tall buffer would be squashed into a shorter box, and every dot would render
   above where sy() puts it while pick() still compares raw clientY against sy(): taps land on the
   dot ABOVE the finger, and only a reload clears it (ticket 06 #2). Observe the box itself rather
   than guessing which event a platform fires, and re-sync WITHOUT re-framing — fitAll() here would
   throw away the reader's pan and zoom every time the URL bar moved. */
new ResizeObserver(() => {
  const w = vpW(), h = vpH();
  if (Math.abs(w - Vw) < 0.5 && Math.abs(h - Vh) < 0.5) return;
  Vw = w; Vh = h; map.width = Vw * DPR; map.height = Vh * DPR; invalidate();
}).observe(map);
// whether the copy overflows depends on the width it is measured at, so re-test on every
// breakpoint change: the control must appear on a phone and disappear on a desktop.
function syncClamps() { document.querySelectorAll<HTMLElement>('.clamp-wrap').forEach((w) => syncClamp(w, w.classList.contains('open'))); layoutHead(); }

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
syncClamps();
// the thesis is set in Archivo; measured against the fallback face it can look like it fits
// when the real one wraps, so re-test once the webfont has actually landed
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { invalidate(); syncClamps(); });
// dev-only measurement hook (stripped from the production bundle) — frame-budget checks, ticket 05
if (import.meta.env.DEV) (window as any).__mm = {
  draw, bounds: [BX0, BY0, BX1, BY1],
  get view() { return { scale, sFit, Vw, Vh, ox, oy, mobile: isMobile() }; },
  screenOf: (i: number) => ({ x: sx(P[i].wx), y: sy(P[i].wy) }),   // lets a test tap an actual dot
};
