-- sql/064_marketing_attachments_bucket_rls.sql
--
-- Closes "marketing-attachments bucket has no RLS" (created 2026-08-01,
-- policy pending). This is the Supabase STORAGE bucket (hyphenated), a
-- separate thing from the `marketing_attachments` Postgres TABLE
-- (underscored, sql/039) -- that table already has its own real
-- service-role-only RLS policy from day one. The bucket itself was only
-- ever created manually in the dashboard (per api/marketing.js's own
-- header comment on uploadDataUrl()) with no matching storage.objects
-- policy ever written down anywhere, which is what this file fixes.
--
-- Impact review (safe): every real read/write to this bucket already goes
-- through uploadDataUrl() in api/marketing.js using the service-role key
-- (server-side only) -- confirmed by a full search of the frontend, which
-- has zero direct Supabase Storage calls against this bucket (only the
-- upload POST is wired into the UI so far; a "view attachment" feature
-- doesn't exist yet). So this policy makes the existing, already-true
-- access pattern explicit and auditable -- it does not change what
-- currently works, since service_role already bypasses RLS and nothing
-- else has ever successfully touched this bucket.
--
-- Same repo-wide gap exists for every other Storage bucket (sub-documents,
-- sub-invoices, docs, etc.) -- none have an explicit storage.objects
-- policy either, relying only on Supabase's private-bucket default-deny.
-- Scoped to just marketing-attachments here since that's the one flagged;
-- worth a follow-up pass across the other buckets if that broader pattern
-- is a real concern.

create policy "service role full access marketing-attachments"
  on storage.objects for all
  using (bucket_id = 'marketing-attachments' and auth.role() = 'service_role')
  with check (bucket_id = 'marketing-attachments' and auth.role() = 'service_role');
