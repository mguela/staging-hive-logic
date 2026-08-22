// api/_lib/tenant.js — multi-tenant resolver (Phase 1 tenancy spine).
//
// Answers the question every API used to hardcode: "which company is this
// request for?" — now derived from the signed-in user's membership instead of
// a fixed `slug = 'greenwich-handyman'`.
//
// Resolution precedence:
//   1. The user's active row in company_members (the real, multi-tenant answer).
//   2. Sole-company fallback — ONLY while exactly one company exists. This keeps
//      the single-tenant prototype working unchanged, and switches itself off the
//      instant a second company is created (then membership is required).
//   3. null — caller has no company; the API should return a clear error (or,
//      later, kick off self-serve provisioning).
//
// supabaseRequest is injectable via deps so this is unit-testable without network.

import { supabaseRequest as defaultSb } from './jobber.js';

// Resolve just the tenant id + the caller's role. `user` is the object from
// requireApiAuth ({ id, email }) — may be null for cron/service calls.
export async function resolveCompany(user, deps = {}) {
  const sb = deps.supabaseRequest || defaultSb;

  // 1. Signed-in user: their company is their active membership — full stop.
  //    A signed-in user with NO membership has no company yet and must provision
  //    one (self-serve signup). We deliberately do NOT fall back to the sole
  //    company for a user: that would drop a brand-new signup into someone
  //    else's books. Every existing user was backfilled a membership (sql/082).
  if (user && user.id) {
    const r = await sb(
      `company_members?user_id=eq.${encodeURIComponent(user.id)}&status=eq.active` +
      `&select=company_id,role&order=created_at.asc&limit=1`,
    );
    if (r.ok) {
      const rows = await r.json();
      if (rows && rows[0]) {
        return { company_id: rows[0].company_id, role: rows[0].role, via: 'membership' };
      }
    }
    return null;
  }

  // 2. Service/cron context (no user): sole-company fallback while exactly one
  //    company exists. Ask for two so we can tell "exactly one" from "more than
  //    one" — never guess when ambiguous. Self-disables at company #2.
  const cr = await sb('companies?select=id&order=created_at.asc&limit=2');
  if (cr.ok) {
    const cs = await cr.json();
    if (cs && cs.length === 1) {
      return { company_id: cs[0].id, role: 'service', via: 'sole-company' };
    }
  }

  // 3. No company for this caller.
  return null;
}

// Resolve the tenant AND return the full companies row (what the profile/setup
// surfaces need). Returns { company, role, via } or null.
export async function companyForUser(user, deps = {}) {
  const sb = deps.supabaseRequest || defaultSb;
  const t = await resolveCompany(user, deps);
  if (!t) return null;
  const r = await sb(`companies?id=eq.${encodeURIComponent(t.company_id)}&limit=1`);
  if (!r.ok) return null;
  const rows = await r.json();
  if (!rows || !rows[0]) return null;
  return { company: rows[0], role: t.role, via: t.via };
}

// The tenant SLUG (not UUID) — for the text-keyed subsystems (bookkeeping PO +
// ledger engines, inventory) whose `company_id` columns store the company slug
// rather than the id. Each company's slug is unique, and existing rows already
// key on it, so this makes those engines multi-tenant with no data rekey.
// Returns null if no company resolves (callers keep a single-tenant fallback).
export async function companySlugForUser(user, deps = {}) {
  const r = await companyForUser(user, deps);
  return r ? r.company.slug : null;
}
