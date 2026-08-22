# HiveLogic Fleet — Slice 0 Reconnaissance & Locked Decisions

**Status:** Slice 0 accepted. Slice 1 in progress on `feature/fleet-slice1`.
**Recon basis:** `origin/main` @ `be46f37` (re-confirmed still valid against `5d3c4cf`; the
intervening commits — schedule crew-row default, Gmail OAuth PR #192 — touched no
Fleet/tenant/auth files).
**Authoritative schema source:** `supabase/migrations/20260802140000_remote_baseline.sql`
(verified pg_dump of production, 150 tables). The numbered `sql/NNN_*.sql` files are
**deprecated historical reference** — do not add to them (see Decision 4).

This document exists so the Slice 0 findings and the four decisions taken on them do not
have to be re-derived. It is the rationale behind the Slice 1 migrations.

---

## ★ Hard gate — does `company_id` / RLS tenant isolation exist on `origin/main`?

**PARTIALLY. Tenant *scaffolding* exists; per-tenant *enforcement* does not. The app is
single-tenant, service-role-gated — not RLS-isolated per company.**

**Exists (scaffolding):**
- `companies` (uuid PK) and `org_units` (uuid PK; `unit_type` division/location/crew) —
  baseline `:1132`, `:2122`; seeded GH + 8 divisions incl. GH Electric at
  `sql/052_gate1b_companies_org_tenant.sql:2-4`.
- `company_id uuid` on exactly three business tables — `jobs`, `clients`, `invoices` — with
  FKs to `companies(id)`, backfilled and defaulted to GH's uuid
  `82cf7354-e460-4863-9f01-d67b3ad05d4a` (`sql/052…:7-18`; `jobs.company_id` baseline `:1496`).
- Gate-1 UUID identity: `external_refs` map + `uuid_id` surrogate on clients/jobs/invoices
  (`sql/049_gate1_phase0_uuid_identity.sql:1-13`).

**Does not exist (enforcement):**
- **No per-company RLS policy anywhere.** Every `create policy` in the repo is the identical
  service-role lockdown — `using (auth.role() = 'service_role')` (e.g.
  `sql/061_enable_rls_voice_and_selftest_tables.sql:24-26`). No `company_id`-predicated policy.
- **`company_id` is never resolved per-request from the JWT.** `profiles` carries `role` but no
  company; tenant keys appear only as hardcoded constants (e.g. `'ghgrp'`, `api/ads.js:185`).
- **Two coexisting `company_id` regimes:** new `uuid` (companies/org_units/jobs) vs. older
  `company_id text` on ~15 tables (`sql/010_purchase_orders.sql:32`, `sql/018_change_orders.sql:14`,
  bookkeeping_*). Not the same key.
- Security-harden migration states the intent: *"those tables are service-role-only by design"*
  (`sql/048_security_harden_advisors_2026_08_01.sql:7-8`).

**Consequence:** Fleet **extends** the companies/org_units uuid model and **follows the
service-role lockdown** (enable RLS, revoke anon/authenticated, service-role policy,
`company_id uuid NOT NULL REFERENCES companies(id)` defaulting to GH). It builds **no**
per-company RLS policies — nothing else in the app has them and the deployment is single-tenant.

---

## §19.1 findings (condensed)

### 1. Existing tables & ID types

| Entity | Table | PK / ID type | Owner | `company_id`? |
|---|---|---|---|---|
| Crew (Jobber) | `users` | `jobber_id` **text** | Jobber mirror | none (`:2892`) |
| Staff (app login) | `profiles` | `id` **uuid** → `auth.users` | HiveLogic | none (`:2279`) |
| Jobs | `jobs` | PK `jobber_id` **text**; surrogate `uuid_id` **uuid** (nullable, unique) | Jobber mirror | **uuid** (`:1496`) |
| Timesheets (Jobber) | `time_sheet_entries` | `jobber_id` **text**; has `job_uuid` | Jobber mirror | none (`:2762`) |
| Time (native clock) | `workforce_time_sessions`, `job_time_entries` | `id` **uuid** | HiveLogic | none |
| Invoices | `invoices` | PK `jobber_id` **text**; `uuid_id` uuid; lines = `line_items` **jsonb** | Jobber mirror | **uuid** (`:421`) |
| Companies (tenant) | `companies` | `id` **uuid** | HiveLogic | — |
| Divisions | `org_units` | `id` **uuid** | HiveLogic | uuid (`:2124`) |
| **Vehicles (already exists)** | `vehicles` | `jobber_id` **text** | Jobber mirror + FleetSharp | none (`:2909`) |

Jobs/invoices are **text `jobber_id`-keyed**; there is **no `id` column** on them. House style
joins via `job_uuid uuid → jobs(uuid_id)` (~20 FKs, e.g. `:5628`). "Employee = uuid" only holds
for `profiles`; Jobber crew is `users.jobber_id` text.

### 2. Tenant / RLS pattern
Service-role lockdown (see hard gate). New tables: `company_id uuid NOT NULL REFERENCES
companies(id)` default GH; `org_unit_id uuid REFERENCES org_units(id)` for division; enable RLS,
`revoke all … from anon, authenticated`, service-role `for all` policy.

### 3. Auth helper
- Gate: `requireApiAuth(req)` — `api/_lib/guard.js:237` (user-bearer or `CRON_SECRET`);
  `middleware.js` enforces `/api/*` globally.
- Data: **no `supabase-js`** — raw PostgREST via `supabaseRequest(path, opts)` from
  `api/_lib/jobber.js:12`, always service-role key.
- Role gating: profiles lookup at `api/track1.js:1007`; taxonomy `sql/066_permission_roles_v2.sql`.

### 4. Feature flag
Per-module `<MODULE>_ENABLED` env var read as `=== 'true'`, declared in `.env.example`; backend
returns 200 `{enabled:false}` when off (`api/bookkeeping/reference-data.js:47`); frontend keys off
`data.enabled === false` (`public/app-purchase-orders.js:282`). **Fleet → `FLEET_ENABLED`**, checked
after auth, before work.

### 5. Reina bridge
- **Seam B (LIVE, use):** `handleReinaLabRead` (`api/track1.js:2864`) → one `Promise.all` of domain
  projections via `readRows(path, project, limit)` (`:2957`), returns `business:{…}` (`:3234`),
  sanitized in `api/_lib/reina/pilot-intelligence-composer.js:115`, gated by
  `REINA_LAB_FULL_READ_ENABLED`. `vehicles` already reads at `:3101`; `'fleet'` already in
  `access.businessAreas` (`:3226`); trigger regex already matches `truck|vehicle|fleet`.
  `TIME_MISMATCH` belongs here.
- **Seam A (DORMANT):** governed trio `createJobsReadAdapter` (`api/_lib/reina/jobs-read-adapter.js:426`)
  + `jobsSnapshotToKnowledge`; real company-scope/dual-auth but `*.disabled`, synthetic-only,
  imported by no route. Template to graduate to later.

### 6. Migrations — the "043 collision" premise is obsolete
`sql/NNN_*.sql` is **deprecated as of 2026-08-02** (`MIGRATIONS.md:15-20`). New schema →
`supabase/migrations/<timestamp>_<name>.sql` (`MIGRATIONS.md:28-40`). No NNN collision applies.
**Drift to fix separately:** canonical `supabase/migrations/` holds 7 files (latest
`20260805221000`), yet `sql/065-070` were added post-freeze and are **not mirrored** there.
No `fleet_*`/`trips`/`geofences`/`assets` table names exist today (verified).

### 7. DigitalOcean ingest service
No non-Vercel/long-running service and no droplet/systemd/Docker tooling exist — first of its kind.
Precedents are client-installed only: `agents/windows/` (node-windows), `cowork-agent/` (C#),
`hivelogic-monitor-agent/` (Electron). Strategy: **separate repo with its own real GitHub remote**
per `claude/branch-coordination-protocol.md:135-164`.

### 8. DMT parser
No parser exists. Traccar `DmtProtocolDecoder` is Apache-2.0 (Java). Approach: **clean-room JS
informed by** the frame structure, not a port. Any adapted code → isolated in the ingest repo with
Apache-2.0 `LICENSE`, `NOTICE`, attribution headers.

### 9. Spec corrections required by current main
1. **Fleet GPS is not greenfield** — `vehicles` table live, fed by Jobber `currentPosition` +
   **FleetSharp Push** (`sql/068_fleetsharp_push.sql`, `api/jobber/sync-extended.js:474`, 2026-08-11).
2. `fleet_vehicles` vs existing `vehicles` — define linkage, don't duplicate.
3. Jobs/invoices are text-keyed; use `job_uuid → jobs(uuid_id)`.
4. `employee_id` ambiguous — `profiles.id` uuid vs `users.jobber_id` text.
5. Tenant model is single-tenant/service-role, not multi-tenant RLS.
6. Migration convention → `supabase/migrations/` timestamped.
7. DigitalOcean service is the first non-Vercel runtime.

---

## Locked decisions (2026-08-14) — govern Slice 1+

**1. FleetSharp Push and G150 — keep both; neither replaces the other yet.**
FleetSharp Push already removed Jobber from the GPS path (the original failure mode). It is the
**live production feed for now**; **not** legacy — do not deprecate, route around, or treat as
such. **G150 direct is the target end state** (owned hardware, no per-vehicle subscription). The
spec's Linxup validation workstream (§14) and instruction §1.1(3) are **revised to compare
FleetSharp Push vs G150 direct**, both flowing into HiveLogic (was: Linxup portal vs HiveLogic).
§18.1: "discontinue outside services" includes FleetSharp/Linxup, **no deadline** — exit condition
unchanged (HiveLogic out of prototype).

**2. `fleet_vehicles` ↔ existing `vehicles` — link, don't merge.**
Both tables kept. `fleet_vehicles` is HiveLogic-native (uuid PK). Existing `vehicles` stays the
Jobber/FleetSharp mirror, **untouched — Fleet never writes to `vehicles`.** Link **by VIN**
(FleetSharp already matches by VIN). Where VIN is absent/unreliable, fall back to an
**`external_refs`-style mapping row**, not a guess. Linkage documented in the migration.

**3. Job and employee keys — match house style, don't invent.**
- Jobs: carry `job_uuid uuid → jobs(uuid_id)` (matches the ~20 existing FKs); resolve from the
  inbound Jobber id via `external_refs`. Spec's `job_external_id text` is **replaced throughout.**
- Employees: `profiles.id` **uuid** for anything requiring an authenticated actor (checkouts,
  dispatcher assignments, active-driver taps, audit rows). `users.jobber_id` **text** for
  Jobber-sourced crew presence. **Every field states which** — no ambiguous `employee_id`. Column
  suffix convention: `*_profile_id` (uuid→profiles) vs `*_user_jobber_id` (text→users).

**4. Migration drift — fix it, but separately.**
The `sql/065-070` vs `supabase/migrations/` divergence is real but **not Fleet's job** — logged as
its own task. Fleet follows the documented path only: `supabase/migrations/<timestamp>_<name>.sql`.
No `sql/0NN_` files.

**Also confirmed:** service-role lockdown (no per-company policies); 043 warning was stale
(disregard); `FLEET_ENABLED` after auth; `requireApiAuth` + `supabaseRequest`; Reina Seam B for
`TIME_MISMATCH`; DMT clean-room JS; ingest service = separate repo with real remote from day one.
