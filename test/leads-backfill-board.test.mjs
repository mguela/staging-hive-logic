// Step 3: the board becomes the opportunities, and open requests are on it.
//
// Two failures this guards against, both silent:
//   * the backfill importing converted/archived requests, which would rebuild
//     the 1,457-row graveyard it exists to clear
//   * the board looking client names up under an is_lead filter -- 23 of the 30
//     open requests come from existing CUSTOMERS, so those cards would render
//     with no name at all

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync('supabase/migrations/20260818130000_lead_pipeline_backfill_from_requests.sql', 'utf8');
const track1 = readFileSync('api/track1.js', 'utf8');
const sync = readFileSync('api/jobber/sync-extended.js', 'utf8');

const leadsFn = track1.slice(
  track1.indexOf('async function handleLeads'),
  track1.indexOf('async function getRequestingProfile')
);
assert.ok(leadsFn.length > 500, 'could not isolate handleLeads');

test('only genuinely open requests are imported', () => {
  // 1,120 converted + 337 archived must stay off the board.
  assert.match(sql, /where r\.request_status not in \('converted', 'archived'\)/);
});

test('the import cannot duplicate a card when re-run', () => {
  assert.match(sql, /on conflict \(request_id\) where request_id is not null do nothing/);
});

test('the import skips requests whose client no longer exists', () => {
  // client_id is a foreign key; a dangling one aborts the whole migration.
  assert.match(sql, /exists \(select 1 from public\.clients c where c\.jobber_id = r\.client_id\)/);
});

test('stage mapping never invents progress', () => {
  // Only two outcomes, both defensible from what Jobber actually records.
  assert.match(sql, /when r\.request_status in \('new', 'unscheduled'\) then 'new'/);
  assert.match(sql, /else 'estimate_booked'/);
  // Nothing may be imported as already sent, won or lost.
  assert.doesNotMatch(sql, /then 'estimate_sent'/);
  assert.doesNotMatch(sql, /insert[\s\S]*?then 'won'/);
});

test('only leads touched in the last 30 days come across', () => {
  assert.match(sql, /c\.jobber_updated_at > now\(\) - interval '30 days'/);
  assert.match(sql, /not exists \(\s*select 1 from public\.lead_pipeline lp where lp\.client_id = c\.jobber_id\s*\)/);
});

test('the lead-client pass does not resurrect archived clients', () => {
  assert.match(sql, /where c\.is_lead\s*\n\s*and not c\.is_archived/);
});

test('converted requests close their opportunity, but never reopen a decision', () => {
  assert.match(sql, /set stage = 'won'[\s\S]{0,220}r\.request_status = 'converted'/);
  // A card the team marked lost by hand must survive Jobber converting later.
  assert.match(sql, /lp\.stage not in \('won', 'lost'\)/);
});

test('every card has something to display as a title', () => {
  assert.match(sql, /set title = c\.name[\s\S]{0,200}lp\.title is null/);
});

test('the board lists opportunities, not every is_lead client', () => {
  // The synthetic card-per-client pass is what produced 346 cards stuck in New.
  assert.doesNotMatch(leadsFn, /clientsWithRow/,
    'the board should no longer synthesise a card for every is_lead client');
  assert.match(leadsFn, /const leads = pipeline\.map\(/);
});

test('client names are fetched for opportunity holders, not is_lead clients', () => {
  // The bug: 23 of 30 open requests are from existing customers. An is_lead
  // filter here renders those cards nameless.
  assert.doesNotMatch(leadsFn, /clients\?is_lead=eq\.true/,
    'names must be looked up by the client ids that hold opportunities');
  assert.match(leadsFn, /const clientIds = \[\.\.\.new Set\(pipeline\.map\(\(p\) => p\.client_id\)/);
  assert.match(leadsFn, /clients\?jobber_id=in\./);
});

test('an empty pipeline does not fire a client query', () => {
  assert.match(leadsFn, /if \(clientIds\.length\) \{/);
});

test('syncing requests closes the opportunities Jobber finished', () => {
  assert.match(sync, /async function closeOpportunitiesForConvertedRequests\(\)/);
  assert.match(sync, /if \(name === 'requests'\) \{/);
  assert.match(sync, /stage=not\.in\.\(won,lost\)/);
});

test('the sync auto-close is a no-op before the migration is applied', () => {
  // request_id does not exist until 20260818120000 runs. A hard failure here
  // would take the whole extended sync down with it.
  assert.match(sync, /if \(!openRes\.ok\) return \{ closed: 0, skipped: true \}/);
});

test('the sync auto-close never overwrites a hand-set outcome', () => {
  const fn = sync.slice(
    sync.indexOf('async function closeOpportunitiesForConvertedRequests'),
    sync.indexOf('async function syncResource')
  );
  assert.match(fn, /stage=not\.in\.\(won,lost\)/);
  assert.doesNotMatch(fn, /stage: 'lost'/);
  assert.match(fn, /stage: 'won'/);
});
