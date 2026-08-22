// A lead is an opportunity (a potential job), not a person.
//
// lead_pipeline.client_id used to be UNIQUE, so one client could hold exactly
// one lead. Production data disagrees with that shape: 282 clients have sent
// more than one request, one sent 12, and the average gap between a client's
// first and last request is 344 days -- separate jobs, quoted separately.
//
// These tests pin the parts that silently break if the model is half-applied:
// the migration must actually drop the constraint, and no write path may still
// depend on it. A leftover ON CONFLICT (client_id) does not fail at build time,
// it fails in production the first time somebody drags a card.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MIGRATION = 'supabase/migrations/20260818120000_lead_pipeline_opportunity_model.sql';
const sql = readFileSync(MIGRATION, 'utf8');
const track1 = readFileSync('api/track1.js', 'utf8');
const page = readFileSync('public/index.html', 'utf8');

// The handleLeads body only -- track1.js is large and other resources legitimately
// use client_id keying.
const leadsFn = track1.slice(
  track1.indexOf('async function handleLeads'),
  track1.indexOf('async function getRequestingProfile')
);
assert.ok(leadsFn.length > 500, 'could not isolate handleLeads');

test('the migration drops the one-lead-per-client constraint', () => {
  assert.match(sql, /drop constraint if exists lead_pipeline_client_id_key/i);
});

test('client_id keeps an index after losing its unique constraint', () => {
  // The UNIQUE constraint was also the index behind "leads for this client",
  // which is the board's hot path. Dropping it without a replacement turns
  // every board load into a sequential scan.
  assert.match(sql, /create index if not exists lead_pipeline_client_id_idx\s+on public\.lead_pipeline \(client_id\)/i);
});

test('an opportunity carries a job title and a link to its request', () => {
  assert.match(sql, /add column if not exists title text/i);
  assert.match(sql, /add column if not exists request_id text/i);
});

test('a deleted request blanks the link but keeps the opportunity', () => {
  // Stage history, value and lost reason are HiveLogic's own work. A request
  // vanishing upstream in Jobber must not take them with it.
  const ref = sql.match(/add column if not exists request_id text\s+references public\.requests\(jobber_id\) on delete (\w+ ?\w*)/i);
  assert.ok(ref, 'request_id should be a foreign key to requests');
  assert.equal(ref[1].toLowerCase().trim(), 'set null');
});

test('two opportunities cannot point at the same request', () => {
  // The backfill re-runs; without this it would duplicate every card.
  assert.match(sql, /create unique index if not exists lead_pipeline_request_id_key/i);
  // Partial -- hand-entered opportunities all have request_id NULL and would
  // otherwise collide with each other.
  assert.match(sql, /lead_pipeline_request_id_key[\s\S]{0,120}where request_id is not null/i);
});

test('the table is ready for multi-tenant without a later backfill', () => {
  assert.match(sql, /add column if not exists company_id uuid/i);
});

test('no write path still upserts on the dropped constraint', () => {
  // The failure this guards: ON CONFLICT (client_id) against a table with no
  // such constraint is a runtime 42P10 from PostgREST, not a build error.
  assert.doesNotMatch(leadsFn, /on_conflict=client_id/,
    'handleLeads still upserts on client_id, which no longer exists');
  assert.doesNotMatch(leadsFn, /resolution=merge-duplicates/,
    'a second opportunity for a client is a new job, never a duplicate to merge');
});

test('a stage change addresses one opportunity by its own id', () => {
  assert.match(leadsFn, /lead_pipeline\?id=eq\.\$\{encodeURIComponent\(leadId\)\}/);
});

test('a stage change refuses a lead id belonging to another client', () => {
  assert.match(leadsFn, /belongs to a different client/);
});

test('a card with no row yet still works and creates its first row', () => {
  // All but 4 of the 346 Jobber-flagged lead clients have no lead_pipeline row.
  // Dragging one must insert, not 404.
  assert.match(leadsFn, /const leadId = String\(b\.leadId \|\| ''\)\.trim\(\)/);
  assert.match(leadsFn, /leadId\s*\?[\s\S]{0,400}:\s*await supabaseRequest\('lead_pipeline',/);
});

test('the board lists one card per opportunity, not one per client', () => {
  // The old code did clients.map(...) against a client_id-keyed Map, so only the
  // first opportunity per client ever rendered -- the exact bug this change
  // exists to remove. Asserted as "cards come from the opportunity rows" rather
  // than by pinning a particular loop, since step 3 legitimately reshaped it.
  assert.doesNotMatch(leadsFn, /pipeByClient/,
    'grouping by client hides every opportunity after the first');
  assert.match(leadsFn, /const leads = pipeline\.map\(/,
    'cards must be derived from the opportunity rows');
});

test('every card exposes its opportunity id to the browser', () => {
  assert.match(leadsFn, /id: p\.id \|\| null/);
  assert.match(leadsFn, /title: p\.title \|\|/);
});

test('the frontend sends the opportunity id when moving a card', () => {
  assert.match(page, /hlApiPatch\('leads', \{ leadId: lead\.id \|\| null/);
});

test('drag, click and save all resolve a card the same way', () => {
  // Three entry points; if any still resolves by clientId it silently acts on
  // the wrong opportunity once a client has two.
  assert.match(page, /function leadCardKey\(l\) \{ return l\.id \? String\(l\.id\) : 'c:' \+ String\(l\.clientId\); \}/);
  assert.match(page, /LEAD_DRAG_ID = card\.getAttribute\('data-lead-key'\)/);
  assert.match(page, /var lead = findLeadByKey\(dragKey\)/);
  assert.match(page, /function openRealLead\(key\) \{\s*var l = findLeadByKey\(key\);/);
  assert.match(page, /findLeadByKey\(modal\.getAttribute\('data-lead-key'\)\)/);
});

test('openRealLead is reachable from the inline onclick every lead card uses, not trapped in its enclosing IIFE', () => {
  // Found via self-test 2026-08-18: openRealJob got this same fix on
  // 2026-08-15 (window.openRealJob = openRealJob), but openRealLead never
  // did. Every lead card, the Command Center priority-leads widget, and the
  // stale-lead watch list all call this by bare name from an inline
  // onclick="" attribute, which always resolves in global scope -- so every
  // one of them threw "openRealLead is not defined" until this line existed.
  assert.match(page, /function openRealLead\(key\) \{[\s\S]*?\r?\n\}\r?\nwindow\.openRealLead = openRealLead;/);
});

test('a card leads with the job, not the customer name', () => {
  // Three live opportunities for one client otherwise render as three identical
  // cards reading the same person's name.
  // What the title resolves to when a request has no title of its own -- and
  // that the customer name is then not printed twice -- is asserted
  // behaviourally in leads-card-render.test.mjs.
  assert.match(page, /var titleText = l\.title \|\| l\.name/);
  assert.match(page, /'<b>' \+ hlEsc\(titleText\) \+ '<\/b>'/);
  assert.match(page, /lead-who/);
});
