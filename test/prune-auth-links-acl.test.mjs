import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260802210313_prune_consumed_expired_auth_links.sql', import.meta.url),
  'utf8',
);

for (const role of ['public', 'anon', 'authenticated']) {
  assert.match(
    migration,
    new RegExp(`revoke all on function public\\.prune_portal_auth_links\\(interval\\) from ${role}`, 'i'),
  );
}
assert.match(
  migration,
  /grant execute on function public\.prune_portal_auth_links\(interval\) to service_role/i,
);

console.log('Portal auth-link prune ACL tests passed');
