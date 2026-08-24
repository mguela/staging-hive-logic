import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Two holes found auditing production on 2026-08-23.
//
// The migration was run against a real PostgreSQL 18.4 cluster before shipping,
// with production's policies and functions recreated verbatim and the five
// tables in the state production had them (granted to anon, RLS off). Measured,
// not reasoned about:
//
//                                    BEFORE          AFTER
//   anon reads ops_events            1 row           0 rows
//   anon reads employee_roles_backup 1 row           0 rows
//   anon reads client_flags          1 row           0 rows
//   crew       sees documents        1 of 2          1 of 2   <- unchanged
//   admin      sees documents        2 of 2          2 of 2   <- unchanged
//   SUPERADMIN sees documents        1 of 2          2 of 2
//   SUPERADMIN sees the COI          0               1
//   service_role reads everything    unchanged       unchanged
//
// The crew and admin rows are the ones that matter most: widening is_admin() to
// include superadmin must not hand anything to anybody else, and it does not.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260823131948_rls_holes_and_superadmin.sql'),
  'utf8',
);

const EXPOSED_TABLES = [
  'ops_events',
  'ops_event_mutes',
  'ops_detector_runs',
  'client_flags',
  'employee_roles_backup_20260821',
];

test('every table that was publicly readable gets RLS switched on', () => {
  for (const t of EXPOSED_TABLES) {
    assert.match(
      migration,
      new RegExp(`alter table public\\.${t}\\s+enable row level security`, 'i'),
      `${t} is still open`,
    );
  }
});

test('no policy is added alongside, because the service key is the only reader', () => {
  // "RLS on, no policy" denies anon and authenticated outright. A policy here
  // would invent an access path nobody asked for -- these tables are read only
  // by api/ through the service key, which bypasses RLS.
  assert.doesNotMatch(migration, /create policy/i);
});

test('is_admin() accepts superadmin as well as admin', () => {
  assert.match(migration, /create or replace function public\.is_admin\(\)/i);
  assert.match(migration, /role in \('admin',\s*'superadmin'\)/i);
  // The old body tested equality against one value; that is the bug.
  assert.doesNotMatch(migration, /and role = 'admin'/i);
});

test('is_admin() keeps its hardening', () => {
  // SECURITY DEFINER with a pinned search_path, and never executable by anon.
  assert.match(migration, /security definer/i);
  assert.match(migration, /set search_path to 'pg_catalog',\s*'public'/i);
  assert.match(migration, /revoke execute on function public\.is_admin\(\) from public, anon/i);
  assert.doesNotMatch(migration, /grant execute on function public\.is_admin\(\)[^;]*anon/i);
});

test('the migration does not delete anything', () => {
  // The employee_roles backup looks droppable, but deciding that is not this
  // migration's job -- it closes a hole, it does not clean up.
  assert.doesNotMatch(migration, /\bdrop table\b|\bdelete from\b|\btruncate\b/i);
});

test('the database and the application agree on who is an admin', () => {
  // This is the guard, more than the constant. is_admin() gates the documents
  // SELECT policy for the browser's direct reads; SENSITIVE_ROLES gates the
  // same decision in canSee() for /api/hivedoc, which runs on the service key
  // and so never sees the policy. When the two disagreed, one subcontractor COI
  // was hidden from Chris in the Documents list and visible to him in search --
  // same file, same person, same moment.
  const search = fs.readFileSync(path.join(root, 'api', '_lib', 'hivedoc-search.js'), 'utf8');
  const m = /const SENSITIVE_ROLES = \[([^\]]+)\]/.exec(search);
  assert.ok(m, 'could not read SENSITIVE_ROLES out of hivedoc-search.js');
  const appRoles = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();

  const sqlRoles = /role in \(([^)]+)\)/i.exec(migration)[1]
    .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort();

  assert.deepEqual(sqlRoles, appRoles,
    'is_admin() and SENSITIVE_ROLES must name the same roles, or the same file is visible one way and hidden the other');
});
