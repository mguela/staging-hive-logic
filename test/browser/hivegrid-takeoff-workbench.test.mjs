// Browser test for HiveGrid's Live Workbench (public/index.html, view "tox").
//
// Found during the 8/17 Dev To-Do triage: "Full browser click-through (draw,
// save, reload a takeoff) never done -- only verified at API/schema level."
// The item's own note called it a separate codebase needing an access check
// first. It is not -- the Live Workbench is embedded right here, explicitly
// labelled "LIVE WORKBENCH TAB = REAL WORKING TOOL", backed by a real
// api/takeoffs.js. The rest of the HiveGrid page (Plans & counts, Scope
// reader, By trade, Quantities, Bid schedule, Learning) IS a pitch-deck-style
// mockup -- canned hlToast() responses, not real data -- and is deliberately
// untouched here; only the Live Workbench tab is claimed as real, so it is
// the only thing this test holds to that claim.
//
// Two things make this harder than the Schedule board / Command Center
// browser tests it's modelled on:
//   1. The Workbench runs inside its own document, loaded via
//      <iframe data-hl63="...">, re-assigned to .srcdoc on every
//      showView('tox') -- not a plain view in the main document.
//   2. Its script reads window.parent.sb directly for the Supabase session,
//      rather than the outer page's usual fetch path.
// Neither actually needed new plumbing: per the HTML spec a srcdoc document's
// base URL is its container's, so the iframe's relative fetch('/api/...')
// calls resolve to this harness's own server and page.route() sees them like
// any other request; and window.parent.sb resolves to the same global `sb`
// the outer page builds from window.supabase.createClient(...), which
// driver.mjs's existing SUPABASE_STUB already replaces.
//
// What's deliberately NOT simulated: freehand canvas drawing. WB.marks and
// WBCONDS are plain arrays the drawing tools push onto after translating real
// mouse-drag pixels into canvas-space points -- reproducing that faithfully
// would mean a second, much larger project (calibration, zoom/pan state,
// per-tool geometry) to test a comparatively low-stakes rendering concern.
// What actually matters here -- does a takeoff's real data survive a real
// save and a real reload -- doesn't need pixel-perfect drawing to prove: one
// mark and one condition are seeded directly into the real, live WB/WBCONDS
// arrays the drawing tools would otherwise have populated, and everything
// downstream of that (the SAVE button, the network call, the reload, the
// LOAD button) is exercised for real.
//
// Run with: npm run test:ui

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './serve.mjs';
import { findPlaywright, unavailableReason, openHiveGridWorkbench, waitForToxFrame } from './driver.mjs';

const reason = unavailableReason();
if (reason && process.env.HL_UI_TESTS_REQUIRED === '1') {
  throw new Error(
    `HL_UI_TESTS_REQUIRED=1 but the browser tests cannot run: ${reason}. `
    + 'Refusing to report a pass for tests that did not execute.');
}
const skip = reason || false;
const chromium = skip ? null : findPlaywright().chromium;

const FAKE_QUOTE = { id: 'q-real-1', clientName: 'Kim Kitchen', quoteNumber: 4821, total: 18500, status: 'awaiting_response' };
const TEST_CONDITION = { name: 'TEST Recessed lights', type: 'count', unit: 'EA', trade: 'ELEC', color: '#1B7A50', waste: 0, meas: [], hide: false };
const TEST_MARK = { sheet: 0, kind: 'dim', pts: [[10, 10], [100, 10]], color: '#161e2e' };

async function waitFor(fn, { timeout = 8000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor: condition never became true');
    await new Promise((r) => setTimeout(r, interval));
  }
}

// This fake backend's whole state: what api/takeoffs.js would have persisted.
// Reset per test run via `before`, not per-assertion, because the entire
// point is that it survives across the simulated "reload" below.
let savedTakeoff = null;

function stubApi(on) {
  return Promise.all([
    on((u) => u.pathname === '/api/track1' && u.searchParams.get('resource') === 'quotes',
      (r) => r.fulfill({ body: JSON.stringify({ ok: true, quotes: [FAKE_QUOTE], totalCount: 1 }), contentType: 'application/json' })),
    on((u) => u.pathname === '/api/takeoffs', (route) => {
      const req = route.request();
      const u = new URL(req.url());
      if (req.method() === 'GET' && u.searchParams.get('action') === 'sign') {
        return route.fulfill({ body: JSON.stringify({ ok: false, error: 'not exercised by this test' }), contentType: 'application/json' });
      }
      if (req.method() === 'GET') {
        return route.fulfill({ body: JSON.stringify({ ok: true, takeoffs: savedTakeoff ? [savedTakeoff] : [] }), contentType: 'application/json' });
      }
      if (req.method() === 'POST') {
        const body = JSON.parse(req.postData() || '{}');
        if (body.action === 'upload_image') {
          return route.fulfill({ body: JSON.stringify({ ok: true, storagePath: 'takeoffs/fake/sheet-0.png' }), contentType: 'application/json' });
        }
        // The real save: api/takeoffs.js persists exactly this shape.
        savedTakeoff = { id: 'to-1', quote_id: body.quote_id, conditions: body.conditions, marks: body.marks, sheets: body.sheets };
        return route.fulfill({ body: JSON.stringify({ ok: true, takeoff: savedTakeoff }), contentType: 'application/json' });
      }
      return route.fulfill({ body: JSON.stringify({ ok: true }), contentType: 'application/json' });
    }),
  ]);
}

let server, browser, page, frame, pageErrors;

before(async () => {
  if (skip) return;
  savedTakeoff = null;
  server = await startServer();
  ({ browser, page, frame, pageErrors } = await openHiveGridWorkbench(chromium, server.url, { stubApi }));
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

// These run in file order (node:test's default) and are deliberately
// stateful across each other -- save has to happen before reload, which has
// to happen before load -- the same way a person would actually use this.

test('picking a real quote is a real network round trip, not a stub value', { skip }, async () => {
  // rlvToxLoad() fires the moment the iframe's script runs -- wait for the
  // real fetch to land rather than assuming it already has.
  await frame.waitForFunction(
    `document.getElementById('rlv-tox-pick').options.length > 1`, null, { timeout: 10000 },
  );
  const optionText = await frame.locator('#rlv-tox-pick option').nth(1).textContent();
  assert.ok(optionText.includes('Kim Kitchen'), `expected the real fetched quote in the picker, got: ${optionText}`);

  // A real <select> change event, not a direct rlvToxPick() call.
  await frame.locator('#rlv-tox-pick').selectOption('0');
  await frame.waitForFunction(
    `document.getElementById('rlv-tox-detail').textContent.includes('Kim Kitchen')`, null, { timeout: 5000 },
  );
});

test('the canvas tool actually initializes with real layout', { skip }, async () => {
  // Live workbench is the default tab, but wbEnsure() only runs from the
  // tab's own onclick -- click it for real rather than assuming default
  // markup state means the tool booted.
  await frame.locator('.ttab:has-text("Live workbench")').click();
  await frame.waitForFunction('window.WB && window.WB.inited === true', null, { timeout: 10000 });
  // A measurement that can't fail proves nothing: assert the canvas this
  // whole tool draws into actually has real, non-zero size.
  const size = await frame.evaluate(() => {
    const r = document.getElementById('wbcanvas').getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  assert.ok(size.w > 50 && size.h > 50, `wbcanvas has no real size: ${JSON.stringify(size)}`);
});

test('SAVE TAKEOFF sends the real mark and condition over the real network', { skip }, async () => {
  // Frame.evaluate() takes at most ONE extra argument -- both seeds have to
  // travel in a single object.
  await frame.evaluate(({ cond, mark }) => {
    window.WBCONDS.push(cond);
    window.WB.marks.push(mark);
  }, { cond: TEST_CONDITION, mark: TEST_MARK });

  assert.equal(savedTakeoff, null, 'sanity: nothing saved yet');
  await frame.locator('button:has-text("SAVE TAKEOFF")').click();
  await waitFor(() => savedTakeoff !== null);

  assert.equal(savedTakeoff.quote_id, FAKE_QUOTE.id);
  assert.ok(
    savedTakeoff.conditions.some((c) => c.name === TEST_CONDITION.name),
    'the seeded condition must have travelled through the real SAVE button into the real POST body',
  );
  assert.ok(
    savedTakeoff.marks.some((m) => m.kind === TEST_MARK.kind && m.pts[0][0] === TEST_MARK.pts[0][0]),
    'the seeded mark must have travelled through the real SAVE button into the real POST body',
  );
});

test('a simulated reload wipes in-memory state, proving the next step is a real reload', { skip }, async () => {
  await page.evaluate('showView("tox")'); // re-assigns the iframe's srcdoc fresh
  frame = await waitForToxFrame(page);
  // WBCONDS ships with 4 real demo conditions by default (Recessed lights,
  // LVP flooring, Base cabinets, Demo -- wall & soffit) -- a fresh load is
  // "back to those 4", not "empty". WB.marks does start genuinely empty.
  const state = await frame.evaluate(() => ({
    condNames: window.WBCONDS.map((c) => c.name),
    markCount: window.WB.marks.length,
  }));
  assert.ok(
    !state.condNames.includes(TEST_CONDITION.name),
    `sanity: a fresh iframe load must not carry the seeded condition forward -- otherwise LOAD SAVED TAKEOFF proves nothing. Got: ${JSON.stringify(state.condNames)}`,
  );
  assert.equal(state.markCount, 0, 'sanity: a fresh iframe load must start with no marks -- otherwise LOAD SAVED TAKEOFF proves nothing');
});

test('LOAD SAVED TAKEOFF restores the real mark and condition from the real backend', { skip }, async () => {
  await frame.waitForFunction(
    `document.getElementById('rlv-tox-pick').options.length > 1`, null, { timeout: 10000 },
  );
  // Re-picking the same quote is what triggers the "a saved takeoff already
  // exists" row -- exactly the real user path, not a direct function call.
  await frame.locator('#rlv-tox-pick').selectOption('0');
  await frame.waitForFunction(
    `getComputedStyle(document.getElementById('rlv-tox-loadrow')).display !== 'none'`, null, { timeout: 5000 },
  );

  // exact: true -- the help text right below this button also happens to
  // contain the substring "LOAD SAVED TAKEOFF" mid-sentence ("...and LOAD
  // SAVED TAKEOFF fetches a fresh, time-limited link..."), which a plain
  // getByText() matches too and Playwright's strict mode then refuses to
  // click either.
  await frame.getByText('LOAD SAVED TAKEOFF', { exact: true }).click();
  await frame.waitForFunction(
    `window.WBCONDS.some(c => c.name === ${JSON.stringify(TEST_CONDITION.name)})`, null, { timeout: 5000 },
  );

  const restored = await frame.evaluate(() => ({
    conds: window.WBCONDS.map((c) => c.name),
    marks: window.WB.marks.map((m) => m.kind),
  }));
  assert.ok(restored.conds.includes(TEST_CONDITION.name), `condition did not survive save->reload->load: ${JSON.stringify(restored)}`);
  assert.ok(restored.marks.includes(TEST_MARK.kind), `mark did not survive save->reload->load: ${JSON.stringify(restored)}`);
});

test('the Live Workbench raised no page errors while all of this ran', { skip }, () => {
  assert.deepEqual(pageErrors, []);
});
