/* UI / chrome / interaction checks. Phone first (every mobile feature here was written for a
   real device bug), then a desktop regression pass.
   Run: npm run check   (needs `npm run dev` on MM_URL) */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ART, DATA, PHONE, DESKTOP, ok, launch, newPage, openJob, report } from './lib.mjs';

const browser = await launch();
const { page } = await newPage(browser, PHONE, 'phone');

/* helper: a real two-stage touch tap at page coords */
const tap = async (x, y) => {
  await page.evaluate(([x, y]) => {
    const st = document.getElementById('stage');
    const base = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 1 };
    st.dispatchEvent(new PointerEvent('pointerdown', base));
    st.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
  }, [x, y]);
  await page.waitForTimeout(120);
};

/* ---------- the shared dustincoledata brand mark ---------- */
const sig = await page.evaluate(() => {
  const a = document.querySelector('.dcd-mark');
  const r = a.getBoundingClientRect(), h1El = document.querySelector('#head h1'), h1 = h1El.getBoundingClientRect();
  const cs = getComputedStyle(a);
  return {
    href: a.getAttribute('href'), text: a.innerText.trim().replace(/\s+/g, ' '),
    target: a.getAttribute('target'), rel: a.getAttribute('rel'), label: a.getAttribute('aria-label'),
    name: a.querySelector('.dcd-mark-name')?.textContent, suffix: a.querySelector('.dcd-mark-suffix')?.textContent,
    radius: cs.borderRadius, nameSize: getComputedStyle(a.querySelector('.dcd-mark-name')).fontSize,
    sufSize: getComputedStyle(a.querySelector('.dcd-mark-suffix')).fontSize,
    sufTrack: getComputedStyle(a.querySelector('.dcd-mark-suffix')).letterSpacing,
    hasScrim: cs.backgroundColor !== 'rgba(0, 0, 0, 0)',
    // the pill has a visible border, so the BOX edge is the edge the reader sees
    right: Math.round(innerWidth - r.right),
    top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width),
    centreDelta: Math.round(((r.top + r.bottom) / 2) - ((h1.top + h1.bottom) / 2)),
    // h1 is a full-width flex box on a phone; its RENDERED TEXT is what could collide
    overlapsWordmark: (() => {
      const rg = document.createRange(); rg.selectNodeContents(h1El);
      return rg.getBoundingClientRect().right > r.left;
    })(),
    pe: cs.pointerEvents, z: cs.zIndex,
    atPoint: (() => { const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el && el.closest('.dcd-mark') ? 'mark' : (el ? el.id || el.tagName : 'none'); })(),
  };
});
/* the mark must be the SHARED one, not a local invention — compare against the canonical spec
   used by Where America Moves / Real Price / Redraft */
ok('mark href -> dustincoledata.com', sig.href === 'https://dustincoledata.com', sig.href);
ok('mark opens in a new tab, safely', sig.target === '_blank' && sig.rel === 'noopener', `${sig.target}/${sig.rel}`);
ok('mark keeps the canonical aria-label', sig.label === 'A Dustin Cole Data project', sig.label);
ok('mark is "Dustin Cole" + "Data"', sig.name === 'Dustin Cole' && sig.suffix === 'Data', `${sig.name}|${sig.suffix}`);
ok('mark keeps the pill shape', sig.radius.startsWith('999'), sig.radius);
ok('mark keeps canonical type (13px name / 9px tracked suffix)',
  sig.nameSize === '13px' && sig.sufSize === '9px' && sig.sufTrack.startsWith('1.44'), `${sig.nameSize}/${sig.sufSize}/${sig.sufTrack}`);
ok('mark keeps its scrim over the live canvas', sig.hasScrim);
ok('mark sits on the header margin (14px)', Math.abs(sig.right - 14) <= 1 && sig.top >= 0 && sig.top <= 24, `right=${sig.right} top=${sig.top}`);
ok('mark centred on the wordmark line (<=4px)', Math.abs(sig.centreDelta) <= 4, `delta=${sig.centreDelta}`);
ok('mark does not overlap wordmark', !sig.overlapsWordmark);
ok('mark tap target >= 24px tall', sig.h >= 24, `h=${sig.h} w=${sig.w}`);
ok('mark is the element at its own centre (clickable)', sig.atPoint === 'mark', sig.atPoint);

/* the desktop key has no phone home — it must not cost the map a strip of the screen */
ok('phone hides the desktop key', await page.evaluate(() => document.getElementById('helper').getClientRects().length === 0));

/* ---------- open a job (search path) ---------- */
await openJob(page, 'Registered Nurses', 900);
const opened = await page.evaluate(() => ({
  title: document.querySelector('#panel h2').textContent,
  on: document.getElementById('panel').classList.contains('on'),
  rows: document.querySelectorAll('#nbs .nb').length,
  sigHidden: document.querySelector('.dcd-mark').getClientRects().length === 0,
}));
ok('panel opens from search', opened.on && opened.title.length > 0, opened.title);
ok('mark hides behind the open sheet', opened.sigHidden);
await page.screenshot({ path: `${ART}/mm-01-panel-open.png` });

/* ---------- fold ---------- */
const foldGeom = async () => page.evaluate(() => {
  const pn = document.getElementById('panel'), nbs = document.getElementById('nbs');
  const btn = pn.querySelector('.fold'), br = btn.getBoundingClientRect(), cr = pn.querySelector('.close').getBoundingClientRect();
  const rows = [...nbs.querySelectorAll('.nb')];
  const nbsR = nbs.getBoundingClientRect();
  const visible = rows.filter((r) => { const q = r.getBoundingClientRect(); return q.top >= nbsR.top - 1 && q.bottom <= nbsR.bottom + 1; }).length;
  return {
    folded: pn.classList.contains('folded'),
    listH: Math.round(nbsR.height), visibleRows: visible,
    btnVisible: getComputedStyle(btn).display !== 'none',
    btnW: Math.round(br.width), btnH: Math.round(br.height),
    btnOverlapsClose: !(br.right <= cr.left || br.left >= cr.right),
    aria: btn.getAttribute('aria-expanded'), label: btn.getAttribute('aria-label'),
    // rendered geometry, NOT computed display: a child of a display:none parent still reports
    // its own display value, which is exactly how the caveat bug hid from the first run
    titleVisible: pn.querySelector('h2').getClientRects().length > 0,
    tagVisible: pn.querySelector('.fam-tag').getClientRects().length > 0,
    metaVisible: pn.querySelector('.meta').getClientRects().length > 0,
    descVisible: pn.querySelector('.desc').getClientRects().length > 0,
    caveatVisible: pn.querySelector('.caveat').getClientRects().length > 0,
    codeVisible: pn.querySelector('.code').getClientRects().length > 0,
    titleClipped: (() => { const h = pn.querySelector('h2'); return h.scrollWidth > h.clientWidth + 1; })(),
    titleLines: Math.round(pn.querySelector('h2').getBoundingClientRect().height),
    sheetH: Math.round(pn.getBoundingClientRect().height),
    moreHidden: pn.querySelector('.more').hidden,
  };
});
const before = await foldGeom();
ok('fold button visible on phone', before.btnVisible);
ok('fold button >=40px target', before.btnW >= 40 && before.btnH >= 40, `${before.btnW}x${before.btnH}`);
ok('fold button does not overlap close', !before.btnOverlapsClose);
ok('starts expanded', !before.folded && before.aria === 'true');

await page.click('#panel .fold');
await page.waitForTimeout(400);
const after = await foldGeom();
ok('folds on tap', after.folded && after.aria === 'false', `aria=${after.aria} label=${after.label}`);
ok('folded keeps identity (family tag + title)', after.tagVisible && after.titleVisible);
ok('folded hides the whole card body', !after.metaVisible && !after.descVisible && !after.caveatVisible && !after.codeVisible,
  `meta=${after.metaVisible} desc=${after.descVisible} caveat=${after.caveatVisible} code=${after.codeVisible}`);
ok('folded title is one line, ellipsised not wrapped', after.titleLines <= 24, `h=${after.titleLines}px clipped=${after.titleClipped}`);
ok('sheet height unchanged (room goes to the list)', after.sheetH === before.sheetH, `${before.sheetH} -> ${after.sheetH}`);
ok('list grows', after.listH > before.listH, `${before.listH}px -> ${after.listH}px (+${after.listH - before.listH})`);
ok('more rows fit', after.visibleRows > before.visibleRows, `${before.visibleRows} -> ${after.visibleRows} of 10`);
await page.screenshot({ path: `${ART}/mm-02-panel-folded.png` });

/* fold survives choosing another job from the list */
await page.click('#nbs .nb:nth-child(2)');
await page.waitForTimeout(900);
const persisted = await foldGeom();
ok('fold persists across selections', persisted.folded);

/* unfold restores everything, incl. the measured "More" control */
await page.click('#panel .fold');
await page.waitForTimeout(400);
const restored = await foldGeom();
ok('unfolds', !restored.folded && restored.aria === 'true');
ok('unfold restores stats + blurb', restored.metaVisible && restored.descVisible);
ok('unfold restores the BLS caveat', restored.caveatVisible);

/* the caveat is a class, not an inline display — prove BOTH branches still hold */
const noBls = JSON.parse(await readFile(join(DATA, 'coords.json'), 'utf8'))
  .find((d) => d.median_wage === null && d.employment === null);
ok('data has a no-BLS occupation to test', !!noBls, noBls?.title);
if (noBls) {
  await openJob(page, noBls.title, 900);
  const nb0 = await page.evaluate(() => ({
    title: document.querySelector('#panel h2').textContent,
    caveat: document.querySelector('#panel .caveat').getClientRects().length > 0,
  }));
  ok('no-BLS job shows NO caveat', nb0.title === noBls.title && !nb0.caveat, `${nb0.title} caveat=${nb0.caveat}`);
  await openJob(page, 'Registered Nurses', 900);
  ok('BLS job gets the caveat back', await page.evaluate(() => document.querySelector('#panel .caveat').getClientRects().length > 0));
}
ok('unfold re-arms the blurb More control', restored.moreHidden === before.moreHidden, `hidden=${restored.moreHidden} (expected ${before.moreHidden})`);
await page.screenshot({ path: `${ART}/mm-03-panel-unfolded.png` });

/* ---------- neighbour dot: tap = name it, tap again = go there ---------- */
const nb = await page.evaluate(() => {
  const title = document.querySelector('#panel h2').textContent;
  const first = document.querySelector('#nbs .nb');
  const idx = +first.dataset.i;
  return { idx, pt: window.__mm.screenOf(idx), title, firstRowTitle: first.querySelector('.t').childNodes[0].textContent };
});
ok('dev hook gives a neighbour dot position', nb.pt && isFinite(nb.pt.x) && isFinite(nb.pt.y), JSON.stringify(nb.pt));

await tap(nb.pt.x, nb.pt.y);
const t1 = await page.evaluate(() => ({
  title: document.querySelector('#panel h2').textContent,
  hi: document.querySelector('#nbs .nb.hi')?.dataset.i ?? null,
  sub: document.querySelector('#panel .nb-h span').textContent,
}));
ok('first tap does NOT move the selection', t1.title === nb.title, `${nb.title} -> ${t1.title}`);
ok('first tap lights that row in the list', t1.hi === String(nb.idx), `hi=${t1.hi} want=${nb.idx}`);
ok('first tap shows the "tap again" hint', /tap that dot again/i.test(t1.sub), t1.sub);
await page.screenshot({ path: `${ART}/mm-04-nb-first-tap.png` });

await tap(nb.pt.x, nb.pt.y);
await page.waitForTimeout(900);
const t2 = await page.evaluate(() => ({
  title: document.querySelector('#panel h2').textContent,
  sub: document.querySelector('#panel .nb-h span').textContent,
}));
ok('second tap on the same dot jumps to it', t2.title === nb.firstRowTitle, `${t2.title} want=${nb.firstRowTitle}`);
ok('hint resets after the jump', !/tap that dot again/i.test(t2.sub), t2.sub);
await page.screenshot({ path: `${ART}/mm-05-nb-second-tap.png` });

/* a tap elsewhere must drop the pending jump (no stale one-tap-jump later) */
const nb2 = await page.evaluate(() => { const i = +document.querySelector('#nbs .nb').dataset.i; return { i, pt: window.__mm.screenOf(i) }; });
await tap(nb2.pt.x, nb2.pt.y);                       // arm
const armed = await page.evaluate(() => document.querySelector('#panel .nb-h span').textContent);
await tap(4, 500);                                   // tap empty map
const cleared = await page.evaluate(() => document.querySelector('#panel .nb-h span').textContent);
ok('armed by a neighbour tap', /tap that dot again/i.test(armed));
ok('a tap on empty map disarms the pending jump', !/tap that dot again/i.test(cleared), cleared);
const afterElsewhere = await page.evaluate(() => document.querySelector('#panel h2').textContent);
await tap(nb2.pt.x, nb2.pt.y);                       // should re-arm, NOT jump
const reArmed = await page.evaluate(() => document.querySelector('#panel h2').textContent);
ok('after disarming, one tap only names again (no jump)', reArmed === afterElsewhere, `${afterElsewhere} -> ${reArmed}`);

/* ---------- desktop regression: nothing folded, sig on its own line, search below ---------- */
const { page: dpage } = await newPage(browser, DESKTOP, 'desktop');
const d = await dpage.evaluate(() => {
  const a = document.querySelector('.dcd-mark'), s = document.getElementById('search');
  const ar = a.getBoundingClientRect(), sr = s.getBoundingClientRect(), h1 = document.querySelector('#head h1').getBoundingClientRect();
  return {
    text: a.innerText.trim().replace(/\s+/g, ' '),
    right: Math.round(innerWidth - ar.right),
    sigBottom: Math.round(ar.bottom), searchTop: Math.round(sr.top), searchBottom: Math.round(sr.bottom),
    overlap: !(ar.bottom <= sr.top || ar.top >= sr.bottom),
    centreDelta: Math.round(((ar.top + ar.bottom) / 2) - ((h1.top + h1.bottom) / 2)),
    foldHidden: getComputedStyle(document.querySelector('#panel .fold')).display === 'none',
  };
});
ok('desktop mark is the same mark (no width variants)', /^Dustin Cole\s*Data$/i.test(d.text), d.text);
ok('desktop mark on the chrome margin (30px)', Math.abs(d.right - 30) <= 1, `right=${d.right}`);
ok('desktop mark does not overlap the search box', !d.overlap, `markBottom=${d.sigBottom} searchTop=${d.searchTop}`);
ok('desktop mark sits on the wordmark line', Math.abs(d.centreDelta) <= 6, `delta=${d.centreDelta}`);
ok('desktop search still clears fitAll top pad (110)', d.searchBottom <= 110, `searchBottom=${d.searchBottom}`);
ok('desktop hides the fold control', d.foldHidden);
await dpage.screenshot({ path: `${ART}/mm-06-desktop.png` });

/* ---------- the key states what the map ENCODES, and claims no distance ---------- */
const key = await dpage.evaluate(() => {
  const h = document.getElementById('helper');
  const svg = h.querySelector('svg.fan');
  const w = [...svg.querySelectorAll('path')].map((p) => parseFloat(p.getAttribute('stroke-width')));
  const o = [...svg.querySelectorAll('path')].map((p) => parseFloat(p.getAttribute('opacity')));
  return {
    text: h.innerText.replace(/\s+/g, ' ').trim(),
    keys: [...h.querySelectorAll('.k')].length,
    glyph: !!svg, glyphHidden: svg?.getAttribute('aria-hidden') === 'true',
    strokes: w, opacities: o,
    visible: h.getClientRects().length > 0,
  };
});
ok('desktop shows the key', key.visible && key.keys === 2, `${key.keys} keys :: "${key.text}"`);
// the claim the projection cannot support: nearest dot on screen is the #1 match only 31% of the
// time (rank correlation 0.43). No wording of the key may put similarity on the distance axis.
ok('the key makes NO distance claim', !/\bnear\b|nearby|nearest|closer|close to|distance|far\b/i.test(key.text), key.text);
ok('the key names the leader encoding', /heavier|thicker|weight/i.test(key.text) && /match/i.test(key.text), key.text);
ok('the key still names the colour encoding', /colou?r\s*=\s*family/i.test(key.text), key.text);
ok('the key carries the fan glyph, hidden from AT', key.glyph && key.glyphHidden);
// the glyph is a legend only if it is drawn at the encoding's real end-points (leaderStyle)
ok('glyph strokes span the shipped weight range 0.8-2.4px',
  Math.max(...key.strokes) === 2.4 && Math.min(...key.strokes) === 0.8, key.strokes.join('/'));
ok('glyph inks span the shipped alpha range 0.13-0.42',
  Math.max(...key.opacities) === 0.42 && Math.min(...key.opacities) === 0.13, key.opacities.join('/'));

/* the footer is a fixed-height strip: the key must never grow it or push the source block into
   extra lines, at any desktop width down to the 761px floor where the phone layout takes over */
const footRows = [];
for (const w of [761, 800, 900, 1024, 1280, 1440, 1920]) {
  await dpage.setViewportSize({ width: w, height: 900 });
  await dpage.waitForTimeout(220);
  footRows.push([w, await dpage.evaluate(() => {
    const h = document.getElementById('helper').getBoundingClientRect();
    const s = document.getElementById('source').getBoundingClientRect();
    return { hw: Math.round(h.width), srcH: Math.round(s.height), overlap: h.right > s.left + 0.5 };
  })]);
}
await dpage.setViewportSize({ width: 1440, height: 900 });
ok('key never collides with the source block', footRows.every(([, m]) => !m.overlap),
  footRows.map(([w, m]) => `${w}:${m.overlap ? 'OVERLAP' : 'ok'}`).join(' '));
ok('source block stays two lines at every desktop width', footRows.every(([, m]) => m.srcH <= 32),
  footRows.map(([w, m]) => `${w}:${m.srcH}px`).join(' '));

await browser.close();
report();
