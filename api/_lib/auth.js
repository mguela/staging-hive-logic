// api/_lib/auth.js
// Shared request-auth helper (2026-07-29, P0 security round 2).
// requireUser(req) returns the Supabase auth user for a valid Bearer session,
// or null when the caller is signed out / the token is bad. Endpoints that
// return real business data call this and 401 on null. Verification is done
// against Supabase's own /auth/v1/user endpoint -- the same method
// api/track1.js's getRequestingProfile and the bookkeeping _actor.js helpers
// already use. No profile/role lookup here: these endpoints only need to know
// the request comes from a real signed-in user, not which one.
//
// 2026-08-15 (preview-deploy auth fix). Two problems, both of which made
// "Reina chat doesn't authenticate on Vercel preview deployments" impossible
// to diagnose from the outside:
//
//   1. This file read exactly one env pair -- SUPABASE_URL and
//      SUPABASE_SERVICE_KEY -- with no fallbacks, while its sibling
//      api/_lib/guard.js verifyUserBearer already read three possible URL
//      names and four possible key names, preferring the ANON key. So a
//      deployment that has the anon key but not the service-role key (the
//      normal shape for a Preview environment, since the service-role key is
//      the one you scope to Production) passed the edge middleware and then
//      401'd in every handler. Verifying a user JWT needs only the anon key
//      plus the JWT itself -- the JWT is what authorizes -- so requiring the
//      service-role key here was both unnecessary and strictly more
//      privileged than the operation needs. Config resolution now mirrors
//      guard.js exactly, anon-key-first. This can only ever widen what
//      resolves: if the anon key is absent it still falls back to the
//      service key, i.e. today's behaviour.
//
//   2. Every failure returned the same bare `null`, so a MISCONFIGURED
//      DEPLOYMENT was indistinguishable from A SIGNED-OUT USER. The user was
//      correctly signed in, the server simply had no credentials to verify
//      them with, and the app said "Not signed in." -- sending everyone
//      hunting for a session bug that did not exist. verifyRequestUser()
//      below reports WHICH of those happened.
//
// Fail-closed is unchanged: an unverifiable request is still refused. The
// middleware's ENV_UNAVAILABLE escape hatch deliberately has no counterpart
// here -- that one defers enforcement to this layer, so this layer is where
// it has to stop. The only thing that changes is that we now say why.

// Resolve Supabase config the same way api/_lib/guard.js does. Kept in this
// order on purpose: the anon key is the least-privileged key that can perform
// this check, and it is not a secret (public/index.html ships it to the
// browser), so it is the one most likely to be present in every environment.
export function resolveSupabaseAuthConfig(env = process.env) {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL;
  const apiKey = env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    || env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_KEY;
  return { url, apiKey, configured: Boolean(url && apiKey) };
}

// Full result form. Returns { ok, user, reason } where reason is one of:
//   'ok'                - verified; `user` is the Supabase user
//   'no-token'          - no Authorization header at all (genuinely signed out)
//   'malformed-token'   - header present but not a usable "Bearer <jwt>"
//   'auth-unconfigured' - THIS DEPLOYMENT cannot verify anyone: no Supabase URL
//                         and/or key in env. Not the caller's fault.
//   'rejected'          - Supabase says this token is not a valid session
//   'verify-failed'     - the call to Supabase itself failed (network/5xx)
// Callers that just want the old behaviour keep using requireUser below.
export async function verifyRequestUser(req, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  let authHeader;
  try {
    const headers = req && req.headers;
    if (!headers || (typeof headers !== 'object' && typeof headers !== 'function')) {
      return { ok: false, user: null, reason: 'no-token' };
    }
    authHeader = headers.authorization ?? headers.Authorization;
  } catch {
    return { ok: false, user: null, reason: 'no-token' };
  }
  if (authHeader === undefined || authHeader === null || authHeader === '') {
    return { ok: false, user: null, reason: 'no-token' };
  }
  // Same header hardening as before: bounded length, no header injection.
  if (typeof authHeader !== 'string' || authHeader.length > 16_391 || /[\r\n]/u.test(authHeader)) {
    return { ok: false, user: null, reason: 'malformed-token' };
  }
  const matched = /^Bearer ([^\s]+)$/iu.exec(authHeader);
  if (!matched || matched[1].length > 16_384) {
    return { ok: false, user: null, reason: 'malformed-token' };
  }

  // Checked AFTER the token checks so a junk token still reads as a bad token
  // rather than blaming the deployment's configuration.
  const { url, apiKey, configured } = resolveSupabaseAuthConfig(env);
  if (!configured) return { ok: false, user: null, reason: 'auth-unconfigured' };

  try {
    const userRes = await fetchImpl(`${url}/auth/v1/user`, {
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${matched[1]}`,
      },
      signal: options.signal,
    });
    if (!userRes || typeof userRes.json !== 'function') {
      return { ok: false, user: null, reason: 'verify-failed' };
    }
    if (userRes.ok !== true) {
      // 5xx means Supabase could not answer; 4xx means it answered "no".
      const status = Number(userRes.status) || 0;
      return { ok: false, user: null, reason: status >= 500 ? 'verify-failed' : 'rejected' };
    }
    const user = await userRes.json();
    if (user && typeof user.id === 'string' && user.id.length > 0) {
      return { ok: true, user, reason: 'ok' };
    }
    return { ok: false, user: null, reason: 'rejected' };
  } catch {
    return { ok: false, user: null, reason: 'verify-failed' };
  }
}

// True when the request could not be judged because THIS deployment is not
// configured to verify anyone -- not because the caller is signed out.
export function isDeploymentAuthMisconfigured(reason) {
  return reason === 'auth-unconfigured';
}

// The original contract, unchanged: the user object, or null. Every existing
// caller keeps working exactly as before (and picks up the config-resolution
// fix above for free). Use verifyRequestUser when you want to tell the
// failure modes apart.
export async function requireUser(req, options = {}) {
  const result = await verifyRequestUser(req, options);
  return result.ok ? result.user : null;
}
