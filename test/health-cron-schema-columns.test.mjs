import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Dev To-Do reported "Health check failed — Database (Supabase): HTTP 400".
// Live-confirmed against production PostgREST: the jobs/clients/visits tables
// (all Jobber-synced) have no `id` column at all -- their schema
// (supabase/migrations/20260802140000_remote_baseline.sql) uses `jobber_id`
// (NOT NULL on every one of these tables) as the stable key, with `uuid_id` as
// an additional surrogate on some (not all -- visits and quotes have no
// uuid_id either). `jobs?select=id` returned
// `{"code":"42703","message":"column jobs.id does not exist"}`, which is what
// tripped the "Database (Supabase)" health check, and silently degraded three
// sibling checks ("Clients", "Jobs", "Today's visits") to an uninformative
// "zero returned" warning instead of their real counts.
const src = readFileSync(new URL('../api/health-cron.js', import.meta.url), 'utf8');

test('the Database reachability check selects a column that actually exists on jobs', () => {
  assert.doesNotMatch(src, /sbGet\('jobs\?select=id[&']/);
  assert.match(src, /sbGet\('jobs\?select=jobber_id&limit=1'\)/);
});

test('the Clients count check selects a column that actually exists on clients', () => {
  assert.doesNotMatch(src, /sbGet\('clients\?select=id'/);
  assert.match(src, /sbGet\('clients\?select=jobber_id', \{ count: true \}\)/);
});

test('the Jobs count check selects a column that actually exists on jobs', () => {
  assert.doesNotMatch(src, /sbGet\('jobs\?select=id', \{ count: true \}\)/);
  assert.match(src, /sbGet\('jobs\?select=jobber_id', \{ count: true \}\)/);
});

test("the Today's visits check selects a column that actually exists on visits", () => {
  assert.doesNotMatch(src, /visits\?select=id&start_at=/);
  assert.match(src, /visits\?select=jobber_id&start_at=/);
});
