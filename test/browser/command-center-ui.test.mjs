// Browser tests for the shipped Command Center widget grid (public/index.html).
//
// These exist because of a specific miss. The layout-editor fix pass shipped
// with ALL DRAGGING DEAD, and a full sandbox unit suite passed on it. GridStack
// resolves its drag handles once, inside setStatic(false); the interaction
// shield was being mounted after that call, so it carried no mousedown listener
// — and because the shield covers the header strips, it swallowed theirs too.
// The unit fixture had no header element in its fake widgets, so GridStack's
// "no handle found, make the whole item draggable" fallback made every fake
// widget look draggable. The measurement could not fail, so it proved nothing.
//
// Everything here is therefore a question only a laid-out page with real event
// listeners can answer:
//   - does a real pointer drag actually move a widget
//   - is an edit-only control really absent outside edit mode, or just invisible
//   - does the shield really stop a click reaching the link underneath
//   - does a widget's content still fit after it is resized
//
// Same two rules as board-ui.test.mjs, and for the same reasons:
//   1. A measurement that cannot fail proves nothing. Every probe below asserts
//      its own preconditions — the element has size, the widget really changed
//      size, the control really is on screen — before asserting the result.
//   2. Reach the state the way a user does. Drags are real mouse gestures, not
//      grid.update() calls; clicks are real clicks at real coordinates.
//
// Run with: npm run test:ui

import test, { before, after } from 'node:test';
import assert from 'node:assert';
import { startServer } from './serve.mjs';
import {
  findPlaywright, unavailableReason,
  openCommandCenter, setCcEditMode, hoverWidget, dragWidget, waitForPulseData,
} from './driver.mjs';

const reason = unavailableReason();
if (reason && process.env.HL_UI_TESTS_REQUIRED === '1') {
  throw new Error(
    `HL_UI_TESTS_REQUIRED=1 but the browser tests cannot run: ${reason}. `
    + 'Refusing to report a pass for tests that did not execute.');
}
const skip = reason || false;
const chromium = skip ? null : findPlaywright().chromium;

// Every widget in the shipped grid. Named rather than discovered, so a widget
// silently failing to render is a failure here and not a shorter loop.
const WIDGETS = ['cc-map', 'cc-pulse', 'cc-brief', 'cc-watching', 'cc-todo',
  'cc-notif', 'cc-jobhealth', 'cc-schedule', 'cc-photos'];
// Today's Decisions: movable and resizable, never removable.
const REQUIRED = 'cc-brief';

let server, browser, page, pageErrors;

before(async () => {
  if (skip) return;
  server = await startServer();
  ({ browser, page, pageErrors } = await openCommandCenter(chromium, server.url));
  // Load real figures into the Pulse gauges before anything measures them.
  // "Loading…" fits in any box; "$134K" and "7/2774" are what actually broke.
  await waitForPulseData(page);
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

/** Grid coordinates of every visible widget, straight off the DOM. */
const POSITIONS = `(() => [...document.querySelectorAll('#cc-main-gridstack .grid-stack-item')]
  .filter((n) => n.style.display !== 'none')
  .map((n) => ({ id: n.getAttribute('gs-id'),
                 x: +n.getAttribute('gs-x'), y: +n.getAttribute('gs-y'),
                 w: +n.getAttribute('gs-w'), h: +n.getAttribute('gs-h') })))()`;

/** What a click at each widget's centre would actually hit. */
const HIT_TEST = `(() => [...document.querySelectorAll('#cc-main-gridstack .grid-stack-item')]
  .filter((n) => n.style.display !== 'none')
  .map((n) => {
    const b = n.getBoundingClientRect();
    const onScreen = b.width > 0 && b.height > 0
      && b.top >= 0 && b.left >= 0
      && b.bottom <= innerHeight && b.right <= innerWidth;
    const el = onScreen
      ? document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2))
      : null;
    return {
      id: n.getAttribute('gs-id'),
      onScreen,
      // 'vacuous' whenever we could not actually sample a point: a widget off
      // the fold answers "nothing is covering it" no matter what is true.
      verdict: !onScreen ? 'vacuous'
        : !el ? 'vacuous'
        : el.classList.contains('w-shield') ? 'shield'
        : el.closest('.w-tools') ? 'tools'
        : 'content',
    };
  }))()`;

function assertNoVacuous(rows, what) {
  const vacuous = rows.filter((r) => r.verdict === 'vacuous');
  assert.deepEqual(vacuous, [], `${what}: measurement proves nothing for ${JSON.stringify(vacuous.map((v) => v.id))}`);
  assert.ok(rows.length >= WIDGETS.length, `${what}: expected every widget to be measured, got ${rows.length}`);
}

function overlaps(list) {
  const hits = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]; const b = list[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) hits.push(`${a.id}/${b.id}`);
    }
  }
  return hits;
}

const ccVisible = () => page.evaluate("getComputedStyle(document.getElementById('snapshot')).display !== 'none'");
// Earlier tests drag and resize; without this the next test measures wherever
// they happened to leave things — including widgets pushed below the fold,
// where every probe goes vacuous.
const resetLayout = async () => {
  await page.evaluate("window.hlCcApplyLayout(window.hlCcTemplateLayout('tpl-owner'))");
  await page.waitForTimeout(350);
};
const backToCc = async () => { await page.evaluate("showView('cc')"); await page.waitForTimeout(400); };

/** Raw computed display of the map card's footer, which LEGEND toggles. */
const legendDisplay = () => page.evaluate(
  "getComputedStyle(document.getElementById('cc-map-foot')).display");

/**
 * Click LEGEND with a real pointer and report whether the footer actually
 * toggled, waiting on the DOM rather than on a fixed delay — a timeout long
 * enough to be safe here would still be a race, and a race in a suite whose
 * whole point is conclusive measurement is worse than no test.
 */
async function clickLegendAndSettle() {
  const box = await page.evaluate(`(() => {
    const b = document.getElementById('cc-map-leg-btn').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height,
             onScreen: b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth };
  })()`);
  // A zero-size or off-screen target makes "the click did nothing" mean nothing.
  assert.ok(box.w > 0 && box.h > 0, 'the LEGEND control has no size — clicking it proves nothing');
  assert.ok(box.onScreen, 'the LEGEND control is off screen — clicking it proves nothing');
  const before = await legendDisplay();
  await page.mouse.click(box.x, box.y);
  const changed = await page.waitForFunction(
    `getComputedStyle(document.getElementById('cc-map-foot')).display !== ${JSON.stringify(before)}`,
    null, { timeout: 2500 },
  ).then(() => true, () => false);
  return changed;
}

// --- live mode is genuinely locked ------------------------------------------
// Chris: a ✕ appeared on every widget on hover during normal use. It was real
// markup, present since page load, hidden by opacity alone.

test('live mode: no edit control exists in the DOM, and hovering a widget does not conjure one', { skip }, async () => {
  await setCcEditMode(page, false);
  const counts = await page.evaluate(`(() => ({
    shields: document.querySelectorAll('#cc-main-gridstack .w-shield').length,
    tools: document.querySelectorAll('#cc-main-gridstack .w-tools').length,
    legacyClose: document.querySelectorAll('.hl-cc-close').length,
  }))()`);
  assert.deepEqual(counts, { shields: 0, tools: 0, legacyClose: 0 }, 'live mode must ship no edit-tool markup at all');

  // Hover each widget in turn — the reported bug was hover-triggered, so a
  // static DOM count alone would not have caught it.
  for (const id of WIDGETS) {
    await hoverWidget(page, id);
    const visible = await page.evaluate(`(() => {
      const n = document.querySelector('[gs-id="${id}"]');
      return [...n.querySelectorAll('.w-tools, .w-shield, .hl-cc-close')]
        .filter((e) => { const s = getComputedStyle(e); const b = e.getBoundingClientRect();
                         return s.display !== 'none' && s.visibility !== 'hidden'
                                && parseFloat(s.opacity) > 0 && b.width > 0 && b.height > 0; }).length;
    })()`);
    assert.equal(visible, 0, `hovering ${id} in live mode must not reveal any edit affordance`);
  }
});

test('live mode: a real drag gesture moves nothing', { skip }, async () => {
  await setCcEditMode(page, false);
  const before = await page.evaluate(POSITIONS);
  // No shield exists here, so grab the widget body itself — the strongest form
  // of the question: can a user drag this at all?
  await dragWidget(page, 'cc-watching', -430, 200, { from: '.grid-stack-item-content' });
  const after = await page.evaluate(POSITIONS);
  assert.deepEqual(after, before, 'nothing may move outside customize mode');
});

test('live mode: widget content is clickable — this is what edit mode has to suppress', { skip }, async () => {
  await resetLayout();
  await setCcEditMode(page, false);
  const hits = await page.evaluate(HIT_TEST);
  assertNoVacuous(hits, 'live hit-test');
  const notContent = hits.filter((h) => h.verdict !== 'content');
  assert.deepEqual(notContent, [], 'in live mode a click must land on widget content');

  // End-to-end: the map card's own LEGEND control toggles the map footer.
  // Chosen over a navigating link because it is local to the widget and does
  // not depend on the signed-in role. Proving it WORKS here is what makes the
  // edit-mode test below conclusive — otherwise "the click did nothing" could
  // just as easily mean the click missed.
  assert.equal(await clickLegendAndSettle(), true,
    'the LEGEND control responds when it is not shielded');
  await clickLegendAndSettle(); // put it back
});

// --- edit mode --------------------------------------------------------------

test('edit mode: a real pointer drag moves a widget, and leaves no overlap behind', { skip }, async () => {
  await resetLayout();
  await setCcEditMode(page, true);
  const before = await page.evaluate(POSITIONS);
  const target = before.find((p) => p.id === 'cc-watching');
  assert.ok(target, 'cc-watching must be on the canvas');

  await dragWidget(page, 'cc-watching', -430, 200);

  const after = await page.evaluate(POSITIONS);
  const moved = after.find((p) => p.id === 'cc-watching');
  assert.notDeepEqual(
    { x: moved.x, y: moved.y }, { x: target.x, y: target.y },
    'a drag on the shield must actually move the widget — this is the regression that shipped',
  );
  assert.deepEqual(overlaps(after), [], 'collision resolve must leave no two widgets stacked on the same cells');
});

test('edit mode: the shield is what a click hits, on every widget', { skip }, async () => {
  await resetLayout();
  await setCcEditMode(page, true);
  const hits = await page.evaluate(HIT_TEST);
  assertNoVacuous(hits, 'edit hit-test');
  const unshielded = hits.filter((h) => h.verdict !== 'shield');
  assert.deepEqual(unshielded, [], 'every widget must be covered by its shield while editing');
});

test('edit mode: a real click on a control inside a widget does nothing', { skip }, async () => {
  await resetLayout();
  await setCcEditMode(page, true);
  // The negative direction cannot be waited on, so it gets the full window the
  // positive case is allowed: if nothing has changed by then, nothing will.
  assert.equal(await clickLegendAndSettle(), false,
    'the shield must stop a click reaching a control inside a widget — this is what kept knocking the user out of the editor');
});

test('edit mode: the ✕ button does not sit on top of a resize handle', { skip }, async () => {
  await setCcEditMode(page, true);
  for (const id of ['cc-watching', 'cc-photos']) {
    // Handles carry .ui-resizable-autohide until hover: measuring them
    // un-hovered reports a zero-size rect, which "clears" everything.
    await hoverWidget(page, id);
    const geo = await page.evaluate(`(() => {
      const n = document.querySelector('[gs-id="${id}"]');
      const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
        return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
      return { tools: R(n.querySelector('.w-tools')),
               handles: [...n.querySelectorAll('.ui-resizable-handle')].map((h) => ({ cls: h.className, ...R(h) })) };
    })()`);
    assert.ok(geo.tools && geo.tools.w > 0 && geo.tools.h > 0, `${id}: .w-tools must have size`);
    const laidOut = geo.handles.filter((h) => h.w > 0 && h.h > 0);
    assert.ok(laidOut.length > 0, `${id}: no resize handle was laid out — this check would pass vacuously`);
    for (const h of laidOut) {
      const hit = geo.tools.l < h.r && h.l < geo.tools.r && geo.tools.t < h.b && h.t < geo.tools.b;
      assert.equal(hit, false, `${id}: ${h.cls} overlaps the ✕ — clicking it would start a resize instead`);
    }
  }
});

test("edit mode: only Today's Decisions is built without a remove button", { skip }, async () => {
  await setCcEditMode(page, true);
  const tools = await page.evaluate(`(() => [...document.querySelectorAll('#cc-main-gridstack .grid-stack-item')]
    .map((n) => ({ id: n.getAttribute('gs-id'),
                   bar: !!n.querySelector('.w-tools'),
                   remove: !!n.querySelector('.w-tools .w-remove') })))()`);
  assert.equal(tools.length, WIDGETS.length);
  for (const t of tools) {
    const shouldHave = t.id !== REQUIRED;
    assert.equal(t.remove, shouldHave, `${t.id}: remove button presence is wrong`);
    // ✕ is the only tool, so Today's Decisions gets no bar rather than an empty
    // one. Resizing is GridStack's edge drag, for every widget including it.
    assert.equal(t.bar, shouldHave, `${t.id}: tools bar presence is wrong`);
  }
});

// --- content fits its frame at every size ------------------------------------
// A user can drag a widget to any shape, so the awkward ones have to hold their
// content too. Overflow is measured on the laid-out box, the only place it
// exists.

/**
 * Does anything inside this widget stick out sideways, and does any inner
 * scroller have a horizontal scrollbar? Vertical top overflow is excluded on
 * purpose: the "notch" title chip is absolutely positioned at top:-11px by
 * design, so it is supposed to poke out above the card.
 */
const FIT_PROBE = (id) => `(() => {
  const n = document.querySelector('[gs-id="${id}"]');
  const box = n.getBoundingClientRect();
  const content = n.querySelector('.grid-stack-item-content');

  // Content that sits outside the frame but INSIDE a scroller is reachable —
  // that is a scrollbar on real overflow, which is allowed. Content outside a
  // frame with no scroller between it and the widget edge is genuinely lost.
  const scrollableAncestor = (el, axis) => {
    for (let p = el.parentElement; p && p !== content.parentElement; p = p.parentElement) {
      const o = getComputedStyle(p)[axis === 'x' ? 'overflowX' : 'overflowY'];
      if (o === 'auto' || o === 'scroll') return true;
      if (p === content) break;
    }
    const o = getComputedStyle(content)[axis === 'x' ? 'overflowX' : 'overflowY'];
    return o === 'auto' || o === 'scroll';
  };

  const kids = [...content.querySelectorAll('*')].filter((e) => {
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden' || s.position === 'fixed') return false;
    const b = e.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  });

  let sideSpill = 0, bottomSpill = 0, sideBy = null, bottomBy = null;
  for (const e of kids) {
    const b = e.getBoundingClientRect();
    const side = Math.max(b.right - box.right, box.left - b.left);
    if (side > sideSpill && !scrollableAncestor(e, 'x')) { sideSpill = side; sideBy = e.className.toString().slice(0, 40) || e.tagName; }
    const below = b.bottom - box.bottom;
    if (below > bottomSpill && !scrollableAncestor(e, 'y')) { bottomSpill = below; bottomBy = e.className.toString().slice(0, 40) || e.tagName; }
  }

  // Named list frames must never scroll SIDEWAYS: R4 says reflow and truncate,
  // do not hand the user a horizontal scrollbar inside a card.
  const scrollers = [...content.querySelectorAll('.cc-box-scroll')].map((e) => ({
    cls: e.id || e.className.toString().slice(0, 30),
    hOverflow: e.scrollWidth - e.clientWidth,
    overflowY: getComputedStyle(e).overflowY,
  }));

  return {
    measured: kids.length,
    width: Math.round(box.width), height: Math.round(box.height),
    sideSpill: Math.round(sideSpill), sideBy,
    bottomSpill: Math.round(bottomSpill), bottomBy,
    scrollers,
    pageHScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
})()`;

test('every widget holds its content across a spread of sizes', { skip }, async () => {
  await resetLayout();
  await setCcEditMode(page, true);
  const problems = [];
  for (const id of WIDGETS) {
    const seen = new Set();
    // A spread of shapes rather than a couple of comfortable ones: narrow, wide,
    // short and tall are where content stops fitting. Clamped by GridStack to
    // each widget's own gs-min-w / gs-min-h.
    for (const [w, h] of [[3, 8], [6, 12], [2, 6], [12, 4], [4, 15], [8, 5]]) {
      await page.evaluate(`window._hlCcGrid.update(document.querySelector('[gs-id="${id}"]'), { w: ${w}, h: ${h} })`);
      await page.waitForTimeout(260);
      let r = await page.evaluate(FIT_PROBE(id));
      // Leaflet re-lays out asynchronously after a resize (invalidateSize runs
      // on a timer), so a single sample can catch the map mid-flight and report
      // a few pixels of spill that are gone a moment later. Re-measure once and
      // only believe a spill that is still there — a transient is not a defect,
      // and a test that fails one run in three is worse than no test.
      if (r.sideSpill > 2 || r.bottomSpill > 2) {
        await page.waitForTimeout(400);
        r = await page.evaluate(FIT_PROBE(id));
      }

      // Preconditions: a widget with nothing in it, or with no size, would
      // report "fits" for free.
      assert.ok(r.measured > 0, `${id}: nothing inside the widget was measured`);
      assert.ok(r.width > 0 && r.height > 0, `${id}: widget has no size at ${w}x${h}`);
      seen.add(`${r.width}x${r.height}`);

      // 2px of tolerance: outlines and sub-pixel rounding, not real spill.
      if (r.sideSpill > 2) problems.push(`${id} @ ${r.width}x${r.height}: ${r.sideBy} spills ${r.sideSpill}px sideways with nothing to scroll it back`);
      if (r.bottomSpill > 2) problems.push(`${id} @ ${r.width}x${r.height}: ${r.bottomBy} spills ${r.bottomSpill}px below with nothing to scroll it back`);
      if (r.pageHScroll > 1) problems.push(`${id} @ ${r.width}x${r.height}: the page gained a horizontal scrollbar`);
      r.scrollers.forEach((s, i) => {
        if (s.hOverflow > 1) problems.push(`${id} @ ${r.width}x${r.height}: list \"${s.cls}\" scrolls horizontally instead of reflowing`);
        // A scroller must be on 'auto', so a bar shows only on real overflow.
        if (s.overflowY === 'scroll') problems.push(`${id} @ ${r.width}x${r.height}: list \"${s.cls}\" forces a permanent scrollbar`);
      });
    }
    // The cycle has to have actually resized the thing, or the loop above
    // measured one size six times and proved nothing.
    assert.ok(seen.size > 1, `${id}: resizing never changed the widget (measured only ${[...seen]})`);
  }
  assert.deepEqual(problems, [], `content did not fit at some sizes:\n${problems.join('\n')}`);
});

// --- the Pulse gauges ------------------------------------------------------
// Chris, on a screenshot of the old dials: "this looks terrible", then "redesign
// the pulse widget properly". Six headline numbers is a KPI row of stat tiles and
// a ratio against a target is a meter — a dial spent ~180px of height on bezel
// and tick marks to say what a value plus a 6px bar says in a third of the space,
// and the value did not even fit inside it.
//
// These pin the properties of the new form that a screenshot review would catch
// but a unit test never could.

test('every Pulse tile shows a real figure that fits its own tile, at every widget size', { skip }, async () => {
  await resetLayout();
  await setCcEditMode(page, false);
  for (const [w, h] of [[4, 15], [6, 8], [3, 10], [12, 5], [4, 6]]) {
    await page.evaluate(`window._hlCcGrid.update(document.querySelector('[gs-id="cc-pulse"]'), { w: ${w}, h: ${h} })`);
    await page.waitForTimeout(600);

    const tiles = await page.evaluate(`(() => [...document.querySelectorAll('.pg-tile')].map((t) => {
      const tb = t.getBoundingClientRect();
      const val = t.querySelector('.pg-val');
      const vb = val.getBoundingClientRect();
      const fill = t.querySelector('.pg-meter > i');
      const track = t.querySelector('.pg-meter');
      return {
        title: t.querySelector('.pg-title').textContent,
        text: val.textContent.trim(),
        // Does the rendered value need more room than it has? .pg-val ellipsises,
        // so a too-long value would silently truncate rather than overflow —
        // scrollWidth is what catches that.
        truncated: val.scrollWidth - val.clientWidth,
        outsideTile: Math.round(Math.max(vb.right - tb.right, tb.left - vb.left)),
        // The rendered fill is clipped by the track's overflow:hidden, so its
        // rect can never exceed the track — comparing those proves nothing.
        // This is the width the code asks for, which is where overstatement
        // would actually show up.
        askedPct: parseFloat(fill.style.width) || 0,
        trackW: track.getBoundingClientRect().width,
        tileH: Math.round(tb.height),
      };
    }))()`);

    assert.equal(tiles.length, 6, `expected 6 tiles at ${w}x${h}`);
    for (const t of tiles) {
      // Preconditions: a placeholder or a zero-size tile passes everything for free.
      assert.ok(t.text && t.text !== '\u2014', `${t.title} @ ${w}x${h}: still a placeholder — measuring it proves nothing`);
      assert.ok(t.tileH > 0, `${t.title} @ ${w}x${h}: tile has no height`);
      assert.ok(t.truncated <= 1, `${t.title} @ ${w}x${h}: "${t.text}" is truncated by ${t.truncated}px`);
      assert.ok(t.outsideTile <= 1, `${t.title} @ ${w}x${h}: "${t.text}" renders outside its tile`);
      assert.ok(t.trackW > 0, `${t.title} @ ${w}x${h}: meter track has no width`);
      // The meter must never be asked to draw past its own track — that would
      // overstate the number. Values above target (383% of ceiling) cap at full.
      assert.ok(t.askedPct <= 100, `${t.title} @ ${w}x${h}: meter asked for ${t.askedPct}% — it must cap at 100`);
    }
  }
  await resetLayout();
});

test('Pulse state is never carried by colour alone — each state has its own glyph and a text label', { skip }, async () => {
  await resetLayout();
  await setCcEditMode(page, false);
  const tiles = await page.evaluate(`(() => [...document.querySelectorAll('.pg-tile')].map((t) => ({
    title: t.querySelector('.pg-title').textContent,
    state: t.getAttribute('data-state'),
    glyph: (t.querySelector('.pg-st b') || {}).textContent,
    label: (t.querySelector('.pg-stt') || {}).textContent,
    // The label must be ink, not the status hue: warning amber is under 3:1 on
    // this surface by design, so the words can never be the coloured thing.
    labelColor: getComputedStyle(t.querySelector('.pg-stt')).color,
    // The glyph is painted in var(--pg-accent), so its computed colour is the
    // accent resolved the same way the label's is — comparing the label to the
    // raw custom property (a hex) would never match and never fail.
    glyphColor: getComputedStyle(t.querySelector('.pg-st b')).color,
  })))()`);
  assert.equal(tiles.length, 6);

  const byState = new Map();
  for (const t of tiles) {
    assert.ok(t.glyph && t.glyph.trim(), `${t.title}: status has no glyph — state would be colour-alone`);
    assert.ok(t.label && t.label.trim(), `${t.title}: status has no text label`);
    assert.notEqual(t.labelColor, t.glyphColor,
      `${t.title}: the status label is painted in the status colour (${t.labelColor}); it must be ink`);
    // Same state must always mean the same glyph, and different states must not share one.
    if (byState.has(t.state)) assert.equal(byState.get(t.state), t.glyph, `${t.state} uses two different glyphs`);
    byState.set(t.state, t.glyph);
  }
  const glyphs = [...byState.values()];
  assert.equal(new Set(glyphs).size, glyphs.length,
    `two states share a glyph (${JSON.stringify([...byState])}) — greyscale and CVD readers could not tell them apart`);
  // Non-vacuous: the fixture deliberately spans good and bad.
  assert.ok(byState.size >= 2, `only one state present (${[...byState.keys()]}) — this check proves nothing`);
  await resetLayout();
});

test("a Pulse tile's words never contradict its colour", { skip }, async () => {
  await resetLayout();
  await setCcEditMode(page, false);
  const tiles = await page.evaluate(`(() => [...document.querySelectorAll('.pg-tile')].map((t) => ({
    title: t.querySelector('.pg-title').textContent.trim(),
    state: t.getAttribute('data-state'),
    label: t.querySelector('.pg-stt').textContent.trim(),
  })))()`);

  // The fixture puts Jobs Needing Attention at 7 unscheduled of 2774 active —
  // 0.25%, inside the green band. It used to read "✓ NEEDS SCHEDULING", because
  // the colour came from the share and the words came from "is the count zero?".
  const attn = tiles.find((t) => /JOBS NEEDING ATTENTION/i.test(t.title));
  assert.ok(attn, 'the Jobs Needing Attention tile must be present');
  assert.equal(attn.state, 'good', 'precondition: the fixture must put this tile in the green band, or this proves nothing');
  assert.equal(attn.label, 'ON TRACK',
    `a green tile must not ask for action — got "${attn.label}"`);

  // General form of the same rule across every tile in the fixture.
  const CALLS_TO_ACTION = /NEEDS |CHASE|FALLING BEHIND|OVERDUE/i;
  const contradictory = tiles.filter((t) => t.state === 'good' && CALLS_TO_ACTION.test(t.label));
  assert.deepEqual(contradictory, [], `green tiles carrying a call to action: ${JSON.stringify(contradictory)}`);
});

test('the Pulse tiles never clip their own content', { skip }, async () => {
  await resetLayout();
  await setCcEditMode(page, false);
  for (const [w, h] of [[4, 15], [6, 8], [3, 10], [6, 6], [12, 5]]) {
    await page.evaluate(`window._hlCcGrid.update(document.querySelector('[gs-id="cc-pulse"]'), { w: ${w}, h: ${h} })`);
    await page.waitForTimeout(600);
    const clipped = await page.evaluate(`(() => [...document.querySelectorAll('.pg-tile')]
      .map((t) => {
        const tb = t.getBoundingClientRect();
        // The tile centres its children, so overflow escapes BOTH ends and
        // scrollHeight misses the half that goes off the top. Measure the
        // children against the tile box instead — that catches either end.
        let over = 0;
        for (const k of t.children) {
          if (getComputedStyle(k).display === 'none') continue;
          const kb = k.getBoundingClientRect();
          over = Math.max(over, Math.round(tb.top - kb.top), Math.round(kb.bottom - tb.bottom));
        }
        return { title: t.querySelector('.pg-title').textContent, over, h: Math.round(tb.height) };
      })
      .filter((x) => x.over > 1))()`);
    // .pg-tile is overflow:hidden, so anything outside the box is content cut off
    // silently.
    //
    // Honest note on this one: unlike its neighbours it has NOT been shown to
    // fail. The 100px grid row floor plus the container-query shedding mean a
    // tile is never given less room than its content needs, so no CSS mutation
    // short of deleting the floor produces a clip. It is kept as a cheap guard
    // on the property itself (someone lowers the floor, adds a line, or bumps a
    // font) rather than as proof that the mechanism works.
    assert.deepEqual(clipped, [], `Pulse tiles clip their content at ${w}x${h}: ${JSON.stringify(clipped)}`);
  }
  await resetLayout();
});

// --- Today's Decisions footer ------------------------------------------------

// Chris hit this on 2026-08-18: "the start my day button is buried and not
// fully visible". The button is the flex FOOTER of #daily-brief-card — it sits
// after #brief-body, which is the scroll region. But it carried the default
// flex-shrink:1, so once the brief held a real morning's decisions the
// overflowing scroll region squeezed the button instead of scrolling: 55px of
// button rendered as 35px at 1500 wide and 177px as 69px at 520 wide, and the
// card's overflow:hidden silently cut the <small> line off the bottom.
//
// The empty-brief state is the one that hid this for so long — with the
// placeholder headline in it nothing overflows and the button measures
// perfectly. So this test FILLS the brief first, and asserts that it really
// did start overflowing before it judges the button. Without that
// precondition the whole check would pass vacuously against a short brief.
test('START MY DAY stays whole once the brief actually overflows', { skip }, async () => {
  await resetLayout();
  const original = await page.evaluate("document.getElementById('brief-body').innerHTML");
  try {
    for (const [w, h] of [[1500, 900], [1100, 900], [520, 900]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(`document.getElementById('brief-body').innerHTML =
        Array.from({ length: 40 }, (_, i) =>
          '<div style="padding:12px;margin-bottom:8px;border:1px solid #ccc">Decision row ' + i + '</div>').join('')`);
      const m = await page.evaluate(`(() => {
        const btn = document.querySelector('#daily-brief-card .startday');
        const card = document.getElementById('daily-brief-card');
        const body = document.getElementById('brief-body');
        const bb = btn.getBoundingClientRect();
        const cb = card.getBoundingClientRect();
        const small = btn.querySelector('small').getBoundingClientRect();
        const padBottom = parseFloat(getComputedStyle(card).paddingBottom);
        return {
          overflowing: body.scrollHeight > body.clientHeight + 1,
          rendered: Math.round(bb.height),
          natural: btn.scrollHeight,
          smallH: Math.round(small.height),
          // how far the last line of the button falls past the card's padding
          // box, which is where overflow:hidden starts cutting
          past: Math.round(small.bottom - (cb.bottom - padBottom)),
        };
      })()`);
      // Preconditions: the state that broke it must really be reached.
      assert.ok(m.overflowing, `${w}x${h}: brief did not overflow, so this proves nothing`);
      assert.ok(m.natural > 0 && m.smallH > 0, `${w}x${h}: button has no measurable content`);
      // The failure Chris saw, in both of its forms.
      assert.equal(m.rendered, m.natural,
        `${w}x${h}: START MY DAY squeezed to ${m.rendered}px of ${m.natural}px by the overflowing brief`);
      assert.ok(m.past <= 0,
        `${w}x${h}: START MY DAY's subtitle runs ${m.past}px past the card and is clipped`);
    }
  } finally {
    await page.evaluate(`document.getElementById('brief-body').innerHTML = ${JSON.stringify(original)}`);
    await page.setViewportSize({ width: 1500, height: 1900 });
  }
});

// --- refresh truck positions on demand ---------------------------------------
//
// Every source-level assertion about this button passed while it was wired to
// the WRONG map (the dead SCHEDMAP implementation) and fetched nothing, and
// passed again while the handler sat inside an IIFE where the inline onclick
// could not reach it. Both were found by clicking it in a browser. So the
// checks that matter here are behavioural: a click must produce exactly one
// server read, and the pending state must reflect the real one.
test('clicking Refresh performs one real read and shows honest pending state', { skip }, async () => {
  await resetLayout();
  const result = await page.evaluate(`(async () => {
    const b = document.getElementById('cc-map-refresh');
    if (!b) return { error: 'button missing' };
    if (typeof window.ccMapRefreshTechs !== 'function') return { error: 'handler not reachable from onclick' };

    // The GL map does not build in this harness (no vector tiles), so stand in
    // for it. This exercises the handler and the loader; it does not claim to
    // prove marker rendering.
    window._ccMap = window._ccMap || { __stub: true };
    // ccBundleFetch reuses an in-flight bundle for 2s; wait past it or the read
    // is legitimately served from cache and this measures nothing.
    await new Promise((r) => setTimeout(r, 2500));

    let calls = 0;
    const real = window.fetch;
    window.fetch = function (u, o) {
      if (String(u).includes('cc_bundle') || String(u).includes('crew_schedule')) calls++;
      return real(u, o);
    };
    b.click();
    const during = { disabled: b.disabled, spinning: b.classList.contains('spinning') };
    // Extra clicks and direct handler calls. Being precise about what this
    // can and cannot show: it CANNOT detect the re-entrancy guard.
    // ccBundleFetch already shares one in-flight bundle for 2s, so a second
    // entry costs no second network call whether the guard exists or not --
    // deleting the guard leaves this count at 1, which is exactly what
    // happened when it was mutated. What this DOES prove is that no extra
    // read escapes to the server on rapid interaction. The guard itself is
    // asserted at source level in test/map-gps-refresh.test.mjs.
    // programmatic caller would, and are what the guard actually exists for.
    b.click(); b.click();
    window.ccMapRefreshTechs(); window.ccMapRefreshTechs();
    for (let i = 0; i < 80 && b.disabled; i++) await new Promise((r) => setTimeout(r, 100));
    window.fetch = real;
    return { during, settled: { disabled: b.disabled, spinning: b.classList.contains('spinning') }, calls };
  })()`);

  assert.equal(result.error, undefined, `precondition failed: ${result.error}`);
  assert.deepEqual(result.during, { disabled: true, spinning: true },
    'the button must show it is working while the read is genuinely in flight');
  assert.deepEqual(result.settled, { disabled: false, spinning: false },
    'it must return to a clickable state when the read settles');
  assert.equal(result.calls, 1,
    `rapid interaction must not escape extra reads to the server, got ${result.calls}`);
});

test('the Refresh button is a real, labelled target', { skip }, async () => {
  const box = await page.evaluate(`(() => {
    const b = document.getElementById('cc-map-refresh');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), label: b.getAttribute('aria-label') };
  })()`);
  assert.ok(box, 'the button must exist in the shipped markup');
  assert.ok(box.w >= 24 && box.h >= 24, `too small to hit reliably: ${box.w}x${box.h}`);
  assert.equal(box.label, 'Refresh truck positions',
    'a bare glyph needs an accessible name');
});

// --- leaving edit mode -------------------------------------------------------

test('leaving edit mode removes every trace of the editor', { skip }, async () => {
  await resetLayout();
  await setCcEditMode(page, true);
  await setCcEditMode(page, false);
  const counts = await page.evaluate(`(() => ({
    shields: document.querySelectorAll('#cc-main-gridstack .w-shield').length,
    tools: document.querySelectorAll('#cc-main-gridstack .w-tools').length,
    editing: document.getElementById('snapshot').classList.contains('cc-editing'),
  }))()`);
  assert.deepEqual(counts, { shields: 0, tools: 0, editing: false });
  const hits = await page.evaluate(HIT_TEST);
  assertNoVacuous(hits, 'post-edit hit-test');
  assert.deepEqual(hits.filter((h) => h.verdict !== 'content'), [], 'widget content must be clickable again');
});

test('the Command Center raised no page errors while all of this ran', { skip }, () => {
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
});
