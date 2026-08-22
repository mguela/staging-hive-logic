import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const legacy = fs.readFileSync(path.join(root, 'sql', '052_marketing_maintenance_reminders_type.sql'), 'utf8');
const canonical = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260815205210_marketing_maintenance_reminders_type.sql'), 'utf8');
const ledger = fs.readFileSync(path.join(root, 'sql', 'MIGRATION_LEDGER.md'), 'utf8');

test('legacy sql/052 and its canonical migration are byte-equivalent', () => {
  assert.equal(canonical, legacy);
});

test('the final 052 constraint contains the complete lifecycle type set', () => {
  for (const type of [
    'estimate_recovery', 'review_request', 'reactivation', 'referral', 'seasonal', 'custom',
    'post_job_thank_you', 'service_anniversary', 'new_lead_followup',
    'dormant_reactivation', 'newsletter', 'maintenance_reminders',
  ]) {
    assert.match(canonical, new RegExp(`'${type}'`));
  }
});

test('the ledger no longer instructs operators to replay lifecycle 047-052', () => {
  assert.match(ledger, /052.*confirmed live 2026-08-15/is);
  assert.match(ledger, /Do not replay lifecycle `047`–`052`/i);
  const pendingSection = ledger.split('**Not yet applied (pending):**')[1].split('The lifecycle type chain')[0];
  assert.doesNotMatch(pendingSection, /052_marketing_maintenance_reminders_type/);
});
