import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationPath = path.join(root, 'supabase', 'migrations', '20260818000148_crew_clock_atomic_writes.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');
const hardeningSql = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260818001232_crew_clock_concurrency_and_visit_scope.sql'),
  'utf8',
);

test('crew clock replacement is one database function transaction', () => {
  assert.match(sql, /create or replace function public\.hl_clock_crew_in\(p_rows jsonb\)/i);
  const body = sql.match(/create or replace function public\.hl_clock_crew_in[\s\S]*?\$\$;/i)?.[0] || '';
  assert.match(body, /update public\.hl_clock[\s\S]*clock_out = v_clock_at/i);
  assert.match(body, /return query[\s\S]*insert into public\.hl_clock/i);
  assert.ok(body.indexOf('update public.hl_clock') < body.indexOf('insert into public.hl_clock'));
});

test('field start commits the activity row and optional crew rows together', () => {
  const body = sql.match(/create or replace function public\.hl_field_time_start[\s\S]*?\$\$;/i)?.[0] || '';
  assert.match(body, /update public\.job_time_entries/i);
  assert.match(body, /insert into public\.job_time_entries/i);
  assert.match(body, /from public\.hl_clock_crew_in\(p_crew_rows\)/i);
});

test('field stop commits personal and crew closes together', () => {
  const body = sql.match(/create or replace function public\.hl_field_time_stop[\s\S]*?\$\$;/i)?.[0] || '';
  assert.match(body, /update public\.job_time_entries/i);
  assert.match(body, /update public\.hl_clock/i);
  assert.match(body, /jsonb_build_object\('closed', v_closed, 'crew_changed', v_crew_changed\)/i);
});

test('all atomic clock functions are service-role-only and invoker security', () => {
  for (const signature of [
    'hl_clock_crew_in\\(jsonb\\)',
    'hl_field_time_start\\(jsonb, jsonb\\)',
    'hl_field_time_stop\\(uuid, jsonb\\)',
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${signature} from public, anon, authenticated`, 'i'));
    assert.match(sql, new RegExp(`grant execute on function public\\.${signature} to service_role`, 'i'));
  }
  assert.doesNotMatch(sql, /security\s+definer/i);
  assert.match(sql, /^begin;/im);
  assert.match(sql, /^commit;/im);
});

test('forward hardening serializes double taps and enforces one open row', () => {
  assert.match(hardeningSql, /pg_advisory_xact_lock/i);
  assert.match(hardeningSql, /create unique index hl_clock_emp_open_idx[\s\S]*where clock_out is null/i);
  assert.match(hardeningSql, /create unique index if not exists job_time_entries_one_open_per_tech_idx[\s\S]*where ended_at is null/i);
  assert.match(hardeningSql, /duplicate open employees exist/i);
  assert.match(hardeningSql, /duplicate open techs exist/i);
});

test('whole-team stop is visit-scoped and the obsolete broad signature is removed', () => {
  assert.match(hardeningSql, /drop function public\.hl_field_time_stop\(uuid, jsonb\)/i);
  assert.match(hardeningSql, /create function public\.hl_field_time_stop\([\s\S]*p_target_id text/i);
  assert.match(hardeningSql, /clock_row\.target_kind = 'jobber_visit'/i);
  assert.match(hardeningSql, /clock_row\.target_id = p_target_id/i);
  assert.match(hardeningSql, /grant execute on function public\.hl_field_time_stop\(uuid, jsonb, text\) to service_role/i);
  assert.doesNotMatch(hardeningSql, /grant execute on function public\.hl_field_time_stop\(uuid, jsonb\) to service_role/i);
});
