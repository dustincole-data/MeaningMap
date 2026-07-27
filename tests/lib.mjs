/* Shared rig for the UI checks. These drive a REAL browser against `npm run dev`, because every
   bug these were written for (a 0×0 similarity fill, a sheet that reported the min-scale viewport,
   an encoding that existed in the formula and not in the pixels) was invisible to anything that
   only reads the source. Playwright drives an installed Edge — `playwright-core` ships no browser,
   so there is nothing to download and nothing to keep in sync. */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* SITE, not URL — `URL` is a global constructor and shadowing it in the importing module is a
   trap nobody expects to step in */
export const SITE = process.env.MM_URL || 'http://127.0.0.1:4321/';
export const CHANNEL = process.env.MM_BROWSER || 'msedge';
const HERE = dirname(fileURLToPath(import.meta.url));
export const ART = join(HERE, '.artifacts');
export const DATA = join(HERE, '..', 'src', 'data');

/* iPhone-class touch device and a laptop — the two the hard constraint names */
export const PHONE = {
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};
export const DESKTOP = { viewport: { width: 1440, height: 900 } };

export const fails = [];
export const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails.push(name);
};

export async function launch() {
  await mkdir(ART, { recursive: true });
  return chromium.launch({ channel: CHANNEL, headless: true });
}

/* A page that reports its own errors as failures — a thrown exception in the canvas engine
   otherwise just leaves a blank map and every geometry assertion passing on nothing. */
export async function newPage(browser, opts, label) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log(`PAGEERROR ${label}: ${e.message}`); fails.push(`pageerror ${label}`); });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`CONSOLE-ERR ${label}: ${m.text()}`); });
  await page.goto(SITE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  return { ctx, page };
}

/* Open a job through the search box: the one entry point that works identically on both devices
   (a click at map coordinates depends on the camera, which depends on the viewport). */
export async function openJob(page, title, wait = 1200) {
  await page.evaluate((t) => {
    const q = document.getElementById('q');
    q.value = t; q.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#results button').click();
  }, title);
  await page.waitForTimeout(wait);
}

export function report() {
  console.log('\n' + (fails.length ? `${fails.length} FAILING: ${fails.join(' | ')}` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
}
