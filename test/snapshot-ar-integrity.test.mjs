import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const legacyFix = fs.readFileSync(path.join(root, 'sql', '046_snapshot_ar_client_level.sql'), 'utf8');
const baseline = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260802140000_remote_baseline.sql'), 'utf8');
const integrityMigration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260817221814_ar_balance_discount_aware.sql'), 'utf8');

function snapshotOutstandingExpression(sql) {
  const match = sql.match(/'outstanding'\s*,\s*\(\s*select[\s\S]*?\),\s*'overdueCount'/i);
  assert.ok(match, 'snapshot AR outstanding expression must be present');
  return match[0];
}

test('the historical fix and production baseline source headline AR from client balances', () => {
  for (const [name, sql] of [['legacy fix', legacyFix], ['production baseline', baseline]]) {
    const expr = snapshotOutstandingExpression(sql);
    assert.match(expr, /public\.client_ar_outstanding/i, `${name} must use client-level Jobber balances`);
    assert.doesNotMatch(expr, /sum\s*\(\s*bal\s*\)/i, `${name} must not regress headline AR to an invoice sum`);
  }
});

test('the forward migration keeps headline AR client-level and makes invoice buckets deposit/discount aware', () => {
  const expr = snapshotOutstandingExpression(integrityMigration);
  assert.match(expr, /public\.client_ar_outstanding/i);
  assert.match(integrityMigration, /coalesce\(payments, 0\)[\s\S]*coalesce\(deposit, 0\)[\s\S]*coalesce\(discount, 0\)/i);
  assert.match(integrityMigration, /create or replace view public\.invoice_balances/i);
  assert.match(integrityMigration, /revoke all on public\.invoice_balances from anon, authenticated/i);
  assert.match(integrityMigration, /revoke execute on function public\.snapshot_aggregates\(\) from public, anon, authenticated/i);
});
