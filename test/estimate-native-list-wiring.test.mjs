// test/estimate-native-list-wiring.test.mjs
// jomell, 2026-08-25: E-10004 saved for real ("saved -- a real record now,
// not a local-only draft"), but never showed up in the Estimates list under
// any tab, including "Awaiting response".
//
// Root cause: eqRows() (the function that decides what the Estimates list
// shows) only ever merged two sources -- local drafts (ESTLIST) and
// EQ_QUOTES. EQ_QUOTES is loaded by loadQuotesLive() from
// /api/track1?resource=quotes, which reads the JOBBER-SYNCED `quotes` table
// -- populated only by Jobber's own read-only sync cron. Nothing writes to
// that table from HiveLogic's side, and the whole point of today's other
// fixes is to stop depending on Jobber at all. The estimate that actually
// got created lives in a completely different table
// (api/bookkeeping/estimates/_store.js's `estimates` table), and
// api/bookkeeping/estimates/list.js's own header comment already said this
// list view was supposed to read from it -- it just never was wired up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start > -1, `${decl} must exist`);
  let depth = 0, i = src.indexOf('{', start);
  do {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < src.length);
  assert.equal(depth, 0, 'braces must balance');
  return src.slice(start, i);
}

test('a loader exists that reads from the native estimates endpoint, not the Jobber-synced one', () => {
  const fn = extractFunction(source, 'function loadNativeEstimatesLive(){');
  assert.match(fn, /hlEstList\(\)/, 'must call the real HiveLogic estimates API, the same one efRemoteCreate() writes to');
});

test('eqRows() merges native estimates in alongside local drafts and Jobber quotes', () => {
  const fn = extractFunction(source, 'function eqRows(){');
  assert.match(fn, /local\.concat\(real\)\.concat\(EQ_NATIVE\)/,
    'without this, a real, successfully-created estimate has nowhere to appear');
});

test('eqRenderTabs() counts native estimates too, or "Awaiting response" undercounts', () => {
  const fn = extractFunction(source, 'function eqRenderTabs(){');
  assert.match(fn, /EQ_NATIVE\.forEach/);
});

test('eqRenderKpis() includes native estimates in the KPI totals too', () => {
  const fn = extractFunction(source, 'function eqRenderKpis(){');
  assert.match(fn, /EQ_NATIVE\.map/);
});

test('a freshly created estimate appears immediately, not just after the next poll', () => {
  const fn = extractFunction(source, 'function efSave(){');
  assert.match(fn, /EQ_NATIVE\.unshift\(nativeEstimateToRow\(est\)\)/,
    'must optimistically add the just-created estimate so it shows without waiting for a refetch');
  const unshiftIdx = fn.search(/EQ_NATIVE\.unshift/);
  assert.ok(unshiftIdx > -1);
  // efSave() has two branches that each call efSaveListUpdate(efSaveSummary(true))
  // -- the check must be scoped to the SAME branch as the unshift, not just
  // "does this string appear anywhere in the function".
  const listUpdateIdx = fn.indexOf('efSaveListUpdate(efSaveSummary(true))', unshiftIdx);
  assert.ok(listUpdateIdx > unshiftIdx,
    'must be added to EQ_NATIVE before THIS branch\'s list re-render, or the first render still misses it');
});

test('the native loader is triggered wherever the Jobber-synced one already is', () => {
  const quotesIdx = source.indexOf('loadQuotesLive();');
  assert.ok(quotesIdx > -1);
  const nearby = source.slice(quotesIdx, quotesIdx + 120);
  assert.match(nearby, /loadNativeEstimatesLive\(\);/,
    'both real sources must load together whenever the Estimates list is shown');
});

test('a native estimate\'s lifecycle status maps onto the list\'s status vocabulary', () => {
  const fn = extractFunction(source, 'function nativeEstimateToRow(e){');
  // The engine's own lifecycleStatus values (draft/sent/approved/rejected/
  // converted/cancelled) don't match EQ_STATUS_META's keys 1:1 -- a raw,
  // unmapped 'sent' would never satisfy the "awaiting_response" tab filter.
  assert.match(fn, /sent\s*:\s*'awaiting_response'/,
    'a sent-but-not-approved estimate must land under "Awaiting response", matching what the toast on efSendReal() promises');
});
