import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../supabase/migrations/20260805221000_reina_boardroom_actual_cost_ledger.sql', import.meta.url);

test('completed Boardroom admissions are reconciled to measured provider cost', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /update public\.reina_council_admissions as admission[\s\S]*?admission\.state = 'completed'/u);
  assert.match(sql, /run\.usage ->> 'totalCostCents'/u);
  assert.match(sql, /v_actual_cost_cents := greatest\([\s\S]*?v_admission\.reserved_cost_cents/u);
  assert.match(sql, /reserved_cost_cents = v_actual_cost_cents/u);
  assert.match(sql, /jsonb_typeof\(p_usage\) <> 'object'/u);
  assert.match(sql, /grant execute on function public\.reina_council_create_run\([\s\S]*?\) to service_role;/u);
  assert.doesNotMatch(sql, /grant execute on function public\.reina_council_create_run\([\s\S]*?\) to (?:anon|authenticated);/u);
});
