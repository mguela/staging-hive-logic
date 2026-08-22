import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260817221820_documents_storage_rls.sql'),
  'utf8',
);
const repairMigration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260817222303_documents_storage_private_cleanup_helper.sql'),
  'utf8',
);
const baseline = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260802140000_remote_baseline.sql'),
  'utf8',
);

test('Documents metadata has row-level gates and a search index in the baseline', () => {
  assert.match(baseline, /ALTER TABLE "public"\."documents" ENABLE ROW LEVEL SECURITY/i);
  assert.match(baseline, /documents: authenticated can insert/i);
  assert.match(baseline, /documents: read gated by sensitivity and folder/i);
  assert.match(baseline, /CREATE INDEX "documents_search_idx"[\s\S]*to_tsvector/i);
});

test('the immutable base migration matches the applied public-helper history', () => {
  assert.match(migration, /values \('docs', 'docs', false\)/i);
  assert.match(migration, /for insert[\s\S]*to authenticated[\s\S]*bucket_id = 'docs'/i);
  assert.match(migration, /for select[\s\S]*public\.documents[\s\S]*d\.storage_path = storage\.objects\.name/i);
  assert.match(migration, /function public\.can_cleanup_unfiled_document_object[\s\S]*security definer[\s\S]*set search_path = pg_catalog, public[\s\S]*not exists[\s\S]*public\.documents/i);
  assert.match(migration, /for delete[\s\S]*owner_id = auth\.uid\(\)::text[\s\S]*public\.can_cleanup_unfiled_document_object/i);
  assert.doesNotMatch(migration, /function private\.can_cleanup_unfiled_document_object/i);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to anon/i);
});

test('the repair migration removes the exposed helper without weakening cleanup RLS', () => {
  assert.match(repairMigration, /create schema if not exists private/i);
  assert.match(repairMigration, /grant usage on schema private to authenticated, service_role/i);
  assert.match(repairMigration, /function private\.can_cleanup_unfiled_document_object[\s\S]*security definer[\s\S]*set search_path = ''/i);
  assert.match(repairMigration, /drop policy if exists "hivelogic docs owner cleanup"[\s\S]*create policy "hivelogic docs owner cleanup"/i);
  assert.match(repairMigration, /owner_id = auth\.uid\(\)::text[\s\S]*private\.can_cleanup_unfiled_document_object/i);
  assert.match(repairMigration, /drop function if exists public\.can_cleanup_unfiled_document_object\(text\)/i);
  assert.doesNotMatch(repairMigration, /grant execute[\s\S]*to anon/i);
});
