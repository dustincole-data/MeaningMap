/* Similarity-encoding checks: the focus view's leader lines AND the panel's ranked list.
   Measures what is actually LAID DOWN — ink sampled from a screenshot, bar widths read off the
   rendered boxes — never the formula. Both encodings shipped once in a state where the formula
   was right and the picture was unreadable (the leaders' rank-fit was 0.01 on desktop; the bars
   put 95% and 85% four pixels apart on a 42px track), and no assertion over the source can tell
   "faint but correct" from "noise".
   Run: npm run check:sim   (needs `npm run dev` on MM_URL) */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ART, DATA, PHONE, DESKTOP, ok, launch, newPage, openJob, report } from './lib.mjs';

const JOB = 'Registered Nurses';
const TRACK = 42;                                    // .nb .bar .track width, from global.css

/* Ink under a line: sum of darkness over a perpendicular cross-section, background-subtracted.
   Median over three positions along the line so a crossing line / label / dot cannot dominate.
   Runs INSIDE the page — shipping an 11 M-element pixel array over CDP is not a thing. */
const INK_SRC = `(img, S, E, k) => {
  const dx = E.x - S.x, dy = E.y - S.y, L = Math.hypot(dx, dy);
  const px = -dy / L, py = dx / L;                        // unit perpendicular
  const at = (x, y) => {
    const X = Math.round(x * k), Y = Math.round(y * k);
    if (X < 0 || Y < 0 || X >= img.w || Y >= img.h) return null;
    const o = (Y * img.w + X) * 4;
    return 0.2126 * img.d[o] + 0.7152 * img.d[o + 1] + 0.0722 * img.d[o + 2];
  };
  const per = [];
  for (const f of [0.34, 0.5, 0.66]) {
    const cx = S.x + dx * f, cy = S.y + dy * f;
    const samp = [];
    for (let o = -7; o <= 7; o += 0.5) samp.push([o, at(cx + px * o, cy + py * o)]);
    if (samp.some((s) => s[1] === null)) continue;
    const outer = samp.filter((s) => Math.abs(s[0]) >= 5.5).map((s) => s[1]).sort((a, b) => a - b);
    const bg = outer[outer.length >> 1];
    let ink = 0;
    for (const s of samp) if (Math.abs(s[0]) <= 4) ink += Math.max(0, bg - s[1]);
    per.push(ink);
  }
  if (!per.length) return null;
  per.sort((a, b) => a - b);
  return per[per.length >> 1];
}`;

/* Spearman of rendered value against rank position. 1 = the picture states the ranking exactly;
   ~0 = the picture is noise, which is what a range statistic alone cannot distinguish. */
const rho = (v) => {
  const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
  const rk = []; idx.forEach(([, i], r) => (rk[i] = r + 1));
  const n = v.length, d2 = rk.reduce((s, r, i) => s + (r - (n - i)) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
};

const browser = await launch();

async function run(name, opts, dpr) {
  const shot = name === 'mobile' ? 'mob' : 'desk';
  const { ctx, page } = await newPage(browser, opts, name);
  await openJob(page, JOB, 1400);

  /* ---------- 1. the leader formula, as the renderer computes it ---------- */
  const L = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#nbs .nb')].map((b) => +b.dataset.i);
    let i = -1;
    for (let x = 0; x < 900; x++) {
      const l = window.__mm.leaders(x);
      if (l.length === rows.length && l.every((e, j) => e.n === rows[j])) { i = x; break; }
    }
    const led = window.__mm.leaders(i);
    return { i, led, sel: window.__mm.screenOf(i), pts: led.map((e) => window.__mm.screenOf(e.n)), title: document.querySelector('#panel h2').textContent };
  });
  ok(`${name} found the selected job`, L.i >= 0 && L.title === JOB, `${L.title} idx=${L.i}`);
  const w = L.led.map((e) => e.w), a = L.led.map((e) => e.a);
  ok(`${name} weight is monotone: rank 1 thickest -> rank 10 thinnest`,
    w.every((v, j) => j === 0 || w[j - 1] >= v - 1e-9), w.map((v) => v.toFixed(2)).join(' '));
  ok(`${name} ink is monotone: rank 1 darkest -> rank 10 faintest`,
    a.every((v, j) => j === 0 || a[j - 1] >= v - 1e-9), a.map((v) => v.toFixed(3)).join(' '));
  ok(`${name} rank 1 is >=2.5x the weight of rank 10`, w[0] / w[9] >= 2.5, `${w[0].toFixed(2)} vs ${w[9].toFixed(2)} = ${(w[0] / w[9]).toFixed(1)}x`);
  ok(`${name} rank 1 is >=2.5x the alpha of rank 10`, a[0] / a[9] >= 2.5, `${a[0].toFixed(3)} vs ${a[9].toFixed(3)} = ${(a[0] / a[9]).toFixed(1)}x`);
  ok(`${name} rank 1 vs rank 2 is a visible step`, (w[0] - w[1]) >= 0.15 || (a[0] - a[1]) >= 0.03,
    `dw=${(w[0] - w[1]).toFixed(2)} da=${(a[0] - a[1]).toFixed(3)}`);

  /* ---------- 2. the leaders as RENDERED: ink off a live screenshot ---------- */
  const file = `${ART}/sim-${shot}-focus.png`;
  await page.screenshot({ path: file });
  const b64 = (await readFile(file)).toString('base64');
  const ink = await page.evaluate(async ([s, sel, pts, k, src]) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + s)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const img = { w: bmp.width, h: bmp.height, d: g.getImageData(0, 0, bmp.width, bmp.height).data };
    const f = eval(src);
    return pts.map((p) => f(img, sel, p, k));
  }, [b64, L.sel, L.pts, dpr, INK_SRC]);
  const seen = ink.filter((x) => x !== null);
  const lo = Math.min(...seen), hi = Math.max(...seen);
  console.log(`  ${name} leader ink  ${ink.map((v) => v === null ? '--' : v.toFixed(0)).join(' ')}   range ${(hi / Math.max(lo, 1)).toFixed(2)}x  rank-fit ${rho(ink).toFixed(2)}`);
  ok(`${name} at least 8 of the 10 leaders are on screen to measure`, seen.length >= 8, `${seen.length}/10`);
  ok(`${name} rendered ink states the ranking (rank-fit >=0.9)`, rho(ink) >= 0.9, `rank-fit ${rho(ink).toFixed(2)}`);
  ok(`${name} strongest:weakest rendered ink is >=5:1`, hi / Math.max(lo, 1) >= 5, `${(hi / Math.max(lo, 1)).toFixed(2)}x`);
  ok(`${name} the faint end stays visible, not erased`, lo > 4, `lo=${lo.toFixed(0)}`);

  /* ---------- 3. a flat fan must NOT get a gradient invented for it ---------- */
  const flat = await page.evaluate(() => {
    const all = []; let bi = -1, bs = 9;
    for (let i = 0; i < 5000; i++) {
      let l; try { l = window.__mm.leaders(i); } catch { break; }        // past the last occupation
      if (!l.length) break;
      const sp = l[0].s - l[l.length - 1].s; all.push(sp); if (sp < bs) { bs = sp; bi = i; }
    }
    let wi = -1, ws = 0;
    for (let i = 0; i < all.length; i++) if (all[i] > ws) { ws = all[i]; wi = i; }
    return { spread: bs, w: window.__mm.leaders(bi).map((e) => e.w), wide: { spread: ws, w: window.__mm.leaders(wi).map((e) => e.w) } };
  });
  ok(`${name} a flat fan (spread ${flat.spread.toFixed(3)}) reads as flat, no invented ramp`,
    flat.w[0] / flat.w[9] < 1.35, `${flat.w[0].toFixed(2)}..${flat.w[9].toFixed(2)} = ${(flat.w[0] / flat.w[9]).toFixed(2)}x`);
  ok(`${name} a wide fan (spread ${flat.wide.spread.toFixed(3)}) uses the full range`,
    flat.wide.w[0] / flat.wide.w[9] >= 3, `${(flat.wide.w[0] / flat.wide.w[9]).toFixed(1)}x`);

  /* ---------- 4. the list's bars, measured off the rendered boxes ---------- */
  const bars = await page.evaluate(() => [...document.querySelectorAll('#nbs .nb')].map((r) => ({
    pct: +r.querySelector('.pct').textContent.replace('%', ''),
    fill: +r.querySelector('.fill').getBoundingClientRect().width.toFixed(2),
    track: +r.querySelector('.track').getBoundingClientRect().width.toFixed(2),
  })));
  console.log(`  ${name} bar px      ${bars.map((b) => b.fill.toFixed(1)).join(' ')}   for  ${bars.map((b) => b.pct + '%').join(' ')}`);
  ok(`${name} the list renders all 10 bars`, bars.length === 10, `${bars.length}`);
  ok(`${name} bars are monotone down the ranks`, bars.every((b, j) => j === 0 || bars[j - 1].fill >= b.fill - 0.02),
    bars.map((b) => b.fill.toFixed(1)).join(' '));
  ok(`${name} no bar renders empty (a zero track reads as "no data")`, Math.min(...bars.map((b) => b.fill)) >= 2,
    `min=${Math.min(...bars.map((b) => b.fill)).toFixed(1)}px`);
  ok(`${name} no bar overflows its track`, bars.every((b) => b.fill <= b.track + 0.5), `track=${bars[0].track}px`);
  ok(`${name} equal percentages render equal bars`,
    bars.every((b) => bars.filter((o) => o.pct === b.pct).every((o) => Math.abs(o.fill - b.fill) < 0.6)));
  // the reported bug: 95% and 85% were 4px apart on a 42px track. 10 points of similarity has to
  // be a step the eye can take, not a rounding difference.
  const pairs = bars.flatMap((b, i) => bars.slice(i + 1).map((o) => ({ d: b.pct - o.pct, px: b.fill - o.fill })));
  const tenPt = pairs.filter((p) => p.d >= 10);
  ok(`${name} a 10-point similarity gap is >=8px of bar`, tenPt.length > 0 && tenPt.every((p) => p.px >= 8),
    tenPt.map((p) => `${p.d}pt=${p.px.toFixed(1)}px`).join(' ') || 'no 10-point pair in this fan');

  await page.screenshot({
    path: `${ART}/sim-${shot}-zoom.png`,
    clip: {
      x: Math.max(0, L.sel.x - 210), y: Math.max(0, L.sel.y - 127),
      width: Math.min(420, opts.viewport.width), height: Math.min(380, opts.viewport.height - (name === 'mobile' ? 380 : 0)),
    },
  });
  await ctx.close();
}

await run('mobile', PHONE, 3);
await run('desktop', DESKTOP, 1);

/* ---------- 5. the bar scale over ALL 893 fans, not just the one on screen ---------- */
const { ctx, page } = await newPage(browser, DESKTOP, 'scale');
const NEIGH = JSON.parse(await readFile(join(DATA, 'neighbors.json'), 'utf8'));
const scale = await page.evaluate((S) => {
  // rounded exactly as fillPanel does it — the bar is a picture of the printed percentage
  const fills = S.map((s) => s.map((v) => window.__mm.simFill(Math.round(v * 100))));
  const gaps = fills.map((F) => F[0] - F[F.length - 1]);
  const flat = fills.flat();
  return {
    min: Math.min(...flat), max: Math.max(...flat),
    monotone: fills.every((F) => F.every((v, j) => j === 0 || F[j - 1] >= v - 1e-9)),
    worstGap: Math.min(...gaps), medGap: gaps.slice().sort((a, b) => a - b)[gaps.length >> 1],
    fans: fills.length,
  };
}, NEIGH.map((e) => e.s));
const px = (p) => (p / 100 * TRACK);
console.log(`  scale over ${scale.fans} fans: fill ${scale.min.toFixed(0)}-${scale.max.toFixed(0)}%  worst rank1-rank10 gap ${px(scale.worstGap).toFixed(1)}px  median ${px(scale.medGap).toFixed(1)}px`);
ok('bar scale is monotone in similarity for every fan', scale.monotone);
ok('bar scale never bottoms out (floor keeps the weakest visible)', px(scale.min) >= 2, `min=${px(scale.min).toFixed(1)}px`);
ok('bar scale never overflows the track', scale.max <= 100.001, `max=${scale.max.toFixed(1)}%`);
// the old absolute 0-100% scale put the whole atlas between 29.5 and 40.8px: the tightest fan's
// rank1 and rank10 were 0.7px apart. Every fan now has to separate its ends by an eye's worth.
ok('every fan separates rank 1 from rank 10 by >=2px', px(scale.worstGap) >= 2, `worst=${px(scale.worstGap).toFixed(1)}px`);
ok('the typical fan spends >=8px of the track', px(scale.medGap) >= 8, `median=${px(scale.medGap).toFixed(1)}px`);
await ctx.close();

await browser.close();
report();
