# HiveLogic → Multi-Tenant SaaS: Conversion Plan

**Goal:** turn the current single-company prototype into a product that any
size/type of contractor can sign up for and pay a subscription to use — with
each company's data fully isolated from every other company's.

**Status today:** works beautifully for **one** company (Greenwich Handyman),
because that company is *hardcoded*. Nothing is broken — it just only knows
about one tenant.

---

## The one problem everything else hangs on

Every API resolves "which company am I?" by hardcoding the same slug:

```
companies?slug=eq.greenwich-handyman
```

That literal string is in **9 API files** (company, onboarding, cost-model,
registries, invites, track1, bookkeeping ledger + POs), and a fixed
`company_id` UUID is pasted in **7 more places**. There is **no code that maps
a signed-in user to their own company.** So whoever logs in — anyone — lands on
Greenwich's books.

Selling subscriptions means: **the company must come from the user, and one
company must never see another's data.** Everything below serves that.

---

## Conversion status (live)

**Done — resolve tenant from the signed-in user (keyed on `companies.id` UUID):**
- `api/_lib/tenant.js` resolver + `company_members` table (sql/082, applied to prod).
- `api/company.js`, `api/onboarding.js` — converted; company.js also scopes
  headcount + division writes by company_id.
- `api/cost-model.js`, `api/registries.js` — converted; removed a module-global
  `_companyIdCache` that would have leaked one company's id into the next
  company's request on a warm serverless instance.

- `api/invites.js` — **done.** `create()` stamps the inviting admin's resolved
  company on the invite; `redeem()`/`finish()` already sourced the tenant from
  the invite/session (correct). User-facing "Greenwich Handyman" copy now uses
  the company name. Tests added.
- `integrations` table — **company_id added** (sql/083, backfilled) and the
  company-settings read is now company-scoped. Per-company OAuth *connection*
  flows (each company clicking "Connect Jobber/Gusto/QBO", + per-company sync
  jobs) remain **Phase 2** — a feature, not a column add; the 6 background
  token-writers stay key-global for now so the live company's sync isn't risked.

- **The text-slug subsystem — done.** `api/bookkeeping/**` (PO + ledger engines)
  and `api/track1.js` (inventory) keyed on a **text** `company_id` = the company
  slug via `HIVELOGIC_COMPANY_ID`. Both bookkeeping `getTrustedActor()` helpers
  and the one track1 inventory query now resolve the company **slug** per-request
  from the signed-in user (`companySlugForUser`), with the constant kept only as
  a single-tenant fallback. No data rekey — each company's slug is unique and
  Greenwich's rows already key on its slug. This makes the PO + ledger engines'
  (already tested) cross-company checks genuinely multi-tenant.

**Every hardcoded `slug = 'greenwich-handyman'` literal is now gone from
production code** — the tenant is resolved from the signed-in user everywhere.
Remaining before selling: Phase 2 (self-serve provisioning, per-company OAuth
connect flows) and Phase 3 (Stripe billing + entitlements).

---

## Phase 1 — Tenancy spine (the foundation; do this first)

The goal of Phase 1: after it, adding a second real company is safe.

1. **Membership table** — `company_members (company_id, user_id, role, status)`.
   One row per person-per-company. This is the source of truth for "who belongs
   to what."
2. **One resolver** — `api/_lib/tenant.js → companyForUser(req)`. Reads the
   authenticated user, returns *their* company_id (and role). Every API calls
   this instead of the hardcoded slug.
3. **Convert the 9 files** — replace `slug=eq.greenwich-handyman` with
   `companyForUser(req)`. Mechanical, one file at a time, each with a test.
4. **Isolation guard** — a single data-access layer that *always* scopes queries
   to the caller's company_id, so a missing filter can't leak another tenant.
   (Keeps the existing service-role model — no risky database-RLS rewrite.)
5. **Backfill** — Greenwich becomes the first `company_members` row (Chris = owner).
   Nothing changes for the existing app.

**Isolation decision (already made, no input needed):** app-layer `company_id`
scoping enforced in one guarded layer. Matches how the codebase already works
(service-role + application checks), avoids a full Postgres RLS migration, and
is testable.

---

## Phase 2 — Self-serve lifecycle

6. **Sign up → provision — DONE.** A signed-in user with no company names theirs
   ("Name your company" first-run gate in the wizard), which POSTs
   `company?resource=provision` → creates the `companies` row (unique slug,
   plan=trial) + their owner `company_members` row + a profile row, then hydrates
   the wizard. Idempotent. The sole-company fallback is now service/cron-only, so
   a new signup no longer lands in an existing company's books.
7. **Invite scoping — DONE** (Phase 1 Task A). Invites carry the inviter's company.
8. **Owner can leave/close** — **data export DONE** (`company?resource=export`,
   owner/admin only, read-only JSON of the company's own rows + an "Export company
   data" button on the settings page). Account **delete** intentionally not built
   (destructive; needs a deliberate, confirmed flow).

### Per-company OAuth connections — deliberately staged (NOT done)

The `integrations` table has `company_id` (sql/083) and the settings read is
company-scoped, but the OAuth **connection** flow is still single-connection:
`saveTokens()` in `gusto`/`qbo`/`jobber-callback` upserts `on_conflict=key`
(one row per provider, no company context threaded in), and `_lib/jobber.js` +
the sync crons read that one token in service context.

Making it truly per-company needs, together: unique `(company_id, key)`; all 6
token-writers to carry the connecting company; every read scoped; **and a
per-company sync scheduler** (the crons must iterate tenants and use each one's
token). That last part is the real work — and all of it sits on top of
`_lib/jobber.js`, the most widely-imported module in the app, feeding the live
Jobber/QBO/Gusto sync the current business runs on today.

Decision: **not rushed here.** The blast radius is the live revenue sync, it
can't be fully verified on prod (crons are auth-gated), and it yields nothing
until a second company both exists *and* has per-company sync. Build it as one
deliberate block with the sync scheduler, not a blind constraint swap.

---

## Phase 3 — Billing & plans (the "subscription" part)

**Payment processor: Authorize.Net (already integrated), not Stripe.** `api/_lib/authnet.js`
(Accept Hosted + settlement webhook + signature verify) and `AUTHNET_*` creds already exist.

> **Two payment flows — do NOT conflate them:**
> - **(A) Subscription billing** — HiveLogic charges each company a monthly fee (money → us).
>   ONE HiveLogic Authorize.Net account. Use **ARB** (recurring) + **CIM** (stored profiles).
>   Fine for flat tiers; Authorize.Net is weak at usage-based/proration/dunning, so keep
>   pricing flat (per-company, maybe per-seat).
> - **(B) Tenant payment processing** — each contractor collects from THEIR customers
>   (money → the tenant). The existing `/pay` page does this today on ONE global merchant
>   account. For multi-tenant this needs **per-company Authorize.Net merchant credentials**
>   (same per-company-secrets block as the OAuth staging) — AND it's a legal requirement:
>   you cannot run other companies' card payments through GH's merchant account (third-party
>   aggregation is prohibited). Each tenant brings their own merchant account.

9. **Subscription billing (A)** — Authorize.Net ARB + CIM on the HiveLogic account;
   checkout on signup or trial-then-pay.
10. **Entitlements** — `companies.plan` already exists but nothing reads it.
    Add a `planAllows(company, feature)` check: seat counts, which modules are on
    (Cost Model / Fleet / Payroll / Reina), usage limits.
11. **Plan tiers** — e.g. Starter (core), Pro (+Fleet +Payroll), Elite (+Reina AI).
    Exact tiers are a pricing decision for you.
12. **Per-tenant payment processing (B)** — folds into the per-company-credentials block;
    store each company's Authorize.Net creds, resolve them per charge. Legal: own merchant
    account per tenant.

---

## Phase 4 — "Any size / any trade" polish

12. **Benchmark breadth** — today only design-build/handyman/northeast has seed
    numbers. Either broaden the benchmark library by trade × region × size, or
    ship a clean guided empty-start so a plumber in Texas isn't shown handyman
    figures. (Empty-start is cheaper and honest; benchmarks can grow over time.)
13. **Per-company branding** — name/logo/colors on the client portal + invoices.
14. **Timezone/tax correctness per company** — the profile fields we just added
    (timezone, state, tax IDs) now drive each tenant's dates and documents.

---

## What does NOT get thrown away

Cost Model, Registries, Team, Gusto payroll, Fleet, Reina, the company-profile
editor, the onboarding wizard — all stay. They get *rehomed* onto the resolver
from Phase 1. This is a foundation swap, not a rebuild.

---

## Suggested order & rough effort

| Phase | What you can do after it | Effort |
|------|--------------------------|--------|
| 1 — Tenancy spine | Safely onboard a 2nd real company | Largest single lift |
| 2 — Self-serve | Strangers sign up without you | Medium |
| 3 — Billing | Actually charge money | Medium |
| 4 — Polish | Sell to any trade credibly | Ongoing |

**Recommendation:** Phase 1 as one focused project before any more features,
because every feature built on the hardcoded slug is more to untangle later.

---

## First concrete step (needs your greenlight)

Build Phase 1, steps 1–3: the `company_members` table, the `companyForUser`
resolver, and convert `api/company.js` + `api/onboarding.js` as the first two
files (with tests) — proving the pattern end-to-end on the surfaces we just
finished. Then roll the same change through the remaining 7 files.
