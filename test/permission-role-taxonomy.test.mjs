// The app's role list and the database's role constraint are two copies of one
// taxonomy, and nothing was checking that they agreed.
//
// WHAT THIS CAUGHT, ON 2026-08-21, IN PRODUCTION
//
// api/track1.js validates writes against the NEW nine roles. The live database
// still carried the OLD eleven, because 20260810220215_permission_roles_v2.sql
// was never applied -- its own header claimed it "captures existing production
// state; does not change the database", and PR #198 was built on that claim.
// Verified directly against project sqhusuuhlmcmkeowdrga: the old check
// constraints were still in place and every role value in every live row was an
// old name. Zero rows held a new one.
//
// The result was a split brain that failed in both directions at once:
//
//   * six of the nine roles the UI offers (office_ar, purchasing, admin_remote,
//     field_lead, field_tech, sales) violated the DB constraint, so they could
//     not be assigned at all -- owner, project_manager and dispatch were the
//     entire usable overlap
//   * permission gates asking for 'office_ar' -- financial data, the sub portal,
//     the client portal -- matched nobody, because those staff still held
//     'accounting'
//
// Neither half raised an error anybody saw. A role assignment just 400'd or
// 23514'd, and a permission check just quietly returned false.
//
// WHY A TEST AND NOT A COMMENT
//
// api/track1.js:1804 already carries a comment describing the other half of this
// ("live rows hold roles like 'field_crew' and 'subcontractor' that are not in
// VALID_PERMISSION_ROLES"). Somebody hit it, understood it, wrote it down, and
// worked around it -- and the underlying mismatch survived anyway, for eleven
// days, because prose does not fail a build.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const migrationsDir = path.join(root, 'supabase/migrations');

/** Roles api/track1.js will accept on a write to employee_roles. */
function appRoles() {
  const src = fs.readFileSync(path.join(root, 'api/track1.js'), 'utf8');
  const m = src.match(/const VALID_PERMISSION_ROLES = \[([^\]]*)\]/);
  assert.ok(m, 'VALID_PERMISSION_ROLES must exist in api/track1.js -- if it was '
    + 'renamed, this guard is pointing at nothing and must be repointed');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

/**
 * Roles the migration tree's most recent employee_roles constraint permits.
 * Latest version wins, the same way the database resolves it: each migration
 * drops the previous constraint and adds its own.
 */
function migrationRoles() {
  const defining = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => /employee_roles_permission_roles_check/.test(
      fs.readFileSync(path.join(migrationsDir, f), 'utf8')))
    .sort();
  assert.ok(defining.length > 0,
    'no migration defines employee_roles_permission_roles_check -- the constraint '
    + 'this guard compares against has vanished from the tree');

  const newest = defining[defining.length - 1];
  const sql = fs.readFileSync(path.join(migrationsDir, newest), 'utf8');
  // The final `permission_roles <@ array[...]` in the newest file that names it.
  const all = [...sql.matchAll(/permission_roles"?\s*<@\s*ARRAY\s*\[([^\]]*)\]/gi)];
  assert.ok(all.length > 0, `${newest} names the constraint but has no <@ array to read`);
  const roles = all[all.length - 1][1]
    .split(',')
    .map((s) => s.trim().replace(/::"?text"?/g, '').replace(/^'|'$/g, '').replace(/^"|"$/g, ''))
    .filter(Boolean);
  return { newest, roles };
}

test('every role the app can write is one the database will accept', () => {
  // The invariant. A role in the app but not the constraint is a write that
  // fails with a 23514 the user sees as "nothing happened".
  const app = appRoles();
  const { newest, roles: db } = migrationRoles();
  const unwritable = app.filter((r) => !db.includes(r));
  assert.deepEqual(unwritable, [],
    `api/track1.js offers role(s) the database will reject: ${unwritable.join(', ')}.\n`
    + `Newest constraint is in ${newest}, permitting: ${db.join(', ')}.\n`
    + 'Either the migration that widens the constraint is missing from the tree, '
    + 'or the app gained a role nobody added to the database.');
});

test('the taxonomies match exactly, in both directions', () => {
  // The reverse direction is weaker but still worth pinning: a role the database
  // permits that the app will never write is dead vocabulary, and dead
  // vocabulary is how the old eleven lingered in live rows long after the app
  // stopped believing in them.
  const app = [...appRoles()].sort();
  const { newest, roles } = migrationRoles();
  const db = [...roles].sort();
  assert.deepEqual(db, app,
    `the app and ${newest} describe different taxonomies.\n`
    + `app only: ${app.filter((r) => !db.includes(r)).join(', ') || '(none)'}\n`
    + `db only:  ${db.filter((r) => !app.includes(r)).join(', ') || '(none)'}`);
});

test('the roles that gate real data are ones the app can actually assign', () => {
  // A gate naming a role nothing can hold denies everyone except the
  // admin/superadmin bypass, silently. That is how 'office_ar' behaved in
  // production for eleven days: financial data, the sub portal and the client
  // portal all asked for a role no row could carry.
  const app = new Set(appRoles());
  const gated = [
    ['api/track1.js', /const FINANCIAL_ALLOWED_ROLES = \[([^\]]*)\]/],
    ['api/subportal.js', /const SUB_PORTAL_STAFF_ROLES = \[([^\]]*)\]/],
    ['api/clientportal.js', /const CLIENT_PORTAL_STAFF_ROLES = \[([^\]]*)\]/],
  ];
  for (const [file, re] of gated) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    const m = src.match(re);
    assert.ok(m, `${file}: the gated-role list this guard checks has been renamed or removed`);
    const roles = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    assert.ok(roles.length > 0, `${file}: gate list is empty, which would deny everyone`);
    for (const r of roles) {
      assert.ok(app.has(r),
        `${file} gates on '${r}', which is not in VALID_PERMISSION_ROLES -- `
        + 'no employee can be given it, so the gate matches nobody');
    }
  }
});

test('the destructive remap is marked so the deploy workflow cannot run it', () => {
  // permission_roles_v2 is a one-way remap: its CASE only knows the old names,
  // so a second run maps the new names it produced to null. It has to be applied
  // once, by hand. The marker is what stops supabase-migrations.yml applying it
  // automatically -- see scripts/check-migration-replay-safety.mjs.
  const f = path.join(migrationsDir, '20260810220215_permission_roles_v2.sql');
  assert.ok(fs.existsSync(f), 'the migration that reconciles the taxonomy must be in the tree');
  const sql = fs.readFileSync(f, 'utf8');
  assert.match(sql, /^--\s*hl:replay-unsafe:\s*\S.{20,}/m,
    'it must carry an hl:replay-unsafe marker with a real stated reason');
  assert.doesNotMatch(sql, /captures existing production state; does not change the database/,
    'that claim was false -- production was verified on 2026-08-21 as still '
    + 'carrying the OLD taxonomy, and PR #198 was built on the false version');
});
