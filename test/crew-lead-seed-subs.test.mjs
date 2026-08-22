// The crew-lead seed must not make subcontractors leads.
//
// 20260817120000_crew_chaining.sql seeded is_lead from the crew_label convention
// across lens in ('crew','sub'). Against real prod data that left 27 of 46
// multi-person jobs with two flagged leads — because the most common real crew is
// one subcontractor company plus one employee — so lead election fell through to
// the old positional heuristic and the flag set in user setup decided nothing.
//
// These assertions pin the correction, and pin that it is a FOLLOW-UP migration:
// the original is already applied on prod, so it must not be edited in place.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrations = path.join(root, 'supabase', 'migrations');
const CORRECTION = '20260818170000_crew_lead_seed_excludes_subs.sql';
const ORIGINAL = '20260817120000_crew_chaining.sql';

const read = (f) => fs.readFileSync(path.join(migrations, f), 'utf8');
// Comments in these files explain what is deliberately NOT touched, so a check for
// "this migration does not mention X" has to read the statements, not the prose.
const statements = (f) => read(f).replace(/^\s*--.*$/gm, '');

test('the correction clears is_lead for subcontractors', () => {
  const sql = read(CORRECTION);
  assert.match(sql, /update\s+public\.employee_roles/i);
  assert.match(sql, /set\s+is_lead\s*=\s*false/i);
  assert.match(sql, /where\s+lens\s*=\s*'sub'/i);
});

test('it only touches subs — crew leads are left alone', () => {
  const sql = read(CORRECTION);
  const stmt = sql.slice(sql.search(/update\s+public\.employee_roles/i));
  assert.ok(!/lens\s+in\s*\(/i.test(stmt), 'must not widen back to the crew+sub set');
  assert.ok(!/set\s+is_lead\s*=\s*true/i.test(stmt), 'this migration never flags anyone as a lead');
});

test('it runs after the migration that created the flag', () => {
  assert.ok(CORRECTION > ORIGINAL, 'a correction that sorts before the seed would be undone by it');
  assert.ok(fs.existsSync(path.join(migrations, ORIGINAL)), 'the original seed migration must still exist');
});

test('the original seed migration is left untouched, since prod already applied it', () => {
  const sql = read(ORIGINAL);
  assert.match(sql, /where lens in \('crew', 'sub'\)/i,
    'editing an applied migration in place would silently diverge prod from the repo');
});

test('a fresh install ends with no subcontractor flagged as a lead', () => {
  // Applied in filename order, the seed flags subs and this migration clears them.
  const seeded = /update public\.employee_roles\s+set is_lead = true/i.test(read(ORIGINAL));
  const cleared = /set\s+is_lead\s*=\s*false[\s\S]*where\s+lens\s*=\s*'sub'/i.test(read(CORRECTION));
  assert.ok(seeded && cleared, 'the pair must compose to: crew leads seeded, subs not');
});

test('per-job lead election is not disturbed', () => {
  const sql = statements(CORRECTION);
  assert.ok(!/hl_crew_overrides/i.test(sql),
    'dispatch can still hand a specific job to a sub; only the person-level default changes');
  assert.ok(!/hl_clock/i.test(sql), 'and no time record is rewritten by a seed correction');
});
