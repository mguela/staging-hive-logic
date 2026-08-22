import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationName = '20260818150000_repair_lead_pipeline_request_uniqueness_and_clock_index.sql';
const migrationPath = path.join(root, 'supabase', 'migrations', migrationName);
const sql = await readFile(migrationPath, 'utf8');
const executableSql = sql.replace(/--.*$/gmu, '').replace(/\s+/gu, ' ').trim();

test('repair runs after the lead and crew migrations it corrects', () => {
  const version = migrationName.slice(0, 14);
  assert.ok(version > '20260818140000');
});

test('request_id becomes an inferable ordinary UNIQUE conflict target', () => {
  const dropPosition = executableSql.indexOf('drop index if exists public.lead_pipeline_request_id_key');
  const constraintPosition = executableSql.indexOf(
    'add constraint lead_pipeline_request_id_key unique (request_id)',
  );

  assert.ok(dropPosition >= 0, 'the incompatible partial index must be removed');
  assert.ok(constraintPosition > dropPosition, 'the ordinary UNIQUE constraint must replace it');
  assert.doesNotMatch(executableSql, /where\s+request_id\s+is\s+not\s+null/iu);
  assert.doesNotMatch(executableSql, /unique\s+nulls\s+not\s+distinct/iu);
  assert.doesNotMatch(executableSql, /request_id\s+set\s+not\s+null/iu);
});

test('repair is transactional and harmless when the UNIQUE constraint already exists', () => {
  assert.match(executableSql, /^begin;/iu);
  assert.match(executableSql, /if not exists \([\s\S]*?pg_constraint[\s\S]*?contype = 'u'[\s\S]*?\) then/iu);
  assert.match(executableSql, /commit;$/iu);
});

test('only the duplicate crew clock index is dropped', () => {
  assert.match(executableSql, /drop index if exists public\.hl_clock_open_idx;/iu);
  assert.doesNotMatch(executableSql, /drop index(?: if exists)? public\.hl_clock_emp_open_idx/iu);
});
