import assert from 'node:assert/strict';
import fs from 'node:fs';

const original = fs.readFileSync(new URL('../supabase/migrations/20260802180611_sub_banking_reauth_consume_txn.sql', import.meta.url), 'utf8');
const repair = fs.readFileSync(new URL('../supabase/migrations/20260816021237_sub_banking_function_acl.sql', import.meta.url), 'utf8');

for (const sql of [original, repair]) {
  assert.match(sql, /revoke (?:all|execute)[\s\S]*consume_sub_reauth_and_apply_banking[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute[\s\S]*consume_sub_reauth_and_apply_banking[\s\S]*to service_role/i);
}

console.log('sub-banking function ACL contract tests passed');
