import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile('supabase/migrations/20260816112154_boardroom_workspace_consolidation.sql', 'utf8');

test('Boardroom consolidation preserves old Workroom data and adds governed organization', () => {
  assert.match(migration, /create table if not exists public\.boardroom_projects/);
  assert.match(migration, /alter table public\.reina_council_runs[\s\S]*project_id[\s\S]*pinned[\s\S]*updated_at/);
  assert.match(migration, /from public\.ai_workroom_projects/);
  assert.doesNotMatch(migration, /drop table|truncate|delete from/i);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.boardroom_projects from anon, authenticated/);
  assert.match(migration, /grant all on table public\.boardroom_projects to service_role/);
});
