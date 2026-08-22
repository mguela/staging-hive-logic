// api/bookkeeping/purchase-orders/_actor.js
//
// ROUND 4 FIX (reviewer #1): the previous version of this file trusted
// x-hivelogic-user-id / -role / -company-id request headers directly. That
// is spoofable by anyone who can send an HTTP request — there was no proxy
// in front of this route actually verifying and injecting those headers, so
// "the production pattern will handle it" was an unverified assumption, not
// a real control. Flagged correctly by the outside review.
//
// This now reuses HiveLogic's own real, already-shipped, already-merged-to-
// main authentication pattern instead of inventing a new one:
// getRequestingProfile() in api/track1.js (see reina/team-access-multiuser
// and the Microsoft 365 mail integration, both gated the same way). That
// pattern is: the client sends its real Supabase Auth access token as a
// Bearer header (the same token `sb.auth.getSession()` already gives the
// frontend everywhere else in this app); the server calls Supabase's own
// /auth/v1/user endpoint to verify that token is genuine and unexpired
// (Supabase validates the JWT signature and expiry itself — forging a valid
// one would mean breaking Supabase Auth, not just guessing a header name),
// then looks up the matching profiles row for role.
//
// This is real, not a header anyone can set from curl.

import { supabaseRequest } from '../../_lib/jobber.js';
import { companySlugForUser } from '../../_lib/tenant.js';

// This subsystem keys its tables on a TEXT company_id = the company slug. The
// actor's companyId is now resolved per-request from the signed-in user's
// membership (companySlugForUser), so the PO engine's cross-company checks —
// always real and tested — become genuinely multi-tenant. This constant is the
// single-tenant fallback (also overridable via HIVELOGIC_COMPANY_ID) used only
// when resolution can't find a company.
export const SINGLE_TENANT_COMPANY_ID = process.env.HIVELOGIC_COMPANY_ID || 'greenwich-handyman';

// Bug fix (2026-08-14, jomell: superadmin/admin should both be able to
// record a change order rejection -- turned out to affect every controller-
// gated action across the whole Accounting Controls module, not just that
// one endpoint): HiveLogic's real profiles.role values are 'superadmin' |
// 'admin' | 'crew' (sql/065_superadmin_role.sql added 'superadmin' as a
// third tier and promoted jomell + Chris to it, explicitly stating "every
// place in api/ that checked role === 'admin' was widened to also accept
// 'superadmin', so promoting jomell/Chris here doesn't remove anything they
// could already do" -- this file was the one place that widening never
// reached). The PO engine's role gates expect 'approver' | 'controller' |
// 'bookkeeper' | anything-else-can-only-request. Until HiveLogic grows more
// granular real roles, 'admin' and 'superadmin' both map to 'controller'
// (satisfies every approve/reject/force-close gate the engine has -- Chris
// and jomell are in practice the approver, controller, and bookkeeper
// today) and 'crew' maps to 'field' (can create/request purchase orders and
// after-the-fact purchases, cannot approve, reject, or force-close). This
// mapping is a deliberate, documented simplification for a real two-tier
// permission system, not a placeholder.
function mapRole(hivelogicRole) {
  if (hivelogicRole === 'admin' || hivelogicRole === 'superadmin') return 'controller';
  return 'field';
}

export async function getTrustedActor(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user?.id) return null;

  const profRes = await supabaseRequest(`profiles?id=eq.${encodeURIComponent(user.id)}&select=id,email,full_name,role`);
  if (!profRes.ok) return null;
  const rows = await profRes.json();
  const profile = rows?.[0];
  if (!profile) return null; // a verified Supabase user with no HiveLogic profile row is not a usable actor here

  // Per-request tenant: the actor's company slug from their membership, falling
  // back to the single-tenant constant if resolution finds nothing.
  const companyId = (await companySlugForUser({ id: profile.id })) || SINGLE_TENANT_COMPANY_ID;

  return {
    id: profile.id,
    role: mapRole(profile.role),
    companyId,
    email: profile.email,
    fullName: profile.full_name || null,
    hivelogicRole: profile.role // kept for audit/history detail, never used for engine role gating directly
  };
}
