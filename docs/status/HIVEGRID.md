# HiveGrid status

**Evidence date:** 2026-08-17
**Owner:** No HiveGrid owner is recorded in the repository.

## Repository state

- The Live Workbench is backed by the authenticated `api/takeoffs.js` route and
  the `takeoffs` schema from `sql/019_takeoffs.sql` / the production baseline.
  It persists quote-linked conditions, marks, sheet metadata, and status.
- Plan image/PDF-page pixels use the private `media` bucket through the
  server-side service role; signed reads are returned separately. Image paths
  are carried in the sheet JSON rather than a dedicated table column.
- The repository has a real-browser save → reload → load test for the embedded
  workbench (`test/browser/hivegrid-takeoff-workbench.test.mjs`).
- The required Chrome browser matrix passed all 6 HiveGrid scenarios, including
  a real save, simulated reload, and backend load with no page errors.
- The canonical-route inventory confirms the shipped HiveGrid entry resolves to
  its real view; it is not an orphaned navigation target.
- The other HiveGrid tabs remain design/reference surfaces with canned actions;
  they are not evidence of a live estimating backend.

## Verification and open gaps

- The browser test was invoked in this pass, but all six scenarios skipped
  because no Chromium binary is installed. That is **not** a pass.
- No real Jobber quote, Supabase row, or Storage object was created in this
  pass. A signed-in browser run against a non-production fixture is still
  needed to certify save/reload and image restoration end to end.
- The older `sql/019_takeoffs.sql` comments describe Phase 1 before image
  persistence; `api/takeoffs.js` contains the later Phase 1.5 behavior. The
  canonical migration baseline, not that old comment, is the schema evidence.

**Current label:** Live Workbench backend is implemented; browser certification
and production account verification remain open. Other tabs are mocks.
