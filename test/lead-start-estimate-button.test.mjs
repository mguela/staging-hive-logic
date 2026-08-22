// test/lead-start-estimate-button.test.mjs
// The lead -> estimate hand-off, reachable (2026-08-18).
//
// estFormFromLead() shipped with the lead->estimate link and was never called
// by anything. The plumbing existed with no way for a person to reach it, which
// from the user's side is identical to it not existing -- Chris went looking for
// the button and there wasn't one.
//
// These tests are deliberately about REACHABILITY, not about the estimate
// builder's behaviour. The thing that broke was a wire, so a wire is what gets
// pinned: a function nothing calls, and a button that carries the lead's id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

function callSites(fnName) {
  // Every mention that isn't the declaration itself.
  const all = source.split(fnName).length - 1;
  const declared = (source.match(new RegExp('function\\s+' + fnName)) || []).length;
  return all - declared;
}

test('the lead modal has a button that starts an estimate', () => {
  assert.match(source, /onclick="rlmStartEstimate\(\)"/,
    'the lead detail modal needs a Start estimate button');
});

test('estFormFromLead is actually reachable from the UI', () => {
  // This is the regression: it was defined and called by nothing.
  assert.ok(callSites('estFormFromLead') >= 1,
    'estFormFromLead must be called by something, not just defined');
});

test('rlmStartEstimate passes the lead id through', () => {
  const fn = source.slice(source.indexOf('function rlmStartEstimate'), source.indexOf('function saveRealLead'));
  assert.match(fn, /estFormFromLead\(\s*l\.id\s*,/,
    'the lead id is what ties the estimate back to the lead');
  assert.match(fn, /l\.clientId/, 'the client comes along too');
});

test('a lead with no id is refused rather than silently unlinked', () => {
  // A card synthesised for a client with no opportunity row has no id. Starting
  // an estimate from it would produce one linked to nothing, and the lead would
  // never advance -- worse than saying so.
  const fn = source.slice(source.indexOf('function rlmStartEstimate'), source.indexOf('function saveRealLead'));
  assert.match(fn, /if\s*\(!l\.id\)/, 'must check for a missing lead id');
  assert.match(fn, /Save this lead first/, 'and explain what to do about it');
});

test('the whole lead-to-estimate path is wired end to end', () => {
  // Button -> handler -> builder -> the create call that carries sourceLeadId.
  assert.match(source, /rlmStartEstimate/);
  assert.match(source, /function estFormFromLead/);
  assert.match(source, /EST\.sourceLeadId\s*=/, 'the builder must hold the lead id');
  assert.match(source, /sourceLeadId: EST\.sourceLeadId/, 'and send it when the estimate becomes real');
});
