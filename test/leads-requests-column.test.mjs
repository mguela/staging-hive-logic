// Step 4: Requests is column one, and it keeps filling itself.
//
// The failure this mostly guards against is silence. The step 3 backfill put the
// open requests on the board once; if nothing creates cards for requests that
// arrive afterwards, the column quietly becomes a snapshot of the day it shipped
// -- which is the exact problem the rebuild set out to fix, restored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync('supabase/migrations/20260818140000_lead_pipeline_request_stage.sql', 'utf8');
const track1 = readFileSync('api/track1.js', 'utf8');
const sync = readFileSync('api/jobber/sync-extended.js', 'utf8');
const page = readFileSync('public/index.html', 'utf8');

const createFn = sync.slice(
  sync.indexOf('async function createOpportunitiesForNewRequests'),
  sync.indexOf('async function syncResource')
);
assert.ok(createFn.length > 400, 'could not isolate createOpportunitiesForNewRequests');

test('the request stage is allowed by the database', () => {
  assert.match(sql, /add constraint lead_pipeline_stage_check[\s\S]{0,400}'request'/);
  // every prior stage must survive the constraint being rewritten
  for (const stage of ['new', 'contacted', 'estimate_booked', 'estimate_sent', 'won', 'lost']) {
    assert.match(sql, new RegExp(`'${stage}'`), `stage ${stage} dropped from the check constraint`);
  }
});

test('only unworked requests move to the inbox column', () => {
  // upcoming/today/overdue/assessment_completed all have a visit booked, so they
  // belong in estimate_booked -- overdue means a booked assessment was missed,
  // not that nobody has looked.
  assert.match(sql, /r\.request_status in \('new', 'unscheduled'\)/);
});

test('moving to the inbox cannot drag a worked card backwards', () => {
  assert.match(sql, /and lp\.stage = 'new'/);
});

test('the API accepts the new stage', () => {
  assert.match(track1, /const LEAD_STAGES = \['request', 'new', 'contacted'/);
});

test('cards carry Jobber\'s request status so overdue can show', () => {
  assert.match(track1, /requestOverdue: \(\(requestById\.get\(p\.request_id\) \|\| \{\}\)\.request_status === 'overdue'\)/);
});

test('a failed request lookup does not take the board down with it', () => {
  // The chip is a nicety; the board is not.
  assert.match(track1, /if \(rRes\.ok\) for \(const r of await rRes\.json\(\)\) requestById\.set/);
});

test('new requests keep opening cards after the one-time backfill', () => {
  assert.match(sync, /async function createOpportunitiesForNewRequests\(\)/);
  assert.match(sync, /const opened = await createOpportunitiesForNewRequests\(\)/);
});

test('the sync uses the same rules as the backfill', () => {
  assert.match(createFn, /request_status=not\.in\.\(converted,archived\)/);
  assert.match(createFn, /\['new', 'unscheduled'\]\.includes\(r\.request_status\) \? 'request' : 'estimate_booked'/);
});

test('a request already on the board is never added twice', () => {
  assert.match(createFn, /const have = new Set\(/);
  assert.match(createFn, /!have\.has\(r\.jobber_id\)/);
  // and belt-and-braces at the database, for two syncs overlapping
  assert.match(createFn, /on_conflict=request_id/);
  assert.match(createFn, /resolution=ignore-duplicates/);
});

test('one unsynced client cannot block every other new card', () => {
  // client_id is a foreign key; a single dangling id would reject the whole
  // insert, so candidates are checked against clients first.
  assert.match(createFn, /clients\?jobber_id=in\./);
  assert.match(createFn, /known\.has\(r\.client_id\)/);
});

test('the sync degrades quietly before the migrations are applied', () => {
  // request_id does not exist until 20260818120000; a throw here would take the
  // whole extended sync down.
  const guards = createFn.match(/return \{ created: 0, skipped: true \}/g) || [];
  assert.ok(guards.length >= 3, `expected every read to be guarded, found ${guards.length}`);
});

test('cards open before they close, so a same-window convert still lands', () => {
  const order = sync.slice(sync.indexOf("if (name === 'requests') {"));
  assert.ok(
    order.indexOf('createOpportunitiesForNewRequests()') < order.indexOf('closeOpportunitiesForConvertedRequests()'),
    'a request that arrived and converted between two syncs would be missed'
  );
});

test('Requests is the first column on the board', () => {
  assert.match(page, /LEAD_STAGE_ORDER = \['request', 'new', 'contacted'/);
  assert.match(page, /LEAD_STAGE_LABELS = \{ request: 'REQUESTS',/);
});

test('the inbox is ordered by who has been waiting longest', () => {
  assert.match(page, /if \(a\.requestOverdue !== b\.requestOverdue\) return a\.requestOverdue \? -1 : 1;/);
  assert.match(page, /Date\.parse\(a\.createdAt \|\| 0\) - Date\.parse\(b\.createdAt \|\| 0\)/);
});

test('overdue and age show only on cards that came from a request', () => {
  assert.match(page, /var overdue = l\.requestOverdue \? '<span class="od">OVERDUE<\/span>' : '';/);
  assert.match(page, /var age = l\.requestId \? leadAgeLabel\(l\.createdAt\) : '';/);
  assert.match(page, /\.lead \.od\{/);
});

test('an empty inbox says nothing came in, not that nobody dragged anything', () => {
  assert.match(page, /stage === 'request' \? 'No new requests from Jobber'/);
});
