// The quick-access group lives INLINE in the topbar now, horizontally.
//
// History: a02740e ("feat(nav): move quick-access rail buttons to the
// topbar, except Reina") first tried this move and wrapped onto two lines
// at normal desktop widths -- Chris found it live, and the rail was moved
// back to a fixed right-edge column, with this file added to guard the
// vertical layout so a future move couldn't regress it invisibly again.
//
// jomell, 2026-08-27: asked for the exact move a02740e made -- the icons
// back in the top nav bar. This time the topbar's own wrap breakpoints
// (public/index.html, ~line 317) were widened by the group's real measured
// width (~500px) specifically so it holds one row at normal desktop widths
// instead of overflowing the viewport (confirmed manually: at 1500px wide
// the unwidened breakpoints let the topbar overflow ~300px past the
// viewport edge with the avatar pushed off-screen entirely -- worse than
// the original two-line wrap bug, not better). This file now guards THAT:
// one row and no horizontal page overflow at a normal desktop width, a
// clean wrap (not an overflow) at a narrower one, and no leftover
// right-edge rail.
//
// Every assertion here is a measurement from a real browser layout.
// Source-level checks cannot see any of this -- the same lesson the
// map-refresh button taught, where twelve passing assertions described a
// button wired to a dead map.

import test, { before, after } from 'node:test';
import assert from 'node:assert';
import { startServer } from './serve.mjs';
import { findPlaywright, findChromium, unavailableReason } from './driver.mjs';

const reason = unavailableReason();
// Pass the skip option ONLY when there is a real reason. `{ skip: null }` is
// still a skip directive to node:test -- the bodies below ran, took real time,
// and were reported "# SKIP" anyway, which means any failure in them would have
// been invisible. A test that cannot report a failure is not a test.
const OPTS = reason ? { skip: reason } : {};
const pw = reason ? null : findPlaywright();
const chromiumPath = reason ? null : findChromium();

let server; let browser;

before(async () => {
  if (reason) return;
  server = await startServer();
  browser = await pw.chromium.launch({
    executablePath: chromiumPath, args: ['--no-sandbox', '--disable-gpu'],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

async function openAt(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.route((u) => u.hostname !== '127.0.0.1' && u.protocol.startsWith('http'), (r) => r.abort());
  await page.goto(`${server.url}/index.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // The group is display:none until the app marks the body signed-in; this
  // harness has no login, so stand in for it rather than skipping the check.
  await page.evaluate(() => document.body.classList.add('hl-authed'));
  await page.waitForSelector('.rolodex .rolo', { timeout: 10000 });
  await page.waitForTimeout(400);
  return page;
}

test('the group lives inside the topbar, not a fixed right-edge rail', OPTS, async () => {
  const page = await openAt(1920, 1080);
  try {
    const m = await page.evaluate(() => {
      const el = document.querySelector('.rolodex');
      return {
        parentClass: el.parentElement.className,
        position: getComputedStyle(el).position,
      };
    });
    assert.equal(m.parentClass, 'topbar', 'the group must be a child of .topbar');
    assert.notEqual(m.position, 'fixed', 'it is inline content now, not a docked overlay');
  } finally { await page.close(); }
});

test('all twelve tabs are present, and none are duplicated outside the group', OPTS, async () => {
  // jomell, 2026-08-27: "let's keep the Reina button on the side" -- Reina
  // is deliberately NOT one of these twelve (Phone through Monitor); its
  // own #rnaFab launcher is checked separately below.
  const page = await openAt(1920, 1080);
  try {
    const counts = await page.evaluate(() => ({
      total: document.querySelectorAll('.rolo').length,
      inGroup: document.querySelectorAll('.rolodex .rolo').length,
      monitorIds: document.querySelectorAll('#rolo-mon').length,
    }));
    assert.equal(counts.inGroup, 12, 'Phone through Monitor, Reina excluded');
    assert.equal(counts.total, counts.inGroup, 'no .rolo button may live outside the group');
    assert.equal(counts.monitorIds, 1, 'a duplicated #rolo-mon would break the live recording glow');
  } finally { await page.close(); }
});

test('Reina keeps its own floating launcher, outside the topbar group', OPTS, async () => {
  const page = await openAt(1920, 1080);
  try {
    const m = await page.evaluate(() => {
      const titles = [...document.querySelectorAll('.rolodex .rolo')].map((t) => t.getAttribute('title') || '');
      const fab = document.getElementById('rnaFab');
      return {
        inGroup: titles.some((t) => /reina/i.test(t)),
        fabExists: !!fab,
        fabDisplay: fab ? getComputedStyle(fab).display : null,
        fabPosition: fab ? getComputedStyle(fab).position : null,
      };
    });
    assert.equal(m.inGroup, false, 'Reina must not be one of the topbar tabs');
    assert.ok(m.fabExists, '#rnaFab must still exist');
    assert.equal(m.fabDisplay, 'flex', 'the Reina launcher must be visible');
    assert.equal(m.fabPosition, 'fixed', 'it stays a docked floating button, on the side');
  } finally { await page.close(); }
});

test('at a normal desktop width, the row does not wrap and does not overflow the viewport', OPTS, async () => {
  // The regression this whole file exists to catch, in either of its two
  // possible shapes: wrapping onto an ugly extra line, or -- what an
  // unwidened breakpoint actually produced here -- silently overflowing the
  // page horizontally with trailing icons (settings, help, the avatar)
  // pushed off past the right edge entirely.
  const page = await openAt(1920, 1080);
  try {
    const m = await page.evaluate(() => {
      const rolo = document.querySelector('.rolodex');
      const avatar = document.getElementById('hlavatar');
      return {
        flexWrap: getComputedStyle(rolo.parentElement).flexWrap,
        docScrollWidth: document.documentElement.scrollWidth,
        vw: window.innerWidth,
        avatarRight: avatar ? avatar.getBoundingClientRect().right : null,
      };
    });
    assert.equal(m.flexWrap, 'nowrap', 'the topbar must hold one row at a normal desktop width');
    assert.ok(m.docScrollWidth <= m.vw + 4,
      `the page must not scroll horizontally; scrollWidth=${m.docScrollWidth} vw=${m.vw}`);
    assert.ok(m.avatarRight !== null && m.avatarRight <= m.vw,
      `the avatar (last topbar icon) must stay on-screen; right=${m.avatarRight} vw=${m.vw}`);
  } finally { await page.close(); }
});

test('at a narrower width, the topbar wraps cleanly rather than overflowing', OPTS, async () => {
  const page = await openAt(1500, 1000);
  try {
    const m = await page.evaluate(() => {
      const rolo = document.querySelector('.rolodex');
      return {
        flexWrap: getComputedStyle(rolo.parentElement).flexWrap,
        docScrollWidth: document.documentElement.scrollWidth,
        vw: window.innerWidth,
      };
    });
    assert.equal(m.flexWrap, 'wrap', 'below the widened breakpoint the topbar must wrap, not overflow');
    assert.ok(m.docScrollWidth <= m.vw + 4,
      `wrapping must actually prevent horizontal overflow; scrollWidth=${m.docScrollWidth} vw=${m.vw}`);
  } finally { await page.close(); }
});

test('every tab carries a real tooltip (no hover-expand mechanic in a horizontal row)', OPTS, async () => {
  const page = await openAt(1920, 1080);
  try {
    const titles = await page.evaluate(() => [...document.querySelectorAll('.rolodex .rolo')].map((t) => t.getAttribute('title')));
    assert.equal(titles.length, 12);
    assert.ok(titles.every((t) => t && t.length > 0), 'every tab must have a non-empty title tooltip');
  } finally { await page.close(); }
});

test('the Reina launcher survives a simulated host-dispose while still signed in, and correctly hides on a real sign-out', OPTS, async () => {
  // jomell, 2026-08-27: "why does it disappear from time to time" --
  // reina-pilot-host.js's hidePage() sets #rnaFab's inline style to
  // display:none on every host dispose, including a brief unmount/remount
  // pair the Supabase auth listener can fire spuriously while the person
  // never actually signed out. public/index.html now pins a
  // `body.hl-authed #rnaFab{display:flex!important}` rule specifically to
  // outrank that inline style while genuinely signed in.
  const page = await openAt(1920, 1080);
  try {
    const authed = await page.evaluate(() => {
      const fab = document.getElementById('rnaFab');
      fab.style.display = 'none'; // simulate hidePage() firing while still authed
      return getComputedStyle(fab).display;
    });
    assert.equal(authed, 'flex', 'a transient host dispose must not visibly hide the launcher while signed in');

    const signedOut = await page.evaluate(() => {
      document.body.classList.remove('hl-authed');
      return getComputedStyle(document.getElementById('rnaFab')).display;
    });
    assert.equal(signedOut, 'none', 'a real sign-out must still hide it');
  } finally { await page.close(); }
});
