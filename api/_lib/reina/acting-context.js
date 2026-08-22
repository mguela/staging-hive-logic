import { requireUser } from '../auth.js';

const serverResolvedContexts = new WeakSet();

export const ACTING_CONTEXT_REASON = Object.freeze({
  disabled: 'ACTING_CONTEXT_DISABLED',
  unauthenticated: 'AUTHENTICATION_REQUIRED',
  authenticationUnavailable: 'AUTHENTICATION_UNAVAILABLE',
  principalInactive: 'PRINCIPAL_INACTIVE',
  profileUnavailable: 'PROFILE_UNAVAILABLE',
  profileAmbiguous: 'PROFILE_AMBIGUOUS',
  profileMismatch: 'PROFILE_ID_MISMATCH',
  roleDenied: 'ROLE_NOT_ALLOWED',
  resolved: 'ACTING_CONTEXT_RESOLVED',
});

export const ADMIN_PILOT_CAPABILITIES = Object.freeze([
  'reina:pilot:access',
  'reina:conversation:read',
  'reina:conversation:create',
  'reina:conversation:append',
]);

function enabled(env) {
  return env.REINA_ACTING_CONTEXT_ENABLED === 'true';
}

function serviceHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  };
}

function configured(env) {
  return typeof env.SUPABASE_URL === 'string' && env.SUPABASE_URL.length > 0
    && typeof env.SUPABASE_SERVICE_KEY === 'string' && env.SUPABASE_SERVICE_KEY.length > 0;
}

function activeAuthenticatedPrincipal(user) {
  if (!user || typeof user.id !== 'string' || user.id.length === 0) return false;
  if (user.deleted_at) return false;
  if (user.banned_until) {
    const bannedUntil = Date.parse(user.banned_until);
    if (!Number.isFinite(bannedUntil) || bannedUntil > Date.now()) return false;
  }
  return true;
}

async function loadExactProfile(userId, { env, fetchImpl, signal }) {
  if (!configured(env) || typeof fetchImpl !== 'function') {
    return { ok: false, reason: ACTING_CONTEXT_REASON.profileUnavailable };
  }

  // HiveLogic profiles have no soft-active column. A successful server-side
  // Supabase user lookup establishes that the principal is active; this query
  // then requires exactly one matching profile and a strict admin role.
  const url = `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,role&limit=2`;
  let response;
  try {
    response = await fetchImpl(url, { headers: serviceHeaders(env), signal });
  } catch {
    return { ok: false, reason: ACTING_CONTEXT_REASON.profileUnavailable };
  }
  if (!response?.ok) return { ok: false, reason: ACTING_CONTEXT_REASON.profileUnavailable };

  let rows;
  try { rows = await response.json(); } catch { return { ok: false, reason: ACTING_CONTEXT_REASON.profileUnavailable }; }
  if (!Array.isArray(rows)) return { ok: false, reason: ACTING_CONTEXT_REASON.profileUnavailable };
  if (rows.length !== 1) {
    return { ok: false, reason: rows.length > 1 ? ACTING_CONTEXT_REASON.profileAmbiguous : ACTING_CONTEXT_REASON.profileUnavailable };
  }
  if (rows[0]?.id !== userId) return { ok: false, reason: ACTING_CONTEXT_REASON.profileMismatch };
  return { ok: true, profile: rows[0] };
}

export async function resolveActingContext(req, dependencies = {}) {
  const env = dependencies.env || process.env;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const authenticate = dependencies.requireUserImpl || requireUser;

  if (!enabled(env)) return { ok: false, context: null, reason: ACTING_CONTEXT_REASON.disabled };

  let user;
  try {
    user = await authenticate(req, { env, fetchImpl, signal: dependencies.signal });
  } catch {
    return { ok: false, context: null, reason: ACTING_CONTEXT_REASON.authenticationUnavailable };
  }
  if (!user?.id) return { ok: false, context: null, reason: ACTING_CONTEXT_REASON.unauthenticated };
  if (!activeAuthenticatedPrincipal(user)) {
    return { ok: false, context: null, reason: ACTING_CONTEXT_REASON.principalInactive };
  }

  const loaded = await loadExactProfile(user.id, { env, fetchImpl, signal: dependencies.signal });
  if (!loaded.ok) return { ok: false, context: null, reason: loaded.reason };
  if (loaded.profile.role !== 'admin' && loaded.profile.role !== 'superadmin') {
    return { ok: false, context: null, reason: ACTING_CONTEXT_REASON.roleDenied };
  }

  const context = Object.freeze({
    principalId: user.id,
    role: 'admin',
    companyId: null,
    companyAuthorityVerified: false,
    capabilities: ADMIN_PILOT_CAPABILITIES,
    source: 'server_verified_auth_and_profile',
  });
  serverResolvedContexts.add(context);

  return {
    ok: true,
    reason: ACTING_CONTEXT_REASON.resolved,
    context,
  };
}

export function isServerResolvedActingContext(context) {
  return Boolean(context && typeof context === 'object' && serverResolvedContexts.has(context));
}
