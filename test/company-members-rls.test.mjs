import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../sql/082_company_members.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../supabase/migrations/20260816020633_company_members_rls.sql', import.meta.url), 'utf8');

for (const sql of [source, migration]) {
  assert.match(sql, /alter table public\.company_members enable row level security/i);
  assert.match(sql, /create policy company_members_read_self[\s\S]*for select[\s\S]*to authenticated[\s\S]*auth\.uid\(\)[\s\S]*user_id/i);
  assert.doesNotMatch(sql, /company_members_read_self[\s\S]*for all/i);
  assert.doesNotMatch(sql, /company_members_read_self[\s\S]*with check/i);
}

console.log('company_members RLS contract tests passed');
