// test/marketing-attribution-contract.test.mjs
//
// The attribution contract between api/marketing.js and the marketing app that
// is ACTUALLY SHIPPED -- public/marketing-command-center/index.html, which the
// Command Center opens in an iframe.
//
// This exists because of what it replaced. Three test files
// (marketing-phase18-{attribution,last-touch,assisted}-frontend*.test.mjs) used
// to assert these backend fields, but only incidentally: their subject was
// public/app-marketing.js, a module no page ever loaded. That file was deleted
// on 2026-08-18. Deleting its tests with it would have dropped the ONLY
// assertions that the backend still returns fields the live app reads -- so the
// backend half is kept here, pointed at the real consumer.
//
// Every field below was verified as read by the live app before being asserted,
// not copied from the deleted tests. marketing-command-center/index.html:1322-1327:
//     var lastTouch = attrOk ? (attr.lastTouch || null) : null;
//     (lastTouch && lastTouch.campaigns || []).forEach(function(c){ ...c.campaignId... });
//     var assisted  = attrOk ? (attr.assisted  || null) : null;
//     (assisted  && assisted.campaigns  || []).forEach(function(c){ ...c.campaignId... });

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const api = fs.readFileSync('api/marketing.js', 'utf8');
const liveApp = fs.readFileSync('public/marketing-command-center/index.html', 'utf8');

test('the live marketing app is the one that reads attribution, and it is still shipped', () => {
  // If this ever fails, the rest of the file is guarding a contract with nobody.
  assert.match(liveApp, /attr\.lastTouch/, 'the shipped app must still read lastTouch');
  assert.match(liveApp, /attr\.assisted/, 'the shipped app must still read assisted');
  assert.match(liveApp, /'\/api\/marketing\?resource='/, 'and it must still call api/marketing');
});

test('the attribution resource exists and returns the two models the live app reads', () => {
  assert.match(api, /resource === 'attribution'/, 'the attribution resource must exist');
  assert.match(api, /lastTouch: lastTouchResult,/,
    'api/marketing.js must return lastTouch -- the shipped app renders it per campaign');
  assert.match(api, /assisted: assistedResult,/,
    'api/marketing.js must return assisted -- the shipped app renders it per campaign');
});

test('attributed campaigns still carry the id the live app keys them by', () => {
  // Both models are consumed as `campaigns[]` keyed by campaignId. Without that
  // key the app builds empty lookup maps and silently renders nothing.
  assert.match(api, /campaignId/, 'attribution campaigns must carry campaignId');
});

test('the attribution summary fields are still returned', () => {
  // Kept from the deleted phase18 test, which is the only place these were
  // asserted. They are what the coverage tile reads.
  for (const field of ['attributionCoveragePct', 'totalAttributedRevenueCents', 'totalUnattributedJobs']) {
    assert.ok(api.includes(field), `api/marketing.js must still return ${field}`);
  }
});
