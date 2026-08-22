// Found during the 2026-08-18 Boardroom production incident review:
// project_id used to be attached via a second PostgREST PATCH issued after
// reina_council_create_run's own transaction had already committed
// (api/_lib/reina/council-store.js createRun()). If that PATCH failed for
// any reason, the client was told the whole request failed (503) while the
// run -- and possibly a freshly-created, now-orphaned boardroom_projects
// row -- already existed in the database. These tests guard the migration
// that closes that gap: project_id now travels inside the same atomic
// transaction as everything else this RPC persists.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../supabase/migrations/20260818020000_boardroom_atomic_project_attach.sql', import.meta.url);

test('the old 12-argument function is explicitly dropped, not just shadowed by an overload', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  // CREATE OR REPLACE alone would NOT retire the old signature once a new
  // parameter is added -- Postgres treats a different argument list as a
  // distinct function, leaving both to coexist as ambiguous overloads. The
  // migration has to DROP the old one explicitly.
  assert.match(sql, /drop function if exists public\.reina_council_create_run\(\s*uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb\s*\);/u);
});

test('the new 13-argument function uses CREATE OR REPLACE, so re-running this migration is safe', async () => {
  // Found live (2026-08-18): applying this migration a second time (e.g. by
  // accidentally re-running it in the SQL editor) failed with "function
  // already exists with same argument types" when the create step was a bare
  // CREATE FUNCTION. A fresh local/CI database bootstrap runs every
  // migration file once in sequence, which is fine either way -- but nothing
  // should make a harmless accidental re-run of an already-applied migration
  // fail loudly and look like a real problem.
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /create or replace function public\.reina_council_create_run\(/u);
});

test('project_id is a real parameter of the atomic transaction, not a follow-up write', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /p_project_id uuid default null/u);
  assert.match(sql, /insert into public\.reina_council_runs \([\s\S]*?project_id[\s\S]*?\) values \([\s\S]*?p_project_id[\s\S]*?\)/u);
  // The insert (and everything downstream of it) must remain inside the same
  // single transaction -- the whole point of this migration is that project
  // attachment can no longer be a separately-failable second write.
  assert.match(sql, /insert into public\.reina_council_runs[\s\S]*?insert into public\.reina_council_messages[\s\S]*?insert into public\.reina_council_audit_events[\s\S]*?update public\.reina_council_admissions/u);
});

test('a project id is checked against the calling owner before it can be attached', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  // Without this, one owner could attach a run to another owner's project by
  // guessing or reusing a stale id -- the RPC runs security definer, so this
  // check has to live in the function itself, not rely on RLS.
  assert.match(sql, /p_project_id is not null and not exists \(\s*select 1 from public\.boardroom_projects where id = p_project_id and owner_id = p_owner_id\s*\)/u);
});

test('every validation the prior migration already enforced is still present unweakened', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /jsonb_array_length\(p_audit_events\) > 512/u);
  assert.match(sql, /event ->> 'eventType' = 'council\.started'\) <> 1/u);
  assert.match(sql, /event ->> 'eventType' = 'moderator\.independent_round_completed'\) <> 1/u);
  assert.match(sql, /event ->> 'eventType' = 'moderator\.debate_round_completed'\) <> v_rounds - 1/u);
  assert.match(sql, /event ->> 'eventType' = 'moderator\.consensus_computed'\) <> 1/u);
  assert.match(sql, /event ->> 'eventType' = 'council\.completed'\) <> 1/u);
  assert.match(sql, /totalCostCents'[\s\S]*?\[\.\]\[0-9\]\+/u);
});

test('the new 13-argument signature remains service-role only', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /grant execute on function public\.reina_council_create_run\(\s*uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, uuid\s*\) to service_role;/u);
  assert.match(sql, /revoke all on function public\.reina_council_create_run\(\s*uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, uuid\s*\) from public, anon, authenticated;/u);
  assert.doesNotMatch(sql, /grant execute on function public\.reina_council_create_run\([\s\S]*?, uuid\s*\) to (?:anon|authenticated);/u);
});
