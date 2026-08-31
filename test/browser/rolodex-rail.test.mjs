// The quick-access rail belongs on the RIGHT EDGE, vertically.
//
// a02740e ("feat(nav): move quick-access rail buttons to the topbar, except
// Reina") relocated all twelve of them into the topbar icon row. On a real
// screen they wrapped onto two lines at the top of the page. Chris found it in
// the live app, not in a test -- nothing in the suite asserted WHERE the rail
// rendered, only that its handlers existed, so the move was invisible to CI.
//
// That is the gap this file closes. Every assertion here is a measurement from
// a real browser layout: which side of the viewport the rail sits on, that it
// stacks vertically rather than wrapping, and that hovering one tab expands
// that tab alone without shoving its siblings. Source-level checks cannot see
// any of it -- the same lesson the map-refresh button taught, where twelve
// passing assertions described a button wired to a dead map.

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

let server; let page; let browser;

before(async () => {
  if (reason) return;
  server = await startServer();
  browser = await pw.chromium.launch({
    executablePath: chromiumPath, args: ['--no-sandbox', '--disable-gpu'],
  });
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  // Seal the network. A blocked external request HANGS rather than failing,
  // which would stall load and make every measurement below a confident lie.
  await page.route((u) => u.hostname !== '127.0.0.1' && u.protocol.startsWith('http'), (r) => r.abort());
  await page.goto(`${server.url}/index.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // The rail is display:none until the app marks the body signed-in; this
  // harness has no login, so stand in for it rather than skipping the check.
  await page.evaluate(() => document.body.classList.add('hl-authed'));
  await page.waitForSelector('.rolodex .rolo', { timeout: 10000 });
  await page.waitForTimeout(400);
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

test('the rail is docked to the right edge, not the top', OPTS, async () => {
  const m = await page.evaluate(() => {
    const el = document.querySelector('.rolodex');
    const r = el.getBoundingClientRect();
    return {
      right: r.right, left: r.left, top: r.top, height: r.height, width: r.width,
      vw: window.innerWidth, vh: window.innerHeight,
      position: getComputedStyle(el).position,
      direction: getComputedStyle(el).flexDirection,
      display: getComputedStyle(el).display,
    };
  });

  assert.equal(m.display, 'flex', 'the rail must be visible once signed in');
  assert.equal(m.position, 'fixed', 'it is a docked rail, not something that scrolls away');
  assert.equal(m.direction, 'column', 'a column, not a wrapped row across the top');

  // The measurement that would have caught a02740e.
  assert.ok(m.right >= m.vw - 2,
    `the rail must touch the RIGHT edge; its right edge is at ${m.right} of ${m.vw}`);
  assert.ok(m.left > m.vw * 0.75,
    `the rail must live in the right quarter of the screen, not at the top; left=${m.left}`);
  assert.ok(m.top > 40,
    `the rail must not be pinned to the top of the page; top=${m.top}`);
});

test('all thirteen tabs are in the rail, stacked in one column', OPTS, async () => {
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.rolodex .rolo')]
    .map((t) => {
      const r = t.getBoundingClientRect();
      return { label: (t.querySelector('.rlabel') || {}).textContent || null, x: r.left, y: r.top };
    }));

  assert.equal(tabs.length, 13, 'Phone through Monitor, Reina included');

  // One column means every tab shares an x and each sits below the last. A
  // wrapped topbar row would break both.
  const xs = new Set(tabs.map((t) => Math.round(t.x)));
  assert.equal(xs.size, 1, `all tabs must share one x; found ${[...xs].join(', ')}`);
  for (let i = 1; i < tabs.length; i += 1) {
    assert.ok(tabs[i].y > tabs[i - 1].y,
      `tab ${i} ("${tabs[i].label}") must sit below "${tabs[i - 1].label}"`);
  }
});

test('hovering one tab expands only that tab, and the stack does not drift', OPTS, async () => {
  const before = await page.evaluate(() => [...document.querySelectorAll('.rolodex .rolo')]
    .map((t) => { const r = t.getBoundingClientRect(); return { w: r.width, x: r.left, y: r.top }; }));

  await page.hover('.rolodex .rolo:nth-child(3)');
  await page.waitForTimeout(300); // the 170ms width/transform transition, plus slack

  const after = await page.evaluate(() => [...document.querySelectorAll('.rolodex .rolo')]
    .map((t) => { const r = t.getBoundingClientRect(); return { w: r.width, x: r.left, y: r.top }; }));

  assert.ok(after[2].w > before[2].w + 40,
    `the hovered tab must widen to show its label (${before[2].w} -> ${after[2].w})`);
  assert.ok(after[2].x < before[2].x - 4,
    'it must expand LEFTWARD, over the page, rather than pushing the edge');

  // The bug the original rail was built to avoid: one tab expanding and
  // dragging the whole stack sideways.
  for (let i = 0; i < before.length; i += 1) {
    if (i === 2) continue;
    assert.ok(Math.abs(after[i].x - before[i].x) < 2,
      `tab ${i} moved sideways when a sibling was hovered (${before[i].x} -> ${after[i].x})`);
    assert.ok(Math.abs(after[i].y - before[i].y) < 2,
      `tab ${i} moved vertically when a sibling was hovered`);
  }
});

test('the topbar did not keep a second copy of the buttons', OPTS, async () => {
  // a02740e put them in the topbar. A partial revert that left duplicates
  // behind would still look wrong and would double every id.
  const counts = await page.evaluate(() => ({
    total: document.querySelectorAll('.rolo').length,
    inRail: document.querySelectorAll('.rolodex .rolo').length,
    monitorIds: document.querySelectorAll('#rolo-mon').length,
  }));
  assert.equal(counts.total, counts.inRail, 'no .rolo button may live outside the rail');
  assert.equal(counts.monitorIds, 1, 'a duplicated #rolo-mon would break the live recording glow');
});
