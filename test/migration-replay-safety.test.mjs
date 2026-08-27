// Tests for scripts/check-migration-replay-safety.mjs -- the gate that stands
// between .github/workflows/supabase-migrations.yml and production rows.
//
// The bug this guards against is not hypothetical. PR #198 carried
// 20260810220215_permission_roles_v2.sql, which remaps an old role taxonomy
// with three unguarded UPDATEs whose CASE only knows the OLD role names.
// Production is already on the new names, so replaying it maps six of the nine
// roles to null and strips those employees' permissions. The deploy workflow
// would have run exactly that file, and the only thing stopping it was prose in
// a PR description that nobody read for four days.
//
// Two ways a guard like this fails, so both are tested:
//   1. It misses the dangerous thing -- so the real permission_roles_v2 SQL is
//      checked in as a fixture and must be refused.
//   2. It flags everything, gets in the way, and is deleted within a week. The
//      false-positive tests matter as much as the true-positive one: an UPDATE
//      inside a function body is a definition, not an execution, and 11 of this
//      repo's migrations would be wrongly refused if that were not handled.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classify, destructiveStatements, stripNonExecutable,
} from '../scripts/check-migration-replay-safety.mjs';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

// The real thing, reduced to its executable statements. Kept verbatim rather
// than paraphrased: a paraphrase would test the paraphrase.
const PERMISSION_ROLES_V2 = `
-- Reconciled into the canonical migration history from sql/066_permission_roles_v2.sql
update public.employee_roles
set permission_roles = (
  select array_agg(distinct mapped) filter (where mapped is not null)
  from unnest(permission_roles) as old_role
  cross join lateral (
    select case old_role
      when 'owner' then 'owner'
      when 'accounting' then 'office_ar'
      when 'field_crew' then 'field_tech'
      else null
    end as mapped
  ) m
)
where permission_roles is not null and array_length(permission_roles, 1) > 0;

update public.employee_roles
set permission_role = null
where permission_roles is null or array_length(permission_roles, 1) = 0;

alter table public.employee_roles drop constraint if exists employee_roles_permission_role_check;
`;

test('the migration that would have wiped six permission roles is refused', () => {
  const { verdict, kinds } = classify(PERMISSION_ROLES_V2);
  assert.equal(verdict, 'refused');
  assert.deepEqual(kinds, ['UPDATE']);
});

test('an additive migration is allowed through untouched', () => {
  const sql = `
    create table if not exists public.pto_requests (
      id uuid primary key default gen_random_uuid(),
      note text
    );
    alter table public.vehicles add column if not exists fleetsharp_speed numeric;
    insert into public.cost_benchmarks (trade) values ('design_build');
  `;
  const { verdict, kinds } = classify(sql);
  assert.equal(verdict, 'safe');
  assert.deepEqual(kinds, [], 'create/alter/insert must not be treated as destructive');
});

// This is the test that decides whether the guard is usable at all.
test('an UPDATE inside a function body is a definition, not an execution', () => {
  const sql = `
    create or replace function public.touch_row() returns trigger as $$
    begin
      update public.widgets set updated_at = now() where id = new.id;
      delete from public.stale_widgets where id = new.id;
      return new;
    end;
    $$ language plpgsql;
  `;
  assert.deepEqual(destructiveStatements(sql), [],
    'a function body only runs when something calls it, not when the migration is applied');
  assert.equal(classify(sql).verdict, 'safe');
});

test('a tagged dollar-quote body is stripped too', () => {
  const sql = `
    do $migrate$
    begin
      update public.widgets set flag = true;
    end;
    $migrate$;
  `;
  assert.doesNotMatch(stripNonExecutable(sql), /widgets/,
    'the $tag$ form must be stripped the same as $$');
});

test('a table named inside a string literal is not mistaken for a statement', () => {
  const sql = `insert into public.audit_log (note) values ('update public.employee_roles set x = 1');`;
  assert.deepEqual(destructiveStatements(sql), []);
});

test('each destructive statement kind is detected at top level', () => {
  const cases = {
    UPDATE: 'update public.t set a = 1;',
    DELETE: 'delete from public.t where a = 1;',
    TRUNCATE: 'truncate public.t;',
    'DROP TABLE': 'drop table public.t;',
    'DROP COLUMN': 'alter table public.t drop column a;',
  };
  for (const [kind, sql] of Object.entries(cases)) {
    assert.deepEqual(destructiveStatements(sql), [kind], `${kind} must be detected`);
    assert.equal(classify(sql).verdict, 'refused', `${kind} must be refused unmarked`);
  }
});

test('a destructive migration may opt back in with a stated reason', () => {
  const sql = `
    -- hl:replay-safe: guarded by "where source is null", so a second run matches no rows
    update public.sync_log set source = 'sync' where source is null;
  `;
  const { verdict, reason } = classify(sql);
  assert.equal(verdict, 'safe');
  assert.match(reason, /where source is null/);
});

test('the marker cannot be satisfied by a token reason', () => {
  const sql = `
    -- hl:replay-safe: ok
    update public.sync_log set source = 'sync';
  `;
  const { verdict, reason } = classify(sql);
  assert.equal(verdict, 'refused');
  assert.match(reason, /too short/);
});

test('an explicit hl:replay-unsafe declaration is refused even with no DML', () => {
  // Recording a file as never-auto-appliable must not depend on the scanner
  // agreeing that it looks dangerous.
  const sql = `
    -- hl:replay-unsafe: captures state applied by hand on 2026-08-10
    alter table public.t add column if not exists c text;
  `;
  const { verdict, reason } = classify(sql);
  assert.equal(verdict, 'refused');
  assert.match(reason, /applied by hand/);
});

test('hl:replay-unsafe wins over an hl:replay-safe marker in the same file', () => {
  const sql = `
    -- hl:replay-safe: this claim should not be able to override the refusal
    -- hl:replay-unsafe: one-way data remap, repair the ledger instead
    update public.t set a = 1;
  `;
  assert.equal(classify(sql).verdict, 'refused');
});

// --- wiring -----------------------------------------------------------------
//
// The checks above prove the script decides correctly. They say nothing about
// whether anything CALLS it -- and a gate that is not wired in is decoration.

test('the deploy workflow runs the check before it touches production', () => {
  const wf = fs.readFileSync(
    path.join(root, '.github/workflows/supabase-migrations.yml'), 'utf8');
  const check = wf.indexOf('check-migration-replay-safety.mjs');
  const apply = wf.indexOf('supabase db query --linked --file');
  assert.notEqual(check, -1, 'the workflow must invoke the replay-safety check');
  assert.notEqual(apply, -1, 'the workflow must still be the thing that applies migrations');
  assert.ok(check < apply,
    'the check has to run BEFORE db query, or it is reporting on damage already done');
  assert.match(wf, /set -euo pipefail/,
    'the step must abort on the checker exit code rather than continuing');
});

test('the checker survives every migration currently in the tree', () => {
  const dir = path.join(root, 'supabase/migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length > 50, `expected the real migration tree, found ${files.length} files`);
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotThrow(() => classify(sql), `classify() threw on ${f}`);
  }
});

// Existing migrations are all recorded as applied in production, so the deploy
// workflow skips them and this gate never sees them. That is why adding it does
// not require re-litigating history. But the count is worth pinning: if a later
// change to the scanner suddenly flags far more of them, that is a regression in
// the scanner, not a discovery about the migrations.
test('the scanner flags only genuinely executing DML across the real tree', () => {
  const dir = path.join(root, 'supabase/migrations');
  const flagged = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => destructiveStatements(fs.readFileSync(path.join(dir, f), 'utf8')).length > 0);
  // 13 execute DML at apply time (the 12 from before, plus
  // 20260826180000_native_jobs_created_at_backfill.sql's top-level UPDATE);
  // a further 11 only mention it inside function bodies and must not be
  // counted.
  assert.ok(flagged.length <= 17,
    `scanner flagged ${flagged.length} existing migrations, expected ~13 -- `
    + `it is probably counting function bodies again: ${flagged.join(', ')}`);
});
