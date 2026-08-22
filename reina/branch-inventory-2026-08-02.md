# Branch Inventory & Main Reconcile — 2026-08-02

Tracking the reconciliation of outstanding feature branches into `main`.

## Round 3 (worktree `hlv_main_reconcile2`, branch `chore/main-reconcile-2026-08-02-round2`)

Completed by Claude Code after the bridge session repeatedly failed mid-merge.
On entry the worktree was **mid-merge** (origin/main `81214c5` into round2) with one
unresolved conflict.

**Merges landed on `main`:**

1. **origin/main catch-up merge** — resolved the in-progress conflict in `api/marketing.js`
   (both sides additive): kept the `campaign_regenerate_copy` route *and* the
   `reina_change_requests` / `reina_change_request_decide` routes; unified the
   `resource must be one of:` error string to list all three. Then fetched again
   (origin had advanced +2: `760b3f6` PC Bridge card heartbeat, `612beeb` boot-race
   auth fix) and merged clean.
   → pushed `760b3f6..6ed82d1`.
2. **feature/ready-for-you-reject-draft** — clean merge (Reject button on the send-review
   modal, reuses `campaign_delete`). +9 tests.
   → pushed `6ed82d1..98b34e4`, remote branch deleted.
3. **feature/ready-for-you-save-draft-edit** — conflict in
   `public/marketing-command-center/index.html` (both slices restructured the modal
   action row). Resolved into one coherent layout: **Reject** sits separately on the left;
   **Cancel / Save Draft / Send** grouped in `actionsRight`, order preserved. Updated two
   brittle exact-match layout regexes (`test/reject-draft.test.mjs`,
   `test/save-draft.test.mjs`) to match the integrated DOM — semantic intent of each test
   preserved; the reject assertion was already *named* "Cancel/Save/Send group". +8 tests.
   → pushed `98b34e4..d3a7859`, remote branch deleted.

**Remote branches deleted this round:**
- `feature/ready-for-you-regenerate-copy` (content already in main via round2 commits)
- `feature/ready-for-you-reject-draft`
- `feature/ready-for-you-save-draft-edit`

**Regression suite:** `node --test test/*.test.mjs` excluding `jobs-view-shape`,
`snapshot-rpc-shape`, `webhook-cleanup` → **169 pass / 0 fail** (29 files) at final state.

**Final `main`:** `d3a7859`.

**Worktree `hlv_main_reconcile2` removed** after push.

## Round 4 (worktree `hlv_verify_round3`, branch `chore/main-reconcile-2026-08-02-ccbundle`)

Completed as the first of three "quick wins" Chris selected after asking "whats the next smart move?".

**Merged:**

1. **feature/command-center-bundle-endpoint** -- adds a single bundled Command Center refresh
   endpoint (`resource=cc_bundle` in `api/track1.js`) that runs the 5 existing CC panel handlers
   concurrently via `Promise.all` and merges their responses under the right keys, plus a client-side
   `ccBundleFetch` dedupe/cache layer in `public/index.html`. +17 tests
   (`test/marketing-cc-bundle-endpoint.test.mjs`, `test/marketing-cc-bundle-frontend.test.mjs`).
   Conflict in `api/track1.js`: origin/main had added a global auth gate (2026-08-01, "Item 3")
   guarding every `resource=*` branch except `check_new_leads`; the incoming branch added the
   `cc_bundle` dispatch line at the same insertion point. Resolved by keeping the auth gate first,
   then the `cc_bundle` dispatch immediately after (so cc_bundle is also gated). `public/index.html`
   merged clean, no manual resolution needed.
   -> pushed `a85af78..d248e9a`, remote branch deleted.

**Regression suite:** 32 files (30 existing minus the 3 known-broken `mock.module` failures, plus the
2 new cc-bundle test files) -> **186 pass / 0 fail**.

**Final `main`:** `d248e9a`.

**Deferred to Chris's own call (not started this round):**
- Tier D: `chore/scratch-inventory`, `chore/overnight-report`,
  `chore/office-transfer-readiness-20260729` -- merge vs. delete decision needed.
- Tier E: `fix/invoices-client-lookup-pagination` -- needs a live click-through before merging.
- Re-inventory of newer branches: `codex/*`, `foundation/*`, `feature/reina-m1a-*`,
  `chore/reina-scan-cron`, `feature/unified-inbox`, `fix/hiveconnect-email-polish`,
  `feature/voip-queues-park-intercom-ai`, `fix/reina-scan-tenant-env`.
- Bucket 3: ~67 unmerged `marketing-suite-*` branches, per
  `reina/branch-reconciliation-plan-2026-08-01.md`.

## Still open (out of scope for the round-2 handoff)

Remote `feature/*` branches not yet reconciled — candidates for a future round:
- `feature/reina-m1a-scan`
- `feature/reina-m1a-v0`
- `feature/reina-m1a-v0.2-graph`
- `feature/reina-scan-shared-inbox`
- `feature/unified-inbox`
- `feature/voip-queues-park-intercom-ai`
- `marketing-suite-phase3-ready-for-you-nav` (the remaining "ready-for-you" branch;
  distinct from the three send-review-modal slices handled above)

## Round 5 (worktree hlv_phase14, branch chore/marketing-phase14-lifecycle-merge)

Merged Phase 14 (lifecycle playbooks: post-job thank-you + service-anniversary) into main.
Both branches were merged together in one worktree earlier (combined LIFECYCLE_PLAYBOOKS array,
combined dispatcher), full regression suite green (156 pass / 0 fail), then pushed straight to
main once verified no divergence.

-> pushed b1584c9..3816aa2, remote branches deleted:
- marketing-suite-phase14-post-job-thank-you
- marketing-suite-phase14-service-anniversary
- chore/marketing-phase14-lifecycle-merge (the integration branch itself, fully merged)

Update: sql/047_marketing_lifecycle_playbook_types.sql and sql/048_marketing_service_anniversary_type.sql
have since been applied to production Supabase via apply_migration (048 is a superset of 047; both
additive ALTER TABLE ... DROP/ADD CONSTRAINT statements widening campaigns.type). Verified live via
execute_sql against the updated constraint definition. post_job_thank_you and service_anniversary
campaign types are now fully live end to end.

**Final main:** 3816aa2.

**Worktree hlv_phase14 removed** after push (folder deleted directly; a stale git worktree
registration may remain in whichever clone originally created it -- harmless, prunable with
`git worktree prune` if it ever surfaces).


## Round 6 (worktree hlv_phase2, branch chore/phase2-integration)

Merged Phase 2 (marketing suite auth consolidation) into main.

**Merged:**

1. **marketing-suite-phase2-auth-consolidation** -- consolidates the duplicated
   hlTokenSync/hlFetchJSON auth helper that had drifted into two copies into one shared
   public/hl-shared-auth.js, and wires public/marketing-command-center/index.html to use it.
   +2 new test files (test/hl-shared-auth.test.mjs, test/marketing-auth-gate.test.mjs),
   321 insertions / 13 deletions total. git merge --no-edit origin/marketing-suite-phase2-auth-consolidation
   in a fresh worktree off origin/main (7f131f7) -- clean auto-merge, zero manual conflict
   resolution needed (only public/marketing-command-center/index.html auto-merged).
   -> pushed 7f131f7..fde87e9, remote branch deleted.

**Regression suite:** the fresh worktree had no node_modules (git worktrees do not carry
gitignored deps) and npm install failed hard through the automation bridge -- an unrelated
pre-existing executor bug: any npm invocation errors with
'C:\\Program' is not recognized as an internal or external command before npm even starts,
because npm.cmd on Windows requires cmd.exe and the executor spawns it unquoted. Worked around
by creating a filesystem junction from hlv_phase2\node_modules to the already-installed
hivelogic-live-mainwork\node_modules via python -c "import _winapi; _winapi.CreateJunction(...)"
(a junction, not a copy -- instant, no disk duplication), then unlinking it with os.rmdir (not
shutil.rmtree, which would have recursed into the junction and deleted the real target) once
tests were done and before removing the worktree. Full suite (36 files minus the 3 known-broken
mock.module failures) -> **190 pass / 0 fail**, including both new Phase 2 test files.

Flagging the npm-through-bridge bug for awareness: it blocks any future npm install/npm run *
call through run_project_command in a bare worktree until the executor process-spawn quoting is
fixed (out of scope for this round -- standing instruction was not to touch Service/Executor
further after the KeyNotFoundException fix). The junction workaround sidesteps it cleanly for
read-only dependency access; anything that needs to actually modify node_modules (installing a
new package) will hit it again.

**Final main:** fde87e9.

**Worktree hlv_phase2 removed** after push (node_modules junction unlinked first, then
git worktree remove --force from hivelogic-live-mainwork, which owned the registration).

Next in queue per the reconciliation plan: Phase 3 (marketing-suite-phase3-ready-for-you-nav,
single branch), then the 9-branch Phase 4 cluster (audit-event trio needs a diff first:
audit-event-emission, audit-event-emission-2, draft-audit-event).
