import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../supabase/migrations/20260816122034_boardroom_variable_audit_persistence.sql', import.meta.url);

test('Boardroom persistence accepts truthful retry events without weakening transcript validation', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.doesNotMatch(sql, /jsonb_array_length\(p_audit_events\)\s*<>\s*3\s*\+\s*\(7\s*\*\s*v_rounds\)/u);
  assert.match(sql, /jsonb_array_length\(p_audit_events\) > 512/u);
  assert.match(sql, /event ->> 'eventType' = 'council\.started'\) <> 1/u);
  assert.match(sql, /event ->> 'eventType' = 'moderator\.independent_round_completed'\) <> 1/u);
  assert.match(sql, /event ->> 'eventType' = 'moderator\.debate_round_completed'\) <> v_rounds - 1/u);
  assert.match(sql, /event ->> 'eventType' = 'moderator\.consensus_computed'\) <> 1/u);
  assert.match(sql, /event ->> 'eventType' = 'council\.completed'\) <> 1/u);
  assert.match(sql, /event ->> 'eventType' = 'provider\.completed'/u);
  assert.match(sql, /group by item ->> 'participant', item ->> 'round'[\s\S]*?having count\(\*\) <> 1/u);
  assert.match(sql, /generate_series\(0, v_rounds - 1\)/u);
  assert.match(sql, /occurredAt'[\s\S]*?\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}T/u);
  assert.doesNotMatch(sql, /occurredAt'[\s\S]*?\\\\d/u);
  assert.match(sql, /totalCostCents'[\s\S]*?\[\.\]\[0-9\]\+/u);
});

test('Boardroom persistence RPC remains atomic and service-role only', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /insert into public\.reina_council_runs[\s\S]*?insert into public\.reina_council_messages[\s\S]*?insert into public\.reina_council_audit_events[\s\S]*?update public\.reina_council_admissions/u);
  assert.match(sql, /grant execute on function public\.reina_council_create_run\([\s\S]*?\) to service_role;/u);
  assert.doesNotMatch(sql, /grant execute on function public\.reina_council_create_run\([\s\S]*?\) to (?:anon|authenticated);/u);
});
