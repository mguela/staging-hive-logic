// api/bookkeeping/ledger/_actor.js
// Same real, server-verified Supabase Auth pattern as the purchase-order
// engine's api/bookkeeping/purchase-orders/_actor.js (getTrustedActor()):
// the client sends its real Supabase Auth access token as a Bearer header,
// the server verifies it against Supabase's own /auth/v1/user endpoint, then
// looks up the matching profiles row for role. Never trusts client-supplied
// identity headers.
//
// The ledger engine (server/bookkeeping/src/ledger.js) has its OWN role
// vocabulary -- submitter/approver/bookkeeper/controller/auditor -- distinct
// from the PO engine's approver/controller/bookkeeper/field. HiveLogic's
// real profiles.role values are still just 'admin' | 'crew', so the mapping
// here is: 'admin' -> 'controller' (satisfies every ledger gate -- Chris is
// in practice the approver, bookkeeper, and controller today, same
// documented simplification as the PO actor mapping) and 'crew' ->
// 'submitter' (can create/view journal entries, cannot approve, post,
// reverse, lock a period, or create an adjustment).

import { supabaseRequest } from '../../_lib/jobber.js';
import { companySlugForUser } from '../../_lib/tenant.js';

// Text-keyed subsystem (company_id column = company slug). The actor's company
// is resolved per-request from the signed-in user's membership below; this is
// the single-tenant fallback (also overridable via HIVELOGIC_COMPANY_ID).
const SINGLE_TENANT_COMPANY_ID = process.env.HIVELOGIC_COMPANY_ID || 'greenwich-handyman';

function mapRole(hivelogicRole) {
  if (hivelogicRole === 'admin') return 'controller';
  return 'submitter';
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
  if (!profile) return null;

  const companyId = (await companySlugForUser({ id: profile.id })) || SINGLE_TENANT_COMPANY_ID;

  return {
    id: profile.id,
    role: mapRole(profile.role),
    companyId,
    email: profile.email,
    fullName: profile.full_name || null,
    hivelogicRole: profile.role
  };
}
