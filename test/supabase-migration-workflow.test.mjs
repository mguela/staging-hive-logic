import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(
  new URL('../.github/workflows/supabase-migrations.yml', import.meta.url),
  'utf8',
);

assert.match(workflow, /Missing production GitHub secret\(s\)/);
assert.match(workflow, /SUPABASE_ACCESS_TOKEN/);
assert.match(workflow, /SUPABASE_PROJECT_REF/);
assert.match(workflow, /supabase migration list --linked/);
assert.match(workflow, /git diff --name-only --diff-filter=A/);
assert.match(workflow, /supabase db query --linked --file "\$migration_file"/);
assert.match(workflow, /supabase migration repair --status applied --linked "\$version"/);
assert.match(workflow, /Migration \$version is already recorded as applied; skipping/);
assert.match(workflow, /Unsafe migration path/);
assert.match(workflow, /Migration version \$version is missing or duplicated/);
assert.doesNotMatch(workflow, /supabase db push --linked --include-all/);

console.log('Supabase migration workflow tests passed');
