# HiveLogic Stabilization — Deploy Runbook (2026-08-01)

Ordered checklist to activate the Items 1–9 security fixes. **Do these in order.**
Nothing in the PR was deployed, merged, or run against production — this is the
handoff for Chris.

> Project: Supabase `sqhusuuhlmcmkeowdrga` · Vercel app `hivelogic-live`.

---

## 0. Before merge
- [ ] Review the draft PR (`fix/stabilization-integration-2026-08-01`).
- [ ] Confirm the CI/tests you rely on pass (the branch's own security tests are green;
      `jobs-view-shape` / `snapshot-rpc-shape` fail on Node 26 `mock.module` — pre-existing).

## 1. Set environment variables in Vercel (BEFORE deploying)
These gate the new auth. If unset, the affected endpoints **fail closed**.

| Env var | Item | Why |
|---------|------|-----|
| `CRON_SECRET` | 3, 6 | **Required.** Vercel auto-sends it as `Authorization: Bearer` to cron jobs. Without it, cron endpoints (sync, sync-extended, webhook drain, health-cron) 401 and the `/api` middleware falls to a logged grace only for cron paths. Generate a long random value. |
| `TEST_WORKFLOW_SECRET` | 2 | **New + rotate.** The old hard-coded runner secret is compromised. Set a fresh random value. |
| `RESEND_WEBHOOK_SECRET` | 6 | Set to Resend's **Svix "Signing Secret"** (`whsec_…`) from the webhook endpoint. Replaces the old `?secret=` value. |
| `RESEND_API_KEY` | 1 | Enables portal sign-in link delivery by email. Without it, public portal recovery is effectively disabled (by design). |
| `AUTHNET_SIGNATURE_KEY` | 4 | Confirm it is the **128-char hex** Signature Key (not the Transaction Key). |
| `AUTHNET_API_LOGIN_ID`, `AUTHNET_TRANSACTION_KEY` | 4 | Used by the settlement lookup. |
| `MONITOR_RETENTION_DAYS` | 9 | Optional, default 90. |
| `TOKEN_ENC_KEY` | (existing) | Back up before rotation; see `docs/SECURITY_OPERATIONS.md`. |
| `TOKEN_ENC_KEY_PREVIOUS` | (empty) | Set only during a controlled encryption-key rotation. |
| `TOKEN_ENC_WRITE_VERSION` | (unset / `v1`) | Keep at `v1` for the dual-reader compatibility release. Set `v2` only after every live and rollback revision can read v2. |

## 2. Apply SQL migrations (Supabase SQL editor or CLI) — additive, safe
Apply in this order. All are `create … if not exists` / `alter … if not exists`.
```
sql/043_portal_rate_limits.sql          # Item 1
sql/044_authnet_payment_events.sql      # Item 4
sql/047_oauth_states.sql                # Item 5
sql/048_security_harden_advisors_2026_08_01.sql   # Item 7
sql/050_monitor_tables.sql              # Item 9
sql/051_monitor_agent_token_hash.sql    # Item 9
sql/052_monitor_retention.sql           # Item 9
```
> Note: `main` already owns `sql/045_client_ar_outstanding.sql` and
> `sql/046_snapshot_ar_client_level.sql` — that is why the OAuth-state and
> hardening migrations are `047`/`048`. See `sql/MIGRATION_LEDGER.md`.

## 3. Supabase dashboard toggle
- [ ] **Authentication → Policies → enable "Leaked password protection"** (HaveIBeenPwned).
      Resolves the last WARN advisor. (Item 7)

## 4. Reconfigure external webhooks
- [ ] **Resend → Webhooks:** change the endpoint URL to `…/api/resend-webhook`
      (drop `?secret=`). Copy its Signing Secret into `RESEND_WEBHOOK_SECRET`.
- [ ] **Authorize.Net sandbox:** fire a test webhook, confirm a row appears in
      `authnet_payment_events` and the signature verifies. (Item 4)

## 5. ROTATE compromised / retired secrets
- [ ] `TEST_WORKFLOW_SECRET` — rotate the previously committed value; never record the replacement here
      is in git history. **Rotate.**
- [ ] Old cron `?key=` and Resend `?secret=` values — retired; rotate them.
- [ ] (Already noted on `main`) rotated Supabase service key + Twilio token stay as-is.

## 6. Deploy & verify
- [ ] Deploy the merged branch.
- [ ] **Crons still run:** watch one cycle of `/api/jobber/sync`, `/api/health-cron`
      (the daily audit email to Chris/Allan/Jovie), `/api/import-companycam`.
- [ ] **App loads for signed-in users:** dashboards/gauges/financials render
      (the SPA fetch shim attaches the session token — the middleware is transparent).
- [ ] **Anonymous is blocked:** `curl https://…/api/track1?resource=cash` → 401.
- [ ] **Monitor devices re-pair once** (token storage moved to hashed — expected).
- [ ] **Jobber connect** now starts from the signed-in app (authed fetch → `url` →
      navigate); a bare browser visit to `/api/jobber/connect` returns 401. A small
      UI trigger is a follow-up.

## 7. Post-merge cleanup
- [ ] Delete branch `fix/api-auth-round3` (superseded by Item 3).
- [ ] Delete the per-item branches once merged.

## Rollback
Every code change is revertable by reverting its commit; every migration is additive
(new tables / `alter` / pinned `search_path`) and safe to leave in place. To fully
back out a table: `drop table if exists <name>;` (all new tables are empty at deploy).

## Intentionally deferred (not blocking)
- Authorize.Net: no settled-event name hard-coded; invoice flips to paid on the
  later settlement redelivery. A re-poll cron would close the wait (separate item).
- `authenticated`-role `REVOKE` on `is_admin()` / `can_*_folder()` left commented in
  `048` pending verification they aren't used by RLS policies.
- Monitor agent `node-tar` transitive advisories (no fix available; build-time only).
- Jobber-connect UI trigger button.
- `genTempPassword()` `Math.random()` in track1.js — being handled in a separate task.
