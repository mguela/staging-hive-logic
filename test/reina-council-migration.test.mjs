import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../supabase/migrations/20260804210000_reina_ai_council_phase1.sql', import.meta.url);

test('Council migration exposes service-only transactional persistence and approval RPCs', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const rpc of ['admit', 'release_admission', 'create_run', 'get_run', 'approve_and_queue']) {
    assert.match(sql, new RegExp(`create or replace function public\\.reina_council_${rpc}\\(`, 'u'));
    assert.match(sql, new RegExp(`grant execute on function public\\.reina_council_${rpc}\\([\\s\\S]*?\\) to service_role;`, 'u'));
    assert.doesNotMatch(sql, new RegExp(`grant execute on function public\\.reina_council_${rpc}\\([\\s\\S]*?\\) to (?:anon|authenticated);`, 'u'));
  }
  assert.match(sql, /jsonb_array_length\(p_messages\) <> 3 \* v_rounds/u);
  assert.match(sql, /pg_advisory_xact_lock/u);
  assert.match(sql, /unique \(owner_id, idempotency_key\)/u);
  assert.match(sql, /v_admission\.state <> 'admitted'/u);
  assert.match(sql, /'messages', coalesce/u);
  assert.match(sql, /'audit', coalesce/u);
  assert.match(sql, /from public\.reina_council_runs[\s\S]*?for update;/u);
  assert.match(sql, /id = p_agent_id and tenant_id = p_tenant_id and revoked_at is null[\s\S]*?for update;/u);
  assert.match(sql, /insert into public\.automation_task_approvals/u);
  assert.match(sql, /insert into public\.reina_council_audit_events/u);
});
