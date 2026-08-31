// Browser test for the "REINA READS SHEET" / "READ ALL SHEETS" buttons added
// to HiveGrid's Live Workbench (public/index.html, view "tox", iframe #if-tox).
//
// Mirrors hivegrid-takeoff-workbench.test.mjs's harness: the network is
// sealed and /api/takeoffs is stubbed, so this proves the CLIENT side --
// scope selection (current sheet vs every sheet), real POST bodies, loading/
// disabled state, the results modal, and "+ ADD TO TAKEOFF" pushing a
// suggestion into WBCONDS without ever touching WB.marks. The real Anthropic
// vision call itself is covered server-side by
// test/reina-plan-read.test.mjs and test/takeoffs-reina-read.test.mjs.
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

const FAKE_ANALYSIS = {
  sheetNumber: 'A-1.0', sheetTitle: 'Floor Plan', drawingType: 'floor_plan',
  rooms: [{ name: 'Kitchen' }], dimensions: [], symbols: [{ label: 'Recessed light', trade: 'ELEC', count: 8 }],
  doors: [], windows: [], cabinets: [], flooring: [], demolition: [], existingVsNew: null,
  fixtures: [], materials: [], notes: ['Sample note'],
  // Deliberately NOT "Recessed lights" -- that name collides with one of the
  // Live Workbench's own 4 seeded default conditions, and wbReinaAddCandidateAt
  // correctly refuses to add a duplicate name. A distinct name is what
  // actually proves the add path, rather than exercising the dedupe guard.
  takeoffCandidates: [{ name: 'Detected recessed cans', type: 'count', unit: 'EA', trade: 'ELEC', estimatedQty: 8, confidence: 0.8, notes: '8 counted' }],
  issues: [], confidence: 0.8, warnings: [],
};

const FAKE_OVERVIEW = {
  overallSummary: 'Kitchen remodel with new electrical rough-in across two sheets.',
  projectType: 'Kitchen remodel', tradesInvolved: ['ELEC', 'CARP'],
  rolledUpTakeoffCandidates: [{ name: 'Rolled-up recessed cans', type: 'count', unit: 'EA', trade: 'ELEC', estimatedQty: 8, confidence: 0.75, notes: 'from both sheets', sourceSheets: ['A-1.0', 'E-1.0'] }],
  conflicts: ['Room labeled differently between sheets'],
  missingInfo: ['No plumbing sheet in this set'],
  confidence: 0.7,
};

// This fake backend's whole state: what a real /api/takeoffs?action=reina_read
// call would have received, so tests can assert on the real request shape.
let lastReinaRequest = null;
let reinaRequestCount = 0;

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
        return route.fulfill({ body: JSON.stringify({ ok: true, takeoffs: [] }), contentType: 'application/json' });
      }
      if (req.method() === 'POST') {
        const body = JSON.parse(req.postData() || '{}');
        if (body.action === 'reina_read') {
          lastReinaRequest = body;
          reinaRequestCount += 1;
          const results = body.sheets.map((s) => ({ index: s.index, name: s.name, ok: true, analysis: FAKE_ANALYSIS }));
          // Mirrors the real route: only all_sheets mode over 2+ readable sheets gets a synthesis pass.
          const overview = (body.mode === 'all_sheets' && results.length >= 2) ? FAKE_OVERVIEW : null;
          return route.fulfill({ body: JSON.stringify({ ok: true, mode: body.mode, quoteId: body.quote_id, configured: true, results, overview, overviewError: null }), contentType: 'application/json' });
        }
        return route.fulfill({ body: JSON.stringify({ ok: true }), contentType: 'application/json' });
      }
      return route.fulfill({ body: JSON.stringify({ ok: true }), contentType: 'application/json' });
    }),
  ]);
}

let server, browser, page, frame, pageErrors;

before(async () => {
  if (skip) return;
  lastReinaRequest = null;
  server = await startServer();
  ({ browser, page, frame, pageErrors } = await openHiveGridWorkbench(chromium, server.url, { stubApi }));
  // Boot the Live Workbench tool itself (idempotent), same as the save/load suite.
  await frame.locator('.ttab:has-text("Live workbench")').click();
  await frame.waitForFunction('window.WB && window.WB.inited === true', null, { timeout: 10000 });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

test('both Reina buttons render in the toolbar and start enabled once the workbench is loaded', { skip }, async () => {
  const btn1 = frame.locator('#wbreinabtn1');
  const btn2 = frame.locator('#wbreinabtn2');
  await assert.doesNotReject(btn1.waitFor({ state: 'visible', timeout: 5000 }));
  await assert.doesNotReject(btn2.waitFor({ state: 'visible', timeout: 5000 }));
  assert.equal(await btn1.isDisabled(), false, 'REINA READS SHEET must be enabled once the sample sheet is loaded');
  assert.equal(await btn2.isDisabled(), false, 'READ ALL SHEETS must be enabled once the sample sheet is loaded');
});

test('REINA READS SHEET sends mode=current_sheet with exactly the active sheet, shows a busy state, and renders the results modal', { skip }, async () => {
  const btn1 = frame.locator('#wbreinabtn1');
  const clickPromise = btn1.click();
  // Busy state should appear -- label changes and aria-busy is set -- before the
  // (stubbed but still async) network round trip resolves.
  await frame.waitForFunction(`document.getElementById('wbreinabtn1').getAttribute('aria-busy')==='true'`, null, { timeout: 3000 }).catch(() => {});
  await clickPromise;
  await frame.waitForFunction(`!!document.getElementById('wbreinamodal')`, null, { timeout: 5000 });

  assert.ok(lastReinaRequest, 'the real POST body must have reached the stubbed backend');
  assert.equal(lastReinaRequest.mode, 'current_sheet');
  assert.equal(lastReinaRequest.sheets.length, 1, 'current_sheet mode must send exactly one sheet, never the whole plan');
  assert.ok(/^data:image\/png;base64,/.test(lastReinaRequest.sheets[0].dataUrl), 'the active sheet must be sent as a real rendered image, not a placeholder');

  const modalText = await frame.locator('#wbreinamodal').innerText();
  assert.match(modalText, /Reina Analysis/);
  assert.match(modalText, /Recessed light/);
  assert.match(modalText, /Detected recessed cans/);

  await frame.waitForFunction(`document.getElementById('wbreinabtn1').getAttribute('aria-busy')==='false'`, null, { timeout: 3000 });
});

test('the "+ ADD TO TAKEOFF" suggestion button adds a real condition and never touches existing marks', { skip }, async () => {
  const before = await frame.evaluate(() => ({ condCount: window.WBCONDS.length, markCount: window.WB.marks.length }));
  await frame.locator('#wbreinamodal button:has-text("ADD TO TAKEOFF")').first().click();
  const after = await frame.evaluate(() => ({
    condCount: window.WBCONDS.length,
    markCount: window.WB.marks.length,
    names: window.WBCONDS.map((c) => c.name),
  }));
  assert.equal(after.condCount, before.condCount + 1, 'exactly one new condition must be added');
  assert.ok(after.names.includes('Detected recessed cans'), 'the added condition must carry Reina\'s suggested name');
  assert.equal(after.markCount, before.markCount, 'adding a suggestion must never create or alter a mark/quantity');

  // Close the modal via its own removal, not a simulated click on the close
  // glyph -- the fixed overlay (inset:0) would otherwise keep intercepting
  // pointer events for whichever test runs next.
  await frame.evaluate(() => { var m = document.getElementById('wbreinamodal'); if (m) m.remove(); });
});

test('READ ALL SHEETS sends every loaded sheet, retaining sheet identity', { skip }, async () => {
  lastReinaRequest = null;
  reinaRequestCount = 0;
  const btn2 = frame.locator('#wbreinabtn2');
  const sheetCount = await frame.evaluate(() => window.WB.sheets.length);

  await btn2.click();
  await frame.waitForFunction(`!!document.getElementById('wbreinamodal')`, null, { timeout: 5000 });

  assert.ok(lastReinaRequest, 'the real POST body must have reached the stubbed backend');
  assert.equal(lastReinaRequest.mode, 'all_sheets');
  assert.equal(lastReinaRequest.sheets.length, sheetCount, 'all_sheets mode must include every loaded sheet, not just the active one');
  const indices = lastReinaRequest.sheets.map((s) => s.index);
  assert.deepEqual(indices, [...new Set(indices)], 'no sheet should be sent twice');

  const modalText = await frame.locator('#wbreinamodal').innerText();
  assert.match(modalText, /Reina Plan Analysis/);
  assert.match(modalText, new RegExp(`${sheetCount} sheets? analyzed`));

  await frame.evaluate(() => { var m = document.getElementById('wbreinamodal'); if (m) m.remove(); });
});

test('READ ALL SHEETS shows a cross-sheet Overall Plan Summary, not just N independent per-sheet reads', { skip }, async () => {
  // The stubbed backend only returns an overview for 2+ readable sheets --
  // same rule as the real route (nothing to synthesize across just one). The
  // sample plan starts with a single seeded sheet, so add a second one
  // directly (reusing the sample canvas -- only its presence matters for
  // rlvToxSheetImageDataURL(), not its pixels).
  await frame.evaluate(() => {
    var s0 = window.WB.sheets[0];
    window.WB.sheets.push({ name: 'E-1.0 SAMPLE', img: s0.img, w: s0.w, h: s0.h, ftpx: 0, cal: false, ppi: null });
  });
  // Defensive: a prior failing test in this file could have left the modal
  // open, which would intercept this click for the full actionability timeout.
  await frame.evaluate(() => { var m = document.getElementById('wbreinamodal'); if (m) m.remove(); });

  await frame.locator('#wbreinabtn2').click();
  await frame.waitForFunction(`!!document.getElementById('wbreinamodal')`, null, { timeout: 5000 });

  const modalText = await frame.locator('#wbreinamodal').innerText();
  assert.match(modalText, /Overall Plan Summary/);
  assert.match(modalText, /Kitchen remodel with new electrical rough-in/);
  assert.match(modalText, /Rolled-up recessed cans/, 'the rolled-up (cross-sheet) candidate must render, not just each sheet\'s own candidates');
  assert.match(modalText, /Room labeled differently between sheets/, 'a cross-sheet conflict must surface, not be silently dropped');
  assert.match(modalText, /No plumbing sheet in this set/);

  // The rolled-up candidate must be addable through the same mechanism as a
  // per-sheet candidate -- one more real condition, still no marks touched.
  const before = await frame.evaluate(() => ({ condCount: window.WBCONDS.length, markCount: window.WB.marks.length }));
  await frame.locator('#wbreinamodal button:has-text("ADD TO TAKEOFF")').first().click();
  const after = await frame.evaluate(() => ({ condCount: window.WBCONDS.length, markCount: window.WB.marks.length, names: window.WBCONDS.map((c) => c.name) }));
  assert.equal(after.condCount, before.condCount + 1);
  assert.ok(after.names.includes('Rolled-up recessed cans'));
  assert.equal(after.markCount, before.markCount);

  await frame.evaluate(() => { var m = document.getElementById('wbreinamodal'); if (m) m.remove(); });
});

test('REINA READS SHEET (single sheet) never shows a cross-sheet Overall Plan Summary -- there is nothing to synthesize', { skip }, async () => {
  await frame.evaluate(() => { var m = document.getElementById('wbreinamodal'); if (m) m.remove(); });
  await frame.locator('#wbreinabtn1').click();
  await frame.waitForFunction(`!!document.getElementById('wbreinamodal')`, null, { timeout: 5000 });
  const modalText = await frame.locator('#wbreinamodal').innerText();
  assert.doesNotMatch(modalText, /Overall Plan Summary/);
  await frame.evaluate(() => { var m = document.getElementById('wbreinamodal'); if (m) m.remove(); });
});

test('a second wbReinaRead() call while one is still in flight is ignored, not queued as a duplicate request', { skip }, async () => {
  lastReinaRequest = null;
  reinaRequestCount = 0;
  // Two synchronous calls with no Playwright actionability wait in between --
  // this isolates the app's OWN WBREINA_BUSY guard from any click-timing
  // artifacts of the test driver itself.
  await frame.evaluate(() => { window.wbReinaRead('all_sheets'); window.wbReinaRead('all_sheets'); });
  await frame.waitForFunction(`!!document.getElementById('wbreinamodal')`, null, { timeout: 5000 });
  assert.equal(reinaRequestCount, 1, 'the second call while busy must not reach the network at all');
  await frame.evaluate(() => { var m = document.getElementById('wbreinamodal'); if (m) m.remove(); });
});

test('the Live Workbench raised no page errors while all of this ran', { skip }, () => {
  assert.deepEqual(pageErrors, []);
});
