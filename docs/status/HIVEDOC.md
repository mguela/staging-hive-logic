# HiveDoc status

**Evidence date:** 2026-08-17
**Owner:** No HiveDoc owner is recorded in the repository.

## Repository state

- The real metadata model exists in the production baseline: `documents`,
  `folders`, and `folder_access` have row-level policies; document metadata has
  folder/type/date indexes and a filename/client/job full-text index.
- `api/documents.js` is an authenticated AI-classification endpoint. This pass
  added strict filename/MIME/base64 validation and a 3 MiB decoded sample cap so
  a signed-in caller cannot send an unbounded model payload.
- Leaked-password protection is enabled and security-advisor verified for the
  HiveDoc Auth project.
- The browser classification call now obtains the verified session, attaches
  its bearer token, and uses the same 3 MiB cutoff as the API.
- The Documents view performs real Storage + metadata operations. It uploads to
  the private `docs` bucket, inserts `documents` metadata, signs stored files,
  and removes an orphaned object if metadata insertion fails.
- `supabase/migrations/20260817221820_documents_storage_rls.sql` now versions the
  private bucket and the browser flow's upload/read/cleanup policies. It was
  applied and structurally verified in production on 2026-08-17: the bucket is
  private, the policies are present, and the live sample had one object linked
  to one document with zero orphan objects.
- The initial production migration placed its SECURITY DEFINER cleanup helper
  in the API-exposed `public` schema, which triggered an advisor finding.
  `20260817222303_documents_storage_private_cleanup_helper.sql` moves the helper
  to non-exposed `private`, recreates the owner-cleanup policy, and removes the
  public helper. That repair was applied and verified on 2026-08-17: the public
  helper is absent, the private helper has a pinned empty `search_path`, `anon`
  cannot execute it, required authenticated/service-role access remains, and
  the cleanup policy calls it. The advisor no longer flags this helper.

## Verification and open gaps

- Focused classifier and Storage/schema contract tests pass locally.
- No single live upload → AI classify → Storage object → metadata → signed
  download → search run was performed. The production checks above establish
  storage/metadata integrity, not the full signed-in browser workflow.
- The Documents list now loads bounded 50-row server pages. Search is truthfully
  labeled page-local and filters only the loaded page; the database GIN search
  index is not yet used for global server-side search.

**Current label:** Backend, metadata, Storage policies, and the private cleanup
helper repair are live and structurally verified; the complete signed-in
browser workflow remains unverified.
