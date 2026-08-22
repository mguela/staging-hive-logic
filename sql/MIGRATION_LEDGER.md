# HiveLogic SQL Migration Ledger

_Last updated: 2026-08-17 (remediation audit; lifecycle 052 and Storage notes reconciled). Supabase project: `sqhusuuhlmcmkeowdrga`._

> **Current verified state — 2026-08-16.** This legacy ledger contains
> historical counts and pending lists that are no longer current. The canonical
> operational status is now in [`MIGRATIONS.md`](../MIGRATIONS.md). In
> particular, `company_members` RLS is enabled, the banking re-auth function and
> its restricted ACL are recorded, the auth-link cleanup function is recorded,
> all 11 Workroom tables have owner-scoped RLS, and the security advisor has zero
> ERROR findings. Do not use the older “pending” tables below as an execution
> checklist without re-verifying production first.

This file makes the database **reproducible and auditable**. It reconciles the
repo's `sql/*.sql` files with what is actually applied in production, explains
the duplicate migration numbers, records the intended schema state, and lists
the manual production steps that live outside SQL.

> **Rule for this run:** migrations here are **additive and idempotent**. The
> seven stabilization migrations (§3) were applied to production on 2026-08-01
> on Chris's explicit go-ahead and verified (see §6). Already-applied
> migrations were **not** renamed (production
> history uses Supabase's own timestamped names; renaming repo files would not
> change production and would only obscure the mapping).

---

## 1. Repo files vs. applied production migrations

Two things drifted apart over the project's life:

- **`sql/*.sql`** — the canonical DDL in this repo. Numbered `002`–`059` (as of
  the 2026-08-07 audit; see §2b for `044`–`059`, added by parallel branches
  after this ledger's last full pass).
- **Supabase migration history** — 52 entries, timestamped (e.g.
  `20260723153817_020_review_requests`). Retrieved via `list_migrations`.

The repo files were applied through a mix of the Supabase migration system and
**manual SQL editor runs**, so the two lists do **not** map 1:1. The applied
history begins at `20260723…` (repo `020`); everything numbered below that
(`002`–`019`) was applied manually/out-of-band before the migration system was
in regular use. Production currently has **~130 tables in `public`**, all with
RLS enabled.

**Reproduce a fresh environment** by applying `sql/*.sql` in this order:
numeric ascending, and for a duplicated number, alphabetical by filename (the
two files with the same number touch disjoint tables — see §2, so order between
them does not matter). Then apply the stabilization additions in §3. (Note: main already owns 045_client_ar_outstanding and 046_snapshot_ar_client_level, so the OAuth-state and hardening migrations were renumbered to 047/048 to avoid collision.)

## 2. Duplicate migration numbers (explained, not renamed)

Parallel feature branches each grabbed "the next number" and both merged, so
these numbers appear twice. In every case the two files create **disjoint
tables**, so applying both (either order) is correct and non-conflicting:

| # | File A | File B | Notes |
|---|--------|--------|-------|
| 009 | `hiveconnect_bridge_mapping` | `product_nicknames` | disjoint |
| 010 | `cart_draft_support` | `purchase_orders` | disjoint |
| 011 | `ledger` | `reina_todo` | disjoint |
| 013 | `bookkeeping_audit_log` | `client_portal` / `job_signatures` / `lead_pipeline` | **four** files at 013; disjoint |
| 014 | `client_photo_shares` | `job_workflow` | disjoint |
| 015 | `field_travel` | `job_readiness` | disjoint |
| 016 | `field_job_reports` | `job_tm` | disjoint |
| 017 | `field_job_activity` | `tm_invoices` | disjoint |
| 019 | `takeoffs` | `tm_rate_seed` | disjoint |
| 020 | `estimates` | `review_requests` | disjoint |
| 021 | `bookkeeping_catalog` | `bookkeeping_expenses` / `campaigns` | three files; disjoint |
| 023 | `bookkeeping_evidence_review` | `voice_phone_system` | disjoint |
| 033 | `card_pricing` | `lead_alerts` | disjoint |

Gaps also exist (`001`, `027`, `036`–`038` unused) — harmless; the numbers are
labels, not a contiguous sequence. **Do not renumber**: production history is
keyed by the timestamped names above, and renaming would break the mapping in
this ledger without changing anything in the database.

## 2b. `044`–`054` collisions (found in the 2026-08-07 audit)

This ledger's collision table above stopped at `033`; the repo kept growing
past `048` with no corresponding update, so every number below went
undocumented until now. Same house rule as §2 applies: **do not renumber**,
every pair/triple below touches disjoint tables, and applying all files at a
given number (either order) is correct. "Applied" was checked directly
against `supabase/migrations/20260802140000_remote_baseline.sql` (the real
production schema dump) — see §3b for the full status table.

| # | Files at this number | Notes |
|---|---|---|
| 044 | `authnet_payment_events` / `invoice_balances_view` / `lead_pipeline_referred_by` | three files; disjoint; **all three already applied** |
| 045 | `client_ar_outstanding` / `marketing_channel_budget_pacing` | disjoint; both applied — `marketing_channel_budget_pacing`'s own header says "NOT applied to production" but its columns/constraints are present verbatim in the baseline; that header is stale, not the source of truth |
| 046 | `marketing_lead_revenue_attribution` / `snapshot_ar_client_level` | disjoint; `snapshot_ar_client_level` applied, `marketing_lead_revenue_attribution` still pending |
| 047 | `marketing_lifecycle_playbook_types` / `oauth_states` | disjoint; `oauth_states` applied (its own header still says `sql/045_oauth_states.sql`, a leftover from renumbering — harmless, file content is correct); the marketing type is present through the final 052 constraint, so this intermediate file is superseded and must not be replayed alone |
| 048 | `marketing_service_anniversary_type` / `security_harden_advisors_2026_08_01` | disjoint; security-harden applied 2026-08-01 (§6); the marketing type is present through the final 052 constraint |
| 049 | `gate1_phase0_uuid_identity` / `marketing_new_lead_followup_type` | disjoint; Gate 1 applied (external_refs + uuid_id columns confirmed live); the marketing type is present through the final 052 constraint |
| 050 | `gate1_phase1_uuid_fk_columns` / `marketing_dormant_reactivation_type` / `monitor_tables` | three files; disjoint; Gate 1 + monitor tables applied; the marketing type is present through the final 052 constraint |
| 051 | `gate1_phase1b_fk_constraints` / `marketing_newsletter_type` / `monitor_agent_token_hash` | three files; disjoint; Gate 1 + monitor token-hash applied; the marketing type is present through the final 052 constraint |
| 052 | `gate1b_companies_org_tenant` / `marketing_maintenance_reminders_type` / `monitor_retention` | three files; disjoint; all three schema effects are present. The 12-value `campaigns_type_check` was confirmed live 2026-08-15 and is represented canonically by `supabase/migrations/20260815205210_marketing_maintenance_reminders_type.sql` |
| 053 | `gate1_index_fk_columns` / `marketing_connection_state_extend` | disjoint; Gate 1's FK indexes applied; marketing connection-state widening pending |
| 054 | `marketing_platform_connections_fields` / `voice_queues` | disjoint; `voice_queues` applied; marketing `fields` jsonb column pending |

`055`–`059` have exactly one file each — no collision, listed in §3b for
applied status only.

## 3. Stabilization additions (2026-08-01)

Additive, service-role-only unless noted. Numbers chosen to avoid collisions.

| File | Item | Purpose |
|------|------|---------|
| `043_portal_rate_limits.sql` | 1 | Rate-limit ledger for public portal recovery endpoints |
| `044_authnet_payment_events.sql` | 4 | Auth.Net payment-event audit + idempotency table |
| `047_oauth_states.sql` | 5 | Single-use OAuth `state` tokens (CSRF fix) |
| `048_security_harden_advisors_2026_08_01.sql` | 7 | Pin `search_path` + revoke `anon` execute on flagged functions |
| `050_monitor_tables.sql` | 9 | Repo DDL for all 5 monitor tables (were applied out-of-band) |
| `051_monitor_agent_token_hash.sql` | 9 | Hashed agent-token column |
| `052_monitor_retention.sql` | 9 | Screenshot/session retention prune function |

> Files `044` and `050`–`052` land via the Item 4 / Item 9 branches; they are
> listed here so the ledger is the single source of truth once merged.

## 3b. Applied status for `044`–`059` (2026-08-07 audit)

The Gate 1 identity/org migrations (`049`–`053`) and a batch of `monitor`/
`voice` tables landed on production between the 2026-08-01 run above and this
audit, without ever being added to this ledger — this closes that gap.
Verified directly against `supabase/migrations/20260802140000_remote_baseline.sql`.

**Already applied:**

| File | What it added |
|------|----------------|
| `044_authnet_payment_events.sql` | `authnet_payment_events` audit/idempotency table (§3 above) |
| `044_invoice_balances_view.sql` | `invoice_balances` view — honest computed per-invoice balance |
| `044_lead_pipeline_referred_by.sql` | `lead_pipeline.referred_by_client_id` — real referral attribution, read live by `api/marketing.js`'s `getReferralCandidates()` |
| `045_client_ar_outstanding.sql` | `client_ar_outstanding` view — client-level AR matching Jobber's own balance |
| `045_marketing_channel_budget_pacing.sql` | 5 pacing columns + constraints on `marketing_channel_budgets` (header says pending — stale, ignore it) |
| `046_snapshot_ar_client_level.sql` | `snapshot_aggregates()` repointed to source AR from `client_ar_outstanding` |
| `047_oauth_states.sql` | `oauth_states` table + `prune_oauth_states()` |
| `048_security_harden_advisors_2026_08_01.sql` | `search_path` pins + `anon` revokes (§3/§6 above) |
| `049_gate1_phase0_uuid_identity.sql` | `external_refs` + `uuid_id` on clients/jobs/invoices (see §2b, Gate 0 audit) |
| `050_gate1_phase1_uuid_fk_columns.sql` | `client_uuid`/`job_uuid` companion columns everywhere `client_id`/`job_id` exists |
| `050_monitor_tables.sql` | `monitor_agents`, `monitor_sessions`, `monitor_activity_samples`, `monitor_pair_attempts`, `monitor_screenshots` |
| `051_gate1_phase1b_fk_constraints.sql` | Unique constraints + validated FKs on the `050` `_uuid` columns |
| `051_monitor_agent_token_hash.sql` | `monitor_agents.agent_token_hash` (hashed, replaces plaintext) |
| `052_gate1b_companies_org_tenant.sql` | `companies` + `org_units` ("divisions hierarchy") + `company_id` on clients/jobs/invoices |
| `052_monitor_retention.sql` | `prune_monitor_data()` retention function |
| `053_gate1_index_fk_columns.sql` | Indexes on every `client_uuid`/`job_uuid`/`company_id` column |
| `054_voice_queues.sql` | `voice_queues` + `voice_queue_members` |
| `055_voice_call_recording.sql` | `voice_settings` (call-recording/consent config) |
| `056_voicemail_soft_delete.sql` | `voice_voicemails.deleted_at` + index |
| `047`–`052` marketing lifecycle type files | Their accumulated schema effect is the final 12-value `campaigns_type_check`, confirmed present 2026-08-15; canonical file: `supabase/migrations/20260815205210_marketing_maintenance_reminders_type.sql`. Do not replay the narrower intermediate files. |

**Not yet applied (pending):**

| File | What it would add |
|------|----------------|
| `046_marketing_lead_revenue_attribution.sql` | `marketing_lead_attributions` + `marketing_revenue_attributions` tables |
| `053_marketing_connection_state_extend.sql` | `marketing_platform_connections.state` widened 6→10 values |
| `054_marketing_platform_connections_fields.sql` | `marketing_platform_connections.fields` jsonb column |
| `057_call_intelligence_transcript_sid.sql` | `voice_calls.intelligence_transcript_sid` + index |
| `058_paid_ads_social_foundation.sql` | `ad_platform_connections` + `ad_campaigns` (Meta/Google/TikTok ad connections) |
| `059_organic_social_posting.sql` | `social_posts` + TikTok content platform value |

The lifecycle type chain is no longer pending. The final 052 constraint contains
all 12 allowed values and was confirmed present on 2026-08-15. Replaying a
narrower intermediate file (`047`–`051`) would regress the allowed-value set;
do not run those files individually.

## 4. RLS posture: `rls_enabled_no_policy` is BY DESIGN

The 2026-08-01 security-advisor snapshot reported **115 tables with RLS enabled
but no policies**. For those specific server-only tables, that is intentional:
RLS-on + no-policy means no anon/authenticated access, while server APIs use the
service role. Browser-backed tables are a separate, explicit set. For example,
`documents`, `folders`, and `folder_access` have authenticated policies in the
production baseline because the Documents UI accesses them through the
publishable client. Do not generalize the server-only posture to those tables.

**Storage buckets are a separate category.** The table-RLS count above does not
cover `storage.objects`. `marketing-attachments` is server-side-only and has
the legacy `064_marketing_attachments_bucket_rls.sql`. Documents is different:
the browser directly uploads/copies/signs objects in the private `docs` bucket,
so default-deny is not a usable policy. The forward migration
`supabase/migrations/20260817221820_documents_storage_rls.sql` versions the
private bucket plus authenticated upload, metadata-authorized read, and
owner-cleanup policies. It was applied and structurally verified on 2026-08-17.
The live sample had one Storage object linked to one document and zero orphan
objects. Its initial cleanup SECURITY DEFINER helper was exposed through
`public`; the immutable migration file preserves that applied history.
`20260817222303_documents_storage_private_cleanup_helper.sql` was applied and
verified on 2026-08-17. The public helper is absent, the private helper is
SECURITY DEFINER with `search_path = ''`, `anon` cannot execute it,
authenticated/service-role access remains for the RLS policy, and the cleanup
policy calls the private helper. The advisor no longer flags this function.

## 5. Security advisors — status (as of 2026-08-01)

From `get_advisors(security)`: **120 findings — 115 INFO, 5 WARN.**

| Level | Finding | Count | Resolution |
|-------|---------|-------|------------|
| INFO | `rls_enabled_no_policy` | 115 | **By design** (§4). No action. |
| WARN | `function_search_path_mutable` (`protect_locked_geocode`) | 1 | Fixed in `048` (pin search_path) |
| WARN | `authenticated_security_definer_function_executable` (`can_access_folder`, `can_see_folder`, `is_admin`) | 3 | `048`: pin search_path + revoke `anon`; `authenticated` revoke left as reviewed-optional (may be used by RLS policies) |
| WARN | `auth_leaked_password_protection` | 1 | **Resolved 2026-08-17:** enabled and advisor-verified on HiveLogic, HiveConnect, and HiveDoc |

## 5b. `085_command_center_layouts` — applied 2026-08-16

| File | What it added | Status |
|------|----------------|--------|
| `085_command_center_layouts.sql` | `command_center_layouts` — per-user saved Command Center widget layouts, read/written by `api/track1.js` `resource=cc_layouts`. RLS on with four `user_id = auth.uid()` policies, `anon` revoked, a partial unique index enforcing one active layout per user, and a check constraint (`command_center_layout_has_decisions`) that makes it impossible to store a layout without the Today's Decisions widget. | **✅ APPLIED 2026-08-16** to `sqhusuuhlmcmkeowdrga` via MCP, on Chris's explicit go-ahead |

Additive only — no existing table is touched. Rollback is
`drop table public.command_center_layouts` plus the two functions
(`command_center_layout_has_decisions`, `command_center_layouts_touch`); safe,
the table was created empty. Templates are code constants, never rows here, so
nothing else depends on its contents.

Verified after applying: 7 columns, RLS on, 4 policies, 3 indexes, the check
constraint, the `updated_at` trigger, no `anon` SELECT, 0 rows, and no new
security-advisor findings. Both the check constraint and the one-active index
were exercised with probe inserts inside a rolled-back transaction.

## 6. Manual production steps (Chris)

1. **Apply migrations** `043`, `044`, `047`, `048`, `050`, `051`, `052` to
   `sqhusuuhlmcmkeowdrga`. **✅ APPLIED 2026-08-01** (via MCP, on Chris's
   explicit go-ahead; verified: new tables/columns/functions present,
   `search_path` pinned on all 4 flagged functions). All additive.
2. **✅ Enabled and verified 2026-08-17:** leaked-password protection
   (HaveIBeenPwned) is on for HiveLogic, HiveConnect, and HiveDoc.
3. **(Optional, after verifying policy usage)** uncomment the `authenticated`
   `REVOKE`s in `048` if `is_admin()` / `can_*_folder()` are not referenced by
   any RLS policy.
4. **Re-verify and apply only the migrations still listed as pending in §3b** —
   `046_marketing_lead_revenue_attribution`,
   `053_marketing_connection_state_extend`,
   `054_marketing_platform_connections_fields`,
   `057_call_intelligence_transcript_sid`, and the two paid-ads/social-
   posting foundations (`058`, `059`) — whenever the relevant team is ready
   and Chris gives the go-ahead. Do not replay lifecycle `047`–`052`; 052's
   accumulated 12-value constraint is already present.
5. **Apply `064_marketing_attachments_bucket_rls.sql`** — adds an explicit
   service-role-only `storage.objects` policy for the `marketing-attachments`
   bucket (ticket: "marketing-attachments bucket has no RLS," created 8/1,
   policy pending). Safe/additive — doesn't change today's behavior, since
   service-role already bypasses RLS and nothing else has ever successfully
   accessed this bucket (confirmed: zero direct frontend Storage calls
   against it).
6. **✅ Applied and verified 2026-08-17:**
   `20260817221814_ar_balance_discount_aware.sql` and
   `20260817221820_documents_storage_rls.sql`, followed by advisor repair
   `20260817222303_documents_storage_private_cleanup_helper.sql`. Verification
   confirmed the cleanup function is absent from `public`, present in
   non-exposed `private`, and the named Storage delete policy targets it.
7. **✅ Applied and verified 2026-08-17:** project-numbering security/view
   repair (`20260817235251`), request uniqueness + duplicate clock-index repair
   (live receipt `20260818000109`; replay-safe implementation
   `20260818150000`), atomic field/crew clock RPCs (`20260818000148`), and
   concurrency plus visit-scoped clock hardening (`20260818001232`).
   Live checks confirmed service-only ACLs, the 21-column jobs view, the
   ordinary nullable UNIQUE request constraint, one retained clock index, and
   transaction rollback on a forced crew insert failure. A rolled-back
   two-visit probe also confirmed that stopping one visit does not close a
   worker's open clock on another visit, while unique partial indexes enforce
   one open row per worker in each time-entry table.
8. **🟡 HiveConnect expand applied; contract pending:** live receipt
   `20260818002333 hiveconnect_auth_password_lifecycle_expand` adds four
   service-role-only password-lifecycle helpers plus stable invite recovery
   identifiers. PUBLIC, anon, and authenticated have no helper execution.
   `20260818_auth_password_lifecycle_cleanup.sql` must remain unapplied until
   the matching production client is verified; it then removes the three
   legacy direct password writers.
9. **✅ Applied and verified 2026-08-18:**
   `20260818180000_app_status_hub.sql` adds the protected App Status Hub
   findings and audit-event tables. RLS is enabled and only `service_role`
   has table privileges; the authenticated Dev To-Do API remains the only
   team-facing read/triage path.

The 2026-08-01 stabilization run did not rewrite existing table data. The
2026-08-17 forward migrations also write no business-table rows, but their
rollback is definition-specific: restore the prior `invoice_balances` view and
`snapshot_aggregates()` function, or remove the newly named Storage policies and
cleanup helper. Do not use a blanket `drop table` rollback for them.
