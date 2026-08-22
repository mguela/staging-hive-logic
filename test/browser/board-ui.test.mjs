// Browser tests for the shipped schedule board.
//
// Every case here is a bug Chris reported that unit tests could not have caught,
// because each one is a question about geometry after layout: does this element
// overlap that one, does the page scroll, is the map where it should be.
//
// Two rules learned the hard way, both enforced below:
//   1. Never assert "no overlap" against an element with no size, or in a state
//      where the elements cannot overlap anyway. That answer is meaningless.
//      A measurement that cannot fail proves nothing — it once reported a bug
//      fixed that was still fully present.
//   2. Set up the state through the SAME path a user takes. The overlap bug
//      lived only in "panel opened by click", and a harness that loaded with
//      the panel already open never saw it.
//
// Run with: npm run test:ui

import test, { before, after } from 'node:test';
import assert from 'node:assert';
import { startServer } from './serve.mjs';
import { SHOP, WEEK_MAPPABLE_COUNT, CREW_JOB, buildFixtures, etDayKey } from './fixtures.mjs';
import {
  findPlaywright, unavailableReason, maplibreBundle,
  openBoard, enableMapBackdrop, showView,
} from './driver.mjs';

// Skipping is right on a laptop with no browser installed. It is wrong in CI:
// a green run that silently executed nothing is the exact failure this suite
// exists to prevent, so there the missing browser is itself the failure.
const reason = unavailableReason();
if (reason && process.env.HL_UI_TESTS_REQUIRED === '1') {
  throw new Error(
    `HL_UI_TESTS_REQUIRED=1 but the browser tests cannot run: ${reason}. `
    + 'Refusing to report a pass for tests that did not execute.');
}
const skip = reason || false;
const chromium = skip ? null : findPlaywright().chromium;

// One browser and one server for the whole file; each test drives it into the
// state it needs. Launching per test triples the runtime for no isolation gain,
// since the board is reset through its own controls.
let server, browser, page, pageErrors;
const CREW_JOB_DATE = etDayKey(new Date(buildFixtures().visits.find((visit) => visit.clientName === CREW_JOB.client).startAt));

before(async () => {
  if (skip) return;
  server = await startServer();
  ({ browser, page, pageErrors } = await openBoard(chromium, server.url));
  await enableMapBackdrop(page);
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

/** Geometry of the control cluster and the open side panel, or a refusal. */
const MEASURE_OVERLAP = `(() => {
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: Math.round(b.left), right: Math.round(b.right),
             width: Math.round(b.width),
             visible: getComputedStyle(el).display !== 'none' && b.width > 0 && b.height > 0 };
  };
  const open = [...document.querySelectorAll('.unpanel')]
    .filter((p) => p.classList.contains('open') && getComputedStyle(p).display !== 'none');
  const out = {
    sideW: getComputedStyle(document.documentElement).getPropertyValue('--side-w').trim(),
    openPanels: open.length,
    panelIsOverlay: open.some((p) => getComputedStyle(p).position === 'fixed'),
    panelLeft: open.length ? Math.min(...open.map((p) => Math.round(p.getBoundingClientRect().left))) : null,
    tilt: rect(document.getElementById('mapbgtilt')),
    controls: rect(document.getElementById('mapbgctl')),
    mapWidth: rect(document.getElementById('mapbg'))?.width ?? null,
  };
  out.checks = ['tilt', 'controls'].map((key) => {
    const el = out[key];
    if (!el || !el.visible) return { key, verdict: 'vacuous', why: 'element has no size' };
    if (out.panelLeft === null) return { key, verdict: 'vacuous', why: 'no panel is open' };
    if (out.panelIsOverlay) return { key, verdict: 'n/a', why: 'panel is a floating overlay' };
    return { key, verdict: el.right > out.panelLeft + 1 ? 'overlap' : 'clear',
             gap: out.panelLeft - el.right };
  });
  return out;
})()`;

/** Fail loudly on a measurement that could not have failed. */
function assertConclusive(checks, { expectAtLeast = 1 } = {}) {
  const vacuous = checks.filter((c) => c.verdict === 'vacuous');
  assert.deepEqual(vacuous, [], `measurement proves nothing: ${JSON.stringify(vacuous)}`);
  const real = checks.filter((c) => c.verdict === 'overlap' || c.verdict === 'clear');
  assert.ok(real.length >= expectAtLeast, 'nothing was actually measured');
  return real;
}

/**
 * Alpha of a computed colour. Chromium serialises color-mix() as
 * `color(srgb r g b / a)`, not as rgba(), so both forms have to be read.
 */
function alphaOf(color) {
  if (!color || color === 'transparent') return 0;
  const slash = /\/\s*([\d.]+)\s*\)/.exec(color);
  if (slash) return parseFloat(slash[1]);
  const rgba = /rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/.exec(color);
  if (rgba) return parseFloat(rgba[1]);
  return 1;
}

// --- Chris: "the over lap is a problem", then "not fixed" -------------------
// --side-w is computed in sizeBoardViewport(), which only runs from render().
// Clicking the "unscheduled" stat calls renderUnassigned() directly, so the
// reserved width stayed at 0 and the controls drew 272px over the open panel.
test('the map controls clear a panel opened the way a user opens it', { skip }, async () => {
  await showView(page, 'day');
  // close it and force a full render, so --side-w genuinely settles at 0 first
  await page.evaluate('window.LabUI.toggleUnassigned(false)');
  await showView(page, 'week');
  await showView(page, 'day');

  const before = await page.evaluate(MEASURE_OVERLAP);
  assert.equal(before.openPanels, 0, 'the panel must start closed or this proves nothing');

  await page.evaluate('window.LabUI.toggleUnassigned(true)');   // the user gesture
  await page.waitForTimeout(500);

  const after = await page.evaluate(MEASURE_OVERLAP);
  assert.equal(after.openPanels, 1, 'the panel is open, so an overlap is now possible');
  for (const check of assertConclusive(after.checks)) {
    assert.equal(check.verdict, 'clear', `${check.key} overlaps the panel by ${-check.gap}px`);
  }
  assert.notEqual(after.sideW, '0px', 'the panel width must be reserved while it is open');
  assert.ok(after.mapWidth < before.mapWidth, 'the map gives way to the panel rather than running under it');
});

test('closing the panel gives the width back to the map', { skip }, async () => {
  await page.evaluate('window.LabUI.toggleUnassigned(true)');
  await page.waitForTimeout(400);
  const open = await page.evaluate(MEASURE_OVERLAP);
  await page.evaluate('window.LabUI.toggleUnassigned(false)');
  await page.waitForTimeout(400);
  const closed = await page.evaluate(MEASURE_OVERLAP);

  assert.equal(open.sideW, '280px');
  assert.equal(closed.sideW, '0px');
  assert.ok(closed.mapWidth > open.mapWidth, 'the map expands again');
});

// --- Chris: "the schedule needs to resize to fit in the current view" -------
// The board scrolls internally; anything that makes the DOCUMENT taller than
// the window adds a second, outer scrollbar on top of the board's own.
test('the page itself never scrolls, but the board does', { skip }, async () => {
  for (const [width, height] of [[1500, 900], [1100, 700], [430, 840]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(700);
    const m = await page.evaluate(`(() => {
      const board = document.getElementById('boardscroll');
      return {
        docHeight: document.documentElement.scrollHeight,
        winHeight: window.innerHeight,
        boardScrolls: board.scrollHeight > board.clientHeight + 1,
      };
    })()`);
    assert.ok(m.docHeight <= m.winHeight + 1,
      `page scrollbar at ${width}x${height}: document ${m.docHeight}px in a ${m.winHeight}px window`);
    assert.ok(m.boardScrolls,
      `the crew list must still scroll at ${width}x${height} — if it does not, this proves nothing`);
  }
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.waitForTimeout(500);
});

// --- Chris: "I dont think it should move the bars at the top, the hours/Days"
// position:sticky resolves against the nearest SCROLLING ancestor, so the
// headers only stick because the board scrolls inside itself.
test('the hour and day headers stay put while the crew rows scroll', { skip }, async () => {
  for (const view of ['day', 'week']) {
    await showView(page, view);
    const selector = view === 'day' ? '.timehdr' : '.wkhd';
    const before = await page.evaluate(`Math.round(document.querySelector('${selector}').getBoundingClientRect().top)`);
    const scrolled = await page.evaluate(`(() => {
      const b = document.getElementById('boardscroll');
      b.scrollTop = 400;
      return b.scrollTop;
    })()`);
    await page.waitForTimeout(300);
    const after = await page.evaluate(`Math.round(document.querySelector('${selector}').getBoundingClientRect().top)`);

    assert.ok(scrolled > 100, `${view}: the board must actually scroll, or the header cannot fail to move`);
    assert.ok(Math.abs(after - before) <= 1, `${view}: header moved ${after - before}px while scrolling`);
    await page.evaluate('document.getElementById("boardscroll").scrollTop = 0');
  }
});

// --- Crew chaining: a crew job belongs to the lead's row --------------------
// Before this, every fixture visit had exactly one tech, so the grouping path
// never ran here and any assertion about it would have passed vacuously. The
// board used to push a crew job onto EVERY member's row; it now renders once on
// the lead's row, and each secondary gets a quiet marker on theirs instead.
test('a two-person job renders once, on the lead\'s row', { skip }, async () => {
  await page.evaluate((date) => window.LabUI.openDay(date), CREW_JOB_DATE);
  await page.waitForTimeout(300);
  const m = await page.evaluate(`(() => {
    const rowOf = (el) => { const lane = el.closest('.lane'); return lane ? lane.getAttribute('data-tech') : null; };
    // The full card names the client in its text; the marker is deliberately
    // terse ("with Marco") and carries the client in its tooltip instead, so
    // match on either rather than assuming both read the same way.
    const client = ${JSON.stringify(CREW_JOB.client)};
    const mentions = (el) => el.textContent.includes(client) || (el.getAttribute('title') || '').includes(client);
    const named = [...document.querySelectorAll('.job')].filter(mentions);
    const full = named.filter((el) => !el.classList.contains('chained'));
    const chained = named.filter((el) => el.classList.contains('chained'));
    return {
      total: named.length,
      fullCount: full.length,
      chainedCount: chained.length,
      fullRow: full[0] ? rowOf(full[0]) : null,
      chainedRow: chained[0] ? rowOf(chained[0]) : null,
      tag: full[0] ? (full[0].querySelector('.cwn') || {}).textContent : null,
      chainedText: chained[0] ? chained[0].textContent.trim() : null,
    };
  })()`);

  // If the job isn't on the board at all, everything below would pass emptily.
  assert.ok(m.total > 0, 'the two-person fixture job must be on the board, or this test proves nothing');
  assert.equal(m.fullCount, 1, `the job card must appear exactly once, not once per crew member (saw ${m.fullCount})`);
  assert.ok(m.fullRow && m.fullRow.includes(CREW_JOB.leadName.toLowerCase()),
    `the card must sit on the lead's row, not the helper's (was on "${m.fullRow}")`);
  assert.equal(m.tag, '+1', `the lead's card must carry the crew tag (saw "${m.tag}")`);

  assert.equal(m.chainedCount, 1, 'the chained secondary needs exactly one marker on their own row');
  assert.ok(m.chainedRow && m.chainedRow.includes(CREW_JOB.secondaryName.toLowerCase()),
    `the marker must be on the secondary's row (was on "${m.chainedRow}")`);
  assert.ok(m.chainedText.includes(CREW_JOB.leadName),
    `the marker must name who they are with (saw "${m.chainedText}")`);
});

// A chained marker that looked like a real job card would just move the clutter
// rather than remove it — and one that were invisible would let dispatch
// double-book someone who is already spoken for.
test('the chained marker is visible but quieter than a real job card', { skip }, async () => {
  await page.evaluate((date) => window.LabUI.openDay(date), CREW_JOB_DATE);
  await page.waitForTimeout(300);
  const m = await page.evaluate(`(() => {
    const client = ${JSON.stringify(CREW_JOB.client)};
    const mentions = (el) => el.textContent.includes(client) || (el.getAttribute('title') || '').includes(client);
    const named = [...document.querySelectorAll('.job')].filter(mentions);
    const full = named.find((el) => !el.classList.contains('chained'));
    const chained = named.find((el) => el.classList.contains('chained'));
    if (!full || !chained) return null;
    const box = (el) => { const b = el.getBoundingClientRect(); return { w: b.width, h: b.height }; };
    return {
      chainedOpacity: Number(getComputedStyle(chained).opacity),
      chainedBox: box(chained),
      fullBox: box(full),
    };
  })()`);
  assert.ok(m, 'both the card and its chained marker must exist for this comparison to mean anything');
  assert.ok(m.chainedBox.w > 0 && m.chainedBox.h > 0, 'the marker must actually be rendered, not zero-sized');
  assert.ok(m.chainedOpacity < 1, `the marker must read as secondary (opacity ${m.chainedOpacity})`);
  assert.ok(m.chainedBox.h < m.fullBox.h, 'the marker must be shorter than a real job card');
});

// --- Chris: "the map is very faint and barely visible" ----------------------
// It was dimmed twice: layer opacity, and a scrim inside every lane on top of
// it. Multiplied, ~14% of the map reached the eye.
test('the backdrop is actually visible through the empty lanes', { skip }, async () => {
  await showView(page, 'day');
  const m = await page.evaluate(`(() => {
    const lane = document.querySelector('.lane');
    return {
      layer: parseFloat(getComputedStyle(document.getElementById('mapbg')).opacity),
      laneColor: lane ? getComputedStyle(lane).backgroundColor : null,
      mapUnder: document.body.classList.contains('map-under'),
    };
  })()`);
  assert.ok(m.mapUnder, 'the backdrop must be on, or there is nothing to measure');
  assert.ok(m.laneColor, 'the day lanes must exist to be measured');

  // Parsed here rather than in the page: regex escapes inside a template
  // literal get eaten, and a mangled pattern silently reports full opacity.
  const scrim = alphaOf(m.laneColor);
  const effective = m.layer * (1 - scrim);
  assert.ok(effective >= 0.4,
    `only ${Math.round(effective * 100)}% of the map reaches the eye `
    + `(layer ${m.layer}, lane scrim ${scrim} from "${m.laneColor}")`);
  assert.ok(m.layer <= 0.85, 'it is still a backdrop, not the subject');
});

// --- Chris: "the shop address is not the center of the map" -----------------
// It centred on the unguarded average of the day's job coordinates, so one bad
// geocode moved it miles. The shop is the pivot for rotate and tilt, so it has
// to be the fixed point of the fit too.
const mapSkip = skip || (maplibreBundle() ? false : 'maplibre-gl is not installed (npm install)');

test('the map is centred on the shop, in Day and in Week', { skip: mapSkip }, async () => {
  for (const view of ['day', 'week']) {
    await showView(page, view);
    await page.waitForTimeout(1500);
    const m = await page.evaluate(`(() => {
      const map = (window.__maps || [])[0];
      if (!map) return { error: 'no map was built' };
      const c = map.getCenter();
      const box = document.getElementById('mapbg').getBoundingClientRect();
      const p = map.project([${SHOP.lng}, ${SHOP.lat}]);
      return {
        lng: c.lng, lat: c.lat,
        shopAtPct: { x: p.x / box.width * 100, y: p.y / box.height * 100 },
      };
    })()`);
    assert.ok(!m.error, `${view}: ${m.error}`);
    // ~1 mile of tolerance: fitBounds pads, and the board is not square
    const milesOff = Math.hypot((m.lat - SHOP.lat) * 69, (m.lng - SHOP.lng) * 52);
    assert.ok(milesOff < 1, `${view}: map centre is ${milesOff.toFixed(2)} miles from the shop`);
    assert.ok(Math.abs(m.shopAtPct.x - 50) < 6 && Math.abs(m.shopAtPct.y - 50) < 6,
      `${view}: shop sits at ${m.shopAtPct.x.toFixed(0)}% x ${m.shopAtPct.y.toFixed(0)}% of the map`);
  }
});

// --- Chris: "active jobs dont show" ----------------------------------------
// Pins must be the visits in the visible period — no stale ones carried over
// from a period already navigated past, and framed rather than off-screen.
test('the pins are the period\'s jobs, and they are in frame', { skip: mapSkip }, async () => {
  await showView(page, 'week');
  await page.waitForTimeout(1500);
  const m = await page.evaluate(`(() => {
    const box = document.getElementById('mapbg').getBoundingClientRect();
    const pins = [...document.querySelectorAll('#mbcanvas .mbjob')].map((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2 - box.left, y: b.top + b.height / 2 - box.top };
    });
    return {
      total: pins.length,
      inFrame: pins.filter((p) => p.x >= 0 && p.x <= box.width && p.y >= 0 && p.y <= box.height).length,
    };
  })()`);
  assert.ok(m.total > 0, 'the week has jobs, so it must have pins');
  // the deliberate bad geocode is excluded from the fit, so it may sit outside
  assert.ok(m.inFrame >= WEEK_MAPPABLE_COUNT - 1,
    `only ${m.inFrame} of ${m.total} pins are in frame`);
});

test('the board loaded without throwing', { skip }, () => {
  assert.deepEqual(pageErrors, []);
});
