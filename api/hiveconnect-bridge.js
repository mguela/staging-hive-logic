// api/hiveconnect-bridge.js — Vercel serverless function
//
// HIVECONNECT MERGE — isolated Option C auth bridge (see
// claude/hiveconnect-hivelogic-merge-spec.md §5 SELECTED, §9, §10).
//
// This is a SINGLE consolidated route (mirrors the api/track1.js pattern
// already used in this repo to stay under Vercel's per-plan function-count
// limit — see fix-function-limit.bat) handling both account provisioning
// and session minting via ?action=. It does not import from, or get
// imported by, anything under public/hiveconnect/ — the bridge is isolated
// from the transplanted application code per §9.
//
// Required environment variables (server-side only, Vercel project settings —
// NEVER commit real values, NEVER put them in public/, NEVER log them):
//   HIVECONNECT_SUPABASE_URL          - HiveConnect's Supabase project URL
//   HIVECONNECT_SUPABASE_SERVICE_KEY  - HiveConnect's service-role key (admin)
// Reuses the existing HiveLogic-side vars already used by api/_lib/jobber.js:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY - HiveLogic's own project (mapping table lives here)
//
// Local/test mode: all external calls accept dependency overrides. No real
// secret is ever required by the test suite.

import crypto from 'node:crypto';

const HC_URL = () => process.env.HIVECONNECT_SUPABASE_URL;
const HC_KEY = () => process.env.HIVECONNECT_SUPABASE_SERVICE_KEY;
const HL_URL = () => process.env.SUPABASE_URL;
const HL_KEY = () => process.env.SUPABASE_SERVICE_KEY;

const HC_PASSWORD_ACTIONS = new Set(['redeem_invite', 'admin_create_user', 'admin_reset_password']);
const HC_ADMIN_PASSWORD_ACTIONS = new Set(['admin_create_user', 'admin_reset_password']);
const HC_ALLOWED_ROLES = new Set(['admin', 'member', 'guest']);
const HC_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HC_PUBLIC_ERRORS = {
  bad_request: ['Please check the account details and try again.', 400],
  email_required: ['Email is required.', 400],
  invalid_email: ['Enter a valid email address.', 400],
  name_required: ['Name is required.', 400],
  username_required: ['Username is required.', 400],
  invalid_username: ['Use only letters, numbers, dots, dashes, or underscores for the username.', 400],
  invalid_role: ['Choose a valid role.', 400],
  invalid_channels: ['One or more selected channels are invalid.', 400],
  invalid_target: ['That account is invalid.', 400],
  password_too_short: ['Password must be at least 8 characters.', 400],
  password_too_long: ['Password is too long.', 400],
  invite_invalid: ['This invite link is invalid.', 400],
  invite_used: ['This invite has already been used.', 409],
  invite_expired: ['This invite link has expired.', 400],
  invite_in_progress: ['This invite is already being redeemed. Wait a moment and try again.', 409],
  claim_invalid: ['This invite redemption could not be completed. Please try again.', 409],
  username_taken: ['That username is taken.', 409],
  email_exists: ['An account with that email already exists — try signing in instead.', 409],
  weak_password: ['That password does not meet the workspace security requirements.', 422],
  profile_missing: ['The account was created but its profile could not be prepared.', 502],
  self_reset_not_allowed: ['Use “Forgot password” to reset your own password.', 403],
  owner_reset_forbidden: ['Only an owner can reset another owner’s password.', 403],
  not_authorized: ['Admin sign-in required.', 401],
  bridge_unconfigured: ['HiveConnect is not configured on this deployment.', 503],
  cleanup_required: ['The account operation could not be completed safely. Contact an owner before retrying.', 503],
};

function hcError(code, message, status) {
  const known = HC_PUBLIC_ERRORS[code];
  const err = new Error(message || (known && known[0]) || 'HiveConnect account operation failed.');
  err.code = code || 'hiveconnect_auth_error';
  err.httpStatus = status || (known && known[1]) || 502;
  err.expose = Boolean(message || known);
  return err;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) throw hcError('email_required');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw hcError('invalid_email');
  return email;
}

function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!username) throw hcError('username_required');
  if (username.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(username)) throw hcError('invalid_username');
  return username;
}

function normalizeDisplayName(value) {
  const displayName = String(value || '').trim();
  if (!displayName) throw hcError('name_required');
  return displayName.slice(0, 120);
}

function normalizeRole(value) {
  const role = String(value || 'member').trim().toLowerCase();
  if (!HC_ALLOWED_ROLES.has(role)) throw hcError('invalid_role');
  return role;
}

function normalizeChannels(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100) throw hcError('invalid_channels');
  const ids = Array.from(new Set(value.map((id) => String(id || '').trim())));
  if (ids.some((id) => !HC_UUID_RE.test(id))) throw hcError('invalid_channels');
  return ids;
}

function normalizePassword(value) {
  const password = String(value || '');
  if (password.length < 8) throw hcError('password_too_short');
  if (password.length > 72) throw hcError('password_too_long');
  return password;
}

export function generateHiveConnectPassword(deps = {}) {
  const randomBytes = deps.randomBytes || crypto.randomBytes;
  // The prefix guarantees every common required character class; 24 random
  // bytes provide 192 bits of entropy. The password is returned once and is
  // never logged or persisted outside Supabase Auth.
  return `Hc!9${randomBytes(24).toString('base64url')}`;
}

// ---------- logging (never logs secrets, tokens, or auth payloads) ----------
export function logMapping(event, hivelogicUserId, extra = {}) {
  const safeExtra = { ...extra };
  delete safeExtra.token; delete safeExtra.access_token; delete safeExtra.refresh_token;
  delete safeExtra.password; delete safeExtra.service_key; delete safeExtra.secret;
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    scope: 'hiveconnect-bridge',
    event,                 // 'provision_ok' | 'provision_fail' | 'mint_ok' | 'mint_fail' | ...
    hivelogicUserId,        // immutable id only, never the email, never a token
    ...safeExtra
  }));
}

function logHiveConnectAuth(event, fields = {}) {
  // Deliberately allowlist fields. Passwords, bearer tokens, invite tokens,
  // emails, and raw upstream errors must never reach logs.
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    scope: 'hiveconnect-auth',
    event,
    actorId: fields.actorId || null,
    targetId: fields.targetId || null,
    code: fields.code || null,
  }));
}

// ---------- HiveLogic-side mapping table access ----------
async function hlRequest(path, options = {}) {
  return fetch(`${HL_URL()}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: HL_KEY(),
      Authorization: `Bearer ${HL_KEY()}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

export async function getMapping(hivelogicUserId, deps = {}) {
  const req = deps.hlRequest || hlRequest;
  const res = await req(`hiveconnect_account_map?hivelogic_user_id=eq.${encodeURIComponent(hivelogicUserId)}&select=*`);
  if (!res.ok) throw new Error(`Mapping lookup failed: ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

export async function saveMapping(hivelogicUserId, hiveconnectUserId, deps = {}) {
  const req = deps.hlRequest || hlRequest;
  // Upsert on the immutable hivelogic_user_id primary key — idempotent by
  // construction. A concurrent duplicate attempt with the same key resolves
  // to a single row, never two.
  const res = await req('hiveconnect_account_map?on_conflict=hivelogic_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      hivelogic_user_id: hivelogicUserId,
      hiveconnect_user_id: hiveconnectUserId,
      status: 'active',
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`Mapping save failed: ${await res.text()}`);
  const rows = await res.json();
  return rows[0];
}

// ---------- HiveConnect-side admin calls ----------
async function hcAdminRequest(path, options = {}) {
  return fetch(`${HC_URL()}/auth/v1/admin/${path}`, {
    ...options,
    headers: {
      apikey: HC_KEY(),
      Authorization: `Bearer ${HC_KEY()}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

async function responsePayload(res) {
  try { return await res.json(); } catch (_) { return {}; }
}

function authAdminError(payload, fallbackCode = 'hiveconnect_auth_error') {
  const upstreamCode = String((payload && (payload.code || payload.error_code || payload.error)) || '').toLowerCase();
  const upstreamMessage = String((payload && (payload.message || payload.msg)) || '').toLowerCase();
  if (upstreamCode === 'weak_password' || /known to be weak|password should|weak password/.test(upstreamMessage)) {
    return hcError('weak_password');
  }
  if (['email_exists', 'user_already_exists'].includes(upstreamCode) || /already (?:been )?registered|email.*already exists/.test(upstreamMessage)) {
    return hcError('email_exists');
  }
  return hcError(fallbackCode);
}

async function hcAdminJson(path, options = {}, deps = {}, fallbackCode) {
  const req = deps.hcAdminRequest || hcAdminRequest;
  let result;
  try {
    result = await req(path, options);
  } catch (_) {
    const error = hcError(fallbackCode || 'hiveconnect_auth_error');
    error.ambiguous = true;
    throw error;
  }
  const payload = await responsePayload(result);
  if (!result.ok) throw authAdminError(payload, fallbackCode);
  return payload;
}

async function hcRpc(name, body, deps = {}) {
  const rest = deps.hcRestRequest || hcRestRequest;
  let result;
  try {
    result = await rest(`rpc/${name}`, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    });
  } catch (_) {
    const error = hcError('hiveconnect_auth_error');
    error.ambiguous = true;
    throw error;
  }
  const payload = await responsePayload(result);
  if (!result.ok) {
    const rawCode = String((payload && (payload.message || payload.code)) || '').trim();
    const code = Object.hasOwn(HC_PUBLIC_ERRORS, rawCode) ? rawCode : 'hiveconnect_auth_error';
    throw hcError(code);
  }
  return payload;
}

async function finalizeRpc(name, body, deps = {}) {
  try {
    return await hcRpc(name, body, deps);
  } catch (error) {
    if (!error.ambiguous) throw error;
  }

  // Both finalizers are idempotent. Retry once when transport failed after the
  // request may already have committed, so we never compensate a successful
  // database transaction by deleting its Auth user.
  try {
    return await hcRpc(name, body, deps);
  } catch (error) {
    // Once the first response is ambiguous, it may have committed. A later
    // explicit retry error cannot prove that the first transaction failed, so
    // never compensate by deleting the Auth user or releasing the invite.
    error.safeToCleanup = false;
    throw error;
  }
}

function passwordShellMatches(user, expected) {
  if (!user || String(user.id || '') !== expected.userId) return false;
  if (String(user.email || '').trim().toLowerCase() !== expected.email) return false;
  const metadata = user.user_metadata || user.raw_user_meta_data || {};
  return String(metadata.username || '').trim().toLowerCase() === expected.username
    && String(metadata.display_name || '').trim() === expected.displayName;
}

async function recoverPasswordShell(expected, deps = {}) {
  try {
    const user = await hcAdminJson(`users/${encodeURIComponent(expected.userId)}`, {}, deps, 'invalid_target');
    return passwordShellMatches(user, expected) ? user : null;
  } catch (_) {
    return null;
  }
}

async function createPasswordShell({ userId, email, username, displayName }, deps = {}) {
  // Do not pass the final password to createUser: current GoTrue does not run
  // password-strength/HIBP checks on that endpoint. Omitting it makes GoTrue
  // generate an unknown placeholder credential; updateUserById below replaces
  // it through the checked password lifecycle.
  const expected = {
    userId: userId || (deps.randomUUID || crypto.randomUUID)(),
    email,
    username,
    displayName,
  };
  try {
    return await hcAdminJson('users', {
      method: 'POST',
      body: JSON.stringify({
        id: expected.userId,
        email,
        email_confirm: true,
        user_metadata: { username, display_name: displayName },
      }),
    }, deps, 'hiveconnect_auth_error');
  } catch (error) {
    // The POST may have committed even when its response was lost. A stable
    // preselected id lets this request—or a later invite retry—recover only the
    // exact shell it intended to create, never an arbitrary same-email user.
    const recovered = await recoverPasswordShell(expected, deps);
    if (recovered) return recovered;
    error.candidateUserId = expected.userId;
    throw error;
  }
}

async function setCheckedPassword(userId, password, deps = {}) {
  return hcAdminJson(`users/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    body: JSON.stringify({ password }),
  }, deps, 'hiveconnect_auth_error');
}

async function deleteNewHiveConnectUser(userId, deps = {}) {
  try {
    const req = deps.hcAdminRequest || hcAdminRequest;
    const result = await req(`users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    return Boolean(result && result.ok);
  } catch (_) {
    return false;
  }
}

async function createUserWithCheckedPassword(input, deps = {}) {
  let user;
  try {
    user = await createPasswordShell(input, deps);
  } catch (error) {
    // A returned Auth error means createUser did not commit. A transport error
    // is uncertain, so keep an invite claim until it expires rather than allow
    // another request to race a possibly-created shell account.
    if (error.ambiguous) {
      const uncertain = hcError('cleanup_required');
      uncertain.safeToReleaseClaim = false;
      logHiveConnectAuth('completion_uncertain', { code: 'auth_create_unacknowledged' });
      throw uncertain;
    }
    error.safeToReleaseClaim = true;
    throw error;
  }
  if (!user || !user.id) {
    const error = hcError('cleanup_required');
    error.safeToReleaseClaim = false;
    logHiveConnectAuth('completion_uncertain', { code: 'auth_create_missing_id' });
    throw error;
  }
  try {
    await setCheckedPassword(user.id, input.password, deps);
    return user;
  } catch (error) {
    const cleaned = await deleteNewHiveConnectUser(user.id, deps);
    error.safeToReleaseClaim = cleaned;
    if (!cleaned) {
      error.code = 'cleanup_required';
      error.httpStatus = HC_PUBLIC_ERRORS.cleanup_required[1];
      error.message = HC_PUBLIC_ERRORS.cleanup_required[0];
      error.expose = true;
      logHiveConnectAuth('cleanup_failed', { targetId: user.id, code: 'password_rejected' });
    }
    throw error;
  }
}

async function releaseInviteClaim(token, claimId, deps = {}) {
  try {
    await hcRpc('hc_release_invite_auth_claim', { p_token: token, p_claim_id: claimId }, deps);
    return true;
  } catch (_) {
    return false;
  }
}

export async function redeemHiveConnectInvite(input = {}, deps = {}) {
  const token = String(input.token || '').trim();
  if (!HC_UUID_RE.test(token)) throw hcError('invite_invalid');
  const displayName = normalizeDisplayName(input.displayName);
  const username = normalizeUsername(input.username);
  const rawEmail = String(input.email || '').trim();
  const suppliedEmail = rawEmail ? normalizeEmail(rawEmail) : '';
  const password = normalizePassword(input.password);

  const candidateUserId = (deps.randomUUID || crypto.randomUUID)();
  const claim = await hcRpc('hc_claim_invite_for_auth', {
    p_token: token,
    p_display: displayName,
    p_username: username,
    p_email: suppliedEmail,
    p_user_id: candidateUserId,
  }, deps);
  if (!claim || !HC_UUID_RE.test(String(claim.claim_id || ''))) throw hcError('claim_invalid');
  if (!HC_UUID_RE.test(String(claim.user_id || ''))) throw hcError('claim_invalid');

  // A bound invite's email is chosen inside the transaction and wins over the
  // browser value. Never trust the pre-authenticated client for that decision.
  const email = normalizeEmail(claim.email);
  let user;
  try {
    user = await createUserWithCheckedPassword({
      userId: String(claim.user_id), email, username, displayName, password,
    }, deps);
  } catch (error) {
    if (error.safeToReleaseClaim !== false) await releaseInviteClaim(token, claim.claim_id, deps);
    throw error;
  }

  try {
    const finalized = await finalizeRpc('hc_finalize_invite_auth', {
      p_token: token,
      p_claim_id: claim.claim_id,
      p_user_id: user.id,
    }, deps);
    logHiveConnectAuth('invite_redeemed', { targetId: user.id });
    return { id: user.id, email: normalizeEmail((finalized && finalized.email) || email) };
  } catch (error) {
    if (error.safeToCleanup === false) {
      logHiveConnectAuth('completion_uncertain', { targetId: user.id, code: 'invite_finalize_failed' });
      throw hcError('cleanup_required');
    }
    const cleaned = await deleteNewHiveConnectUser(user.id, deps);
    if (cleaned) await releaseInviteClaim(token, claim.claim_id, deps);
    else {
      error = hcError('cleanup_required');
      logHiveConnectAuth('cleanup_failed', { targetId: user.id, code: 'invite_finalize_failed' });
    }
    throw error;
  }
}

export async function provisionHiveConnectPasswordUser(input = {}, actor = {}, deps = {}) {
  const email = normalizeEmail(input.email);
  const displayName = normalizeDisplayName(input.displayName);
  const username = normalizeUsername(input.username);
  const role = normalizeRole(input.role);
  const channelIds = normalizeChannels(input.channelIds);
  const password = generateHiveConnectPassword(deps);
  const user = await createUserWithCheckedPassword({ email, username, displayName, password }, deps);

  try {
    await finalizeRpc('hc_finalize_admin_user_auth', {
      p_user_id: user.id,
      p_role: role,
      p_channel_ids: channelIds,
    }, deps);
  } catch (error) {
    if (error.safeToCleanup === false) {
      logHiveConnectAuth('completion_uncertain', { actorId: actor.id, targetId: user.id, code: 'admin_finalize_failed' });
      throw hcError('cleanup_required');
    }
    const cleaned = await deleteNewHiveConnectUser(user.id, deps);
    if (!cleaned) {
      error = hcError('cleanup_required');
      logHiveConnectAuth('cleanup_failed', { actorId: actor.id, targetId: user.id, code: 'admin_finalize_failed' });
    }
    throw error;
  }

  logHiveConnectAuth('admin_user_created', { actorId: actor.id, targetId: user.id });
  return { id: user.id, email, password, channelCount: channelIds.length };
}

async function getHiveConnectProfile(userId, deps = {}) {
  const rest = deps.hcRestRequest || hcRestRequest;
  const result = await rest(`profiles?id=eq.${encodeURIComponent(userId)}&select=id,role,active,display_name,username`);
  const payload = await responsePayload(result);
  if (!result.ok) throw hcError('hiveconnect_auth_error');
  return (Array.isArray(payload) && payload[0]) || null;
}

async function getHiveConnectAuthUser(userId, deps = {}) {
  const user = await hcAdminJson(`users/${encodeURIComponent(userId)}`, {}, deps, 'invalid_target');
  if (!user || !user.id || !user.email) throw hcError('invalid_target');
  return user;
}

export async function resetHiveConnectPassword(targetId, actor = {}, deps = {}) {
  const id = String(targetId || '').trim();
  if (!HC_UUID_RE.test(id)) throw hcError('invalid_target');
  if (id === actor.id) throw hcError('self_reset_not_allowed');

  const profile = await getHiveConnectProfile(id, deps);
  if (!profile) throw hcError('invalid_target');
  if (profile.role === 'owner' && actor.role !== 'owner') throw hcError('owner_reset_forbidden');

  const authUser = await getHiveConnectAuthUser(id, deps);
  const password = generateHiveConnectPassword(deps);
  await setCheckedPassword(id, password, deps);
  logHiveConnectAuth('admin_password_reset', { actorId: actor.id, targetId: id });
  return { id, email: normalizeEmail(authUser.email), password };
}

export async function getHiveConnectAdmin(req, deps = {}) {
  const authHeader = (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
  if (!token || !HC_URL() || !HC_KEY()) return null;
  const request = deps.fetch || fetch;
  let result;
  try {
    result = await request(`${HC_URL()}/auth/v1/user`, {
      headers: { apikey: HC_KEY(), Authorization: `Bearer ${token}` },
    });
  } catch (_) {
    return null;
  }
  if (!result.ok) return null;
  const user = await responsePayload(result);
  if (!user || !user.id) return null;
  const profile = await getHiveConnectProfile(user.id, deps).catch(() => null);
  if (!profile || profile.active !== true || !['owner', 'admin'].includes(profile.role)) return null;
  return { id: user.id, email: user.email || null, role: profile.role, displayName: profile.display_name || null };
}

export async function findHiveConnectUserByEmail(email, deps = {}) {
  const req = deps.hcAdminRequest || hcAdminRequest;
  // NOTE: Supabase's admin "list users" endpoint does not reliably support
  // server-side filtering by email via a query param — passing ?email=...
  // was silently ignored and returned the ENTIRE user list, which made
  // every lookup look like a multi-account duplicate-email conflict. Fetch
  // the (small) user list and filter by exact, case-insensitive email match
  // ourselves instead of trusting an email query param.
  const res = await req(`users?page=1&per_page=1000`);
  if (!res.ok) throw new Error(`HiveConnect user lookup failed: ${await res.text()}`);
  const body = await res.json();
  const users = body.users || body || [];
  const target = String(email).toLowerCase();
  return users.filter((u) => u.email && String(u.email).toLowerCase() === target); // caller decides — may be 0, 1, or (duplicate-email case) >1
}

export async function createHiveConnectUser(email, deps = {}) {
  const req = deps.hcAdminRequest || hcAdminRequest;
  const res = await req('users', {
    method: 'POST',
    body: JSON.stringify({ email, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`HiveConnect account creation failed: ${await res.text()}`);
  return res.json();
}

export async function mintHiveConnectSession(hiveconnectUserId, email, deps = {}) {
  const req = deps.hcAdminRequest || hcAdminRequest;
  // generateLink (type=magiclink) mints a redeemable token without sending
  // any email — the standard Supabase pattern for server-side "log this user
  // in" flows. The resulting token is exchanged for a real session client-side
  // in the same request/response round trip; nothing is emailed or shown to
  // the user.
  const verify = deps.verify || ((hashedToken) => fetch(`${HC_URL()}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: HC_KEY(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashedToken }),
  }));

  // A concurrent HiveConnect tab can invalidate the one-time magic-link token
  // between generation and verification. Retry that specific, safe condition
  // with a new token; all other failures remain fail-closed.
  //
  // ONE RETRY WAS NOT ENOUGH (Chris, 2026-08-18, on production: "HiveConnect
  // couldn't open. Session mint failed at verify step: ...otp_expired").
  // Generating a link INVALIDATES every earlier one for that email, so two
  // racers do not politely take turns -- they can knock each other out
  // repeatedly. Two callers mint on this page (the HiveConnect mount and
  // HiveLogic's own unread-message bridge), and a browser with more than one
  // tab open multiplies that again.
  //
  // So: more attempts, and a short backoff between them so the loser of a race
  // is not immediately back in the same collision. The backoff is jittered
  // because two tabs retrying in lockstep is just the same race again.
  const attempts = deps.mintAttempts || 4;
  const wait = deps.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await wait(120 * attempt + Math.floor((deps.jitter || Math.random)() * 150));
    const linkRes = await req('generate_link', {
      method: 'POST',
      body: JSON.stringify({ type: 'magiclink', email }),
    });
    if (!linkRes.ok) throw new Error(`Session mint failed: ${await linkRes.text()}`);
    const link = await linkRes.json();
    const hashed = link.hashed_token || (link.properties && link.properties.hashed_token);
    if (!hashed) throw new Error('Session mint failed: no hashed_token in generate_link response');

    const verifyRes = await verify(hashed);
    if (!verifyRes.ok) {
      const body = await verifyRes.text();
      if (attempt < attempts - 1 && /otp_expired/i.test(body)) continue;
      throw new Error(`Session mint failed at verify step: ${body}`);
    }
    const session = await verifyRes.json();
    if (!session.access_token || !session.refresh_token) {
      throw new Error('Session mint failed: verify step returned no session');
    }
    return {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
    };
  }

  throw new Error(`Session mint failed after ${attempts} attempts — another tab kept invalidating the token`);
}

// ---------- Orchestration (idempotent provisioning + mint) ----------
// Create-or-find the HiveConnect account for a HiveLogic user and save the
// hiveconnect_account_map row, WITHOUT minting a session. Split out of
// ensureMappedAndMint so the Team & Access invite flow (api/track1.js) can
// provision an account eagerly at invite time -- before the new hire has
// ever opened HiveConnect -- without also minting a session nobody needs yet.
export async function provisionHiveConnectAccount(hivelogicUserId, hivelogicEmail, deps = {}) {
  // Idempotency guard #1: never create blind. Look for an existing
  // HiveConnect account by email first (e.g. someone already on the
  // standalone deployment) before creating a new one.
  const existing = await findHiveConnectUserByEmail(hivelogicEmail, deps);
  if (existing.length > 1) {
    logMapping('provision_fail', hivelogicUserId, { reason: 'duplicate_email', count: existing.length });
    throw Object.assign(new Error(
      'More than one HiveConnect account shares this email address. Resolve the ' +
      'duplicate in HiveConnect directly before this user can be bridged.'
    ), { code: 'duplicate_email' });
  }
  const hiveconnectUserId = existing.length === 1
    ? existing[0].id
    : (await createHiveConnectUser(hivelogicEmail, deps)).id;

  const mapping = await saveMapping(hivelogicUserId, hiveconnectUserId, deps);
  logMapping('provision_ok', hivelogicUserId, { created: existing.length === 0 });
  return mapping;
}

export async function ensureMappedAndMint(hivelogicUserId, hivelogicEmail, opts = {}) {
  const deps = opts.deps || {};
  if (opts.isDisabledUser) {
    logMapping('mint_fail', hivelogicUserId, { reason: 'disabled_user' });
    throw Object.assign(new Error('This account is disabled and cannot open HiveConnect.'), { code: 'disabled_user' });
  }

  let mapping = await getMapping(hivelogicUserId, deps);

  if (mapping && mapping.status !== 'active') {
    logMapping('mint_fail', hivelogicUserId, { reason: 'mapping_inactive' });
    throw Object.assign(new Error('Your HiveConnect account mapping is not active. Contact an admin.'), { code: 'mapping_inactive' });
  }

  if (!mapping) {
    mapping = await provisionHiveConnectAccount(hivelogicUserId, hivelogicEmail, deps);
  }

  try {
    const session = await mintHiveConnectSession(mapping.hiveconnect_user_id, hivelogicEmail, deps);
    logMapping('mint_ok', hivelogicUserId);
    return session;
  } catch (e) {
    logMapping('mint_fail', hivelogicUserId, { reason: 'mint_error', message: e.message });
    throw e;
  }
}

// ---------- Reina bot messaging (service-to-service, no user session) ----------
// Per reina/hiveconnect-bot-notifications-spec-2026-07-25.md -- lets Reina
// post alert/summary output (e.g. a voicemail summary) into a real
// HiveConnect channel as a bot user, instead of a Slack webhook that no
// longer exists. Guarded by a shared secret (REINA_BOT_SECRET) instead of
// a user session on purpose -- this is called server-to-server, from
// api/voice-webhook.js, never from a logged-in browser.
async function hcRestRequest(path, options = {}) {
  return fetch(`${HC_URL()}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: HC_KEY(),
      Authorization: `Bearer ${HC_KEY()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...options.headers,
    },
  });
}

function botSecretOk(body) {
  const secret = process.env.REINA_BOT_SECRET;
  return Boolean(secret) && Boolean(body) && body.secret === secret;
}

// One-time setup call: creates (or finds) the Reina bot's HiveConnect auth
// account, best-effort gives it a display name, and joins it to the
// requested channel. Returns the bot's HiveConnect user id -- save that as
// REINA_BOT_HIVECONNECT_USER_ID so bot_post does not have to re-resolve it
// on every call.
export async function provisionBotAccount(channelId, deps = {}) {
  const email = process.env.REINA_BOT_EMAIL || 'reina-bot@hivelogic.internal';
  const existing = await findHiveConnectUserByEmail(email, deps);
  const userId = existing.length ? existing[0].id : (await createHiveConnectUser(email, deps)).id;

  const rest = deps.hcRestRequest || hcRestRequest;
  // Best-effort -- a profiles-table shape mismatch here should not stop
  // the account or channel membership from being created; worst case the
  // bot posts under a blank name until this is fixed by hand.
  await rest('profiles?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ id: userId, display_name: 'Reina', username: 'reina' }),
  }).catch(() => {});

  if (channelId) {
    await rest('channel_members', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify({ channel_id: channelId, user_id: userId }),
    }).catch(() => {});
  }

  return { hiveconnectUserId: userId };
}

export async function postBotMessage(channelId, text, deps = {}) {
  const userId = process.env.REINA_BOT_HIVECONNECT_USER_ID;
  if (!userId) throw Object.assign(new Error('Reina bot is not provisioned yet -- call action=bot_provision first.'), { code: 'bot_not_provisioned' });
  if (!channelId) throw Object.assign(new Error('channelId is required'), { code: 'missing_channel' });
  const rest = deps.hcRestRequest || hcRestRequest;
  const res = await rest('messages', {
    method: 'POST',
    body: JSON.stringify({ channel_id: channelId, user_id: userId, content: text }),
  });
  if (!res.ok) throw new Error(`bot message post failed: ${await res.text()}`);
  return true;
}

export async function listBotChannels(deps = {}) {
  const rest = deps.hcRestRequest || hcRestRequest;
  const res = await rest('channels?select=id,name&order=name.asc');
  if (!res.ok) throw new Error(`channel list failed: ${await res.text()}`);
  return res.json();
}

// ---------- HiveConnect Tasks read/write (Team To-Do rewire, 2026-08-16) ----------
// The Command Center "Team To-Do" card reads REAL user-created tasks from
// HiveConnect's own `tasks` table (sql/hiveconnect/001_tasks_core.sql, live
// since 2026-07-19) instead of the Reina engineering snapshot it used to
// show. HiveConnect and HiveLogic are two separate Supabase projects with no
// FK between them, so the read has to come through this bridge, server-side,
// with the HiveConnect SERVICE key -- never HiveConnect's anon key from a
// HiveLogic page. No new table, no schema change: this reads and writes the
// exact same rows the HiveConnect Tasks UI already uses.
//
// Write scope is deliberately ONE operation: mark a task completed. Anything
// else (create, reassign, reopen, delete) stays in the HiveConnect Tasks UI,
// which the card's "＋ Task" button routes to.

// Statuses that are NOT live operational work. 'draft' is excluded on purpose
// -- an unfinished task nobody has committed to yet is not the team's to-do.
export const TEAM_TODO_INACTIVE_STATUSES = ['completed', 'cancelled', 'draft'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function taskInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Resolves owner display names for the three owner shapes the tasks table
// allows (profile / channel / contact) -- the same three the HiveConnect UI's
// taskOwnerLabel() resolves, just server-side.
async function resolveTaskOwners(tasks, rest) {
  const ids = (key) => Array.from(new Set(tasks.map((t) => t[key]).filter((v) => v && UUID_RE.test(v))));
  const profileIds = ids('owner_profile_id');
  const channelIds = ids('owner_channel_id');
  const contactIds = ids('owner_contact_id');
  const fetchAll = async (path) => {
    const res = await rest(path);
    if (!res.ok) throw new Error(`task owner lookup failed: ${await res.text()}`);
    return res.json();
  };
  const [profiles, channels, contacts] = await Promise.all([
    profileIds.length ? fetchAll(`profiles?select=id,display_name,username&id=in.(${profileIds.join(',')})`) : Promise.resolve([]),
    channelIds.length ? fetchAll(`channels?select=id,name&id=in.(${channelIds.join(',')})`) : Promise.resolve([]),
    contactIds.length ? fetchAll(`contacts?select=id,name&id=in.(${contactIds.join(',')})`) : Promise.resolve([]),
  ]);
  const byId = (rows) => { const m = new Map(); (rows || []).forEach((r) => m.set(r.id, r)); return m; };
  return { profiles: byId(profiles), channels: byId(channels), contacts: byId(contacts) };
}

export function taskOwnerLabel(task, owners) {
  if (task.owner_type === 'employee') {
    const p = owners.profiles.get(task.owner_profile_id);
    return (p && (p.display_name || p.username)) || 'Unassigned';
  }
  if (task.owner_type === 'team') {
    const c = owners.channels.get(task.owner_channel_id);
    return c && c.name ? '#' + c.name : 'Team';
  }
  const c = owners.contacts.get(task.owner_contact_id);
  return (c && c.name) || ({ vendor: 'Vendor', sub: 'Sub', client: 'Client' }[task.owner_type] || 'Unassigned');
}

// Active, user-created tasks across the team -- this is the whole point of the
// card ("tasks I create in HiveConnect for a team member must show here"), so
// it is NOT filtered to the calling user.
export async function listActiveTasks(deps = {}, opts = {}) {
  const rest = deps.hcRestRequest || hcRestRequest;
  const limit = Math.max(1, Math.min(100, parseInt(opts.limit, 10) || 40));
  const exclude = TEAM_TODO_INACTIVE_STATUSES.join(',');
  const res = await rest(
    'tasks?select=id,title,status,priority,owner_type,owner_profile_id,owner_channel_id,owner_contact_id,' +
    'deliverable_date,job_ref,client_ref,created_at' +
    // One `order` param with both keys -- PostgREST takes a comma-separated
    // list; a second `order=` would simply replace the first.
    `&status=not.in.(${exclude})&order=deliverable_date.asc.nullslast,created_at.desc&limit=${limit}`
  );
  if (!res.ok) throw new Error(`task list failed: ${await res.text()}`);
  const rows = await res.json();
  const tasks = Array.isArray(rows) ? rows : [];
  const owners = await resolveTaskOwners(tasks, rest);
  return tasks.map((t) => {
    const label = taskOwnerLabel(t, owners);
    return {
      id: t.id,
      title: t.title || '(untitled)',
      status: t.status,
      priority: t.priority || 'normal',
      ownerLabel: label,
      ownerInitials: taskInitials(label.replace(/^#/, '')),
      dueDate: t.deliverable_date || null,
      tag: t.job_ref || t.client_ref || null,
      createdAt: t.created_at || null,
    };
  });
}

// Mirrors public/hiveconnect/tasks.js updateTaskStatus() exactly: patch the
// row, then append a task_status_history entry. Same write shape as the app's
// own, so a task completed from the Command Center is indistinguishable from
// one completed inside HiveConnect.
// Create a task in HiveConnect, owned by the caller.
//
// ADDED 2026-08-17 for Reina's inbox triage: "push it to Team To-Do" is one of
// the one-tap actions on a flagged email, and there is no honest way to do that
// without a create path. Until now this bridge could only ever COMPLETE a task,
// and a test asserted exactly that -- deliberately, to keep the write surface
// as small as the feature needed. The feature now needs one more verb, so the
// test says so instead of pretending nothing changed.
//
// Still narrow on purpose: it sets a title, an owner, and an optional
// source reference. No status other than the default, no assignment to other
// people, no dates, no deletion. A task created here looks like one a person
// typed into HiveConnect, because that is what it has to be indistinguishable
// from when it shows up in their list.
export async function createTask(input, hiveconnectUserId, deps = {}) {
  const title = String((input && input.title) || '').trim();
  if (!title) throw Object.assign(new Error('A task needs a title.'), { code: 'bad_task_title' });
  if (!hiveconnectUserId || !UUID_RE.test(String(hiveconnectUserId))) {
    throw Object.assign(new Error('A linked HiveConnect account is required.'), { code: 'not_mapped' });
  }
  const rest = deps.hcRestRequest || hcRestRequest;
  const row = {
    title: title.slice(0, 300),
    status: 'not_started',
    priority: ['low', 'normal', 'high', 'urgent'].indexOf(String(input.priority)) !== -1 ? input.priority : 'normal',
    owner_type: 'employee',
    owner_profile_id: hiveconnectUserId,
    created_by: hiveconnectUserId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (input.note) row.description = String(input.note).slice(0, 2000);
  if (input.deliverableDate) row.deliverable_date = String(input.deliverableDate).slice(0, 10);

  const res = await rest('tasks', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`task create failed: ${(await res.text()).slice(0, 200)}`);
  const created = ((await res.json()) || [])[0];
  if (!created) throw new Error('task create returned nothing');
  return { id: created.id, title: created.title, status: created.status };
}

export async function completeTask(taskId, hiveconnectUserId, deps = {}) {
  if (!taskId || !UUID_RE.test(String(taskId))) {
    throw Object.assign(new Error('A valid task id is required.'), { code: 'bad_task_id' });
  }
  const rest = deps.hcRestRequest || hcRestRequest;
  const lookup = await rest(`tasks?id=eq.${encodeURIComponent(taskId)}&select=id,status,completion_date`);
  if (!lookup.ok) throw new Error(`task lookup failed: ${await lookup.text()}`);
  const rows = await lookup.json();
  const task = (rows || [])[0];
  if (!task) throw Object.assign(new Error('That task no longer exists in HiveConnect.'), { code: 'task_not_found' });
  if (task.status === 'completed') {
    return { id: task.id, fromStatus: 'completed', status: 'completed', historyWritten: false, alreadyCompleted: true };
  }

  const now = new Date().toISOString();
  const patch = await rest(`tasks?id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'completed', completion_date: now, updated_at: now }),
  });
  if (!patch.ok) throw new Error(`task update failed: ${await patch.text()}`);

  // History is appended after the status write, same order as the app. A
  // history failure is reported (historyWritten:false), never swallowed into
  // a silent success -- the status change itself has already happened and
  // re-running it would not fix the missing audit row.
  let historyWritten = true;
  let historyError = null;
  try {
    const hist = await rest('task_status_history', {
      method: 'POST',
      body: JSON.stringify({
        task_id: taskId,
        from_status: task.status,
        to_status: 'completed',
        changed_by: hiveconnectUserId || null,
        note: 'Completed from HiveLogic Command Center',
      }),
    });
    if (!hist.ok) { historyWritten = false; historyError = (await hist.text()).slice(0, 200); }
  } catch (e) {
    historyWritten = false;
    historyError = String(e.message || e).slice(0, 200);
  }
  return { id: task.id, fromStatus: task.status, status: 'completed', historyWritten, historyError };
}

import { requireUser } from './_lib/auth.js';

// ---------- HTTP handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  const action = req.query.action;

  if (HC_PASSWORD_ACTIONS.has(action)) {
    if (!HC_URL() || !HC_KEY()) {
      const error = hcError('bridge_unconfigured');
      res.status(error.httpStatus).json({ ok: false, error: error.message, code: error.code });
      return;
    }

    let actor = null;
    if (HC_ADMIN_PASSWORD_ACTIONS.has(action)) {
      actor = await getHiveConnectAdmin(req);
      if (!actor) {
        const error = hcError('not_authorized');
        res.status(error.httpStatus).json({ ok: false, error: error.message, code: error.code });
        return;
      }
    }

    try {
      let result;
      if (action === 'redeem_invite') {
        result = await redeemHiveConnectInvite({
          token: req.body && req.body.token,
          displayName: req.body && req.body.displayName,
          username: req.body && req.body.username,
          email: req.body && req.body.email,
          password: req.body && req.body.password,
        });
      } else if (action === 'admin_create_user') {
        result = await provisionHiveConnectPasswordUser({
          email: req.body && req.body.email,
          displayName: req.body && req.body.displayName,
          username: req.body && req.body.username,
          role: req.body && req.body.role,
          channelIds: req.body && req.body.channelIds,
        }, actor);
      } else {
        result = await resetHiveConnectPassword(req.body && req.body.targetId, actor);
      }
      if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, ...result });
    } catch (error) {
      const safe = error && error.expose
        ? error
        : hcError('hiveconnect_auth_error', 'HiveConnect could not complete that account operation.', 502);
      logHiveConnectAuth(`${action}_failed`, {
        actorId: actor && actor.id,
        targetId: action === 'admin_reset_password' && req.body && HC_UUID_RE.test(String(req.body.targetId || '')) ? req.body.targetId : null,
        code: safe.code,
      });
      res.status(safe.httpStatus || 502).json({ ok: false, error: safe.message, code: safe.code });
    }
    return;
  }

  if (action === 'bot_provision' || action === 'bot_post' || action === 'list_channels') {
    if (!botSecretOk(req.body)) {
      res.status(403).json({ ok: false, error: 'Invalid or missing bot secret.' });
      return;
    }
    try {
      if (action === 'bot_provision') {
        const result = await provisionBotAccount((req.body || {}).channelId);
        res.status(200).json({ ok: true, ...result });
      } else if (action === 'bot_post') {
        const { channelId, text } = req.body || {};
        await postBotMessage(channelId, text);
        res.status(200).json({ ok: true });
      } else {
        const channels = await listBotChannels();
        res.status(200).json({ ok: true, channels });
      }
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message, code: e.code || 'bot_bridge_error' });
    }
    return;
  }

  // Team To-Do (2026-08-16): read active HiveConnect tasks / complete one.
  // Session-authenticated like action=session -- identity comes from the
  // verified Bearer token, never from the request body.
  if (action === 'tasks_list' || action === 'task_complete' || action === 'task_create') {
    const taskUser = await requireUser(req);
    if (!taskUser) {
      res.status(401).json({ ok: false, error: 'Not signed in.' });
      return;
    }
    if (!HC_URL() || !HC_KEY()) {
      res.status(503).json({ ok: false, error: 'HiveConnect is not configured on this deployment.', code: 'bridge_unconfigured' });
      return;
    }
    try {
      if (action === 'tasks_list') {
        const tasks = await listActiveTasks({}, { limit: (req.body || {}).limit });
        res.status(200).json({ ok: true, tasks, source: 'HiveConnect Tasks' });
        return;
      }
      // task_complete -- changed_by must be the caller's own HiveConnect
      // profile id, which is exactly what hiveconnect_account_map holds.
      const mapping = await getMapping(taskUser.id).catch(() => null);
      if (!mapping || !mapping.hiveconnect_user_id) {
        res.status(409).json({ ok: false, error: 'Your account is not linked to HiveConnect yet — open HiveConnect once, then try again.', code: 'not_mapped' });
        return;
      }
      if (action === 'task_create') {
        const made = await createTask(req.body || {}, mapping.hiveconnect_user_id);
        logMapping('task_create', taskUser.id, { taskId: made.id });
        res.status(200).json({ ok: true, task: made });
        return;
      }
      const result = await completeTask((req.body || {}).taskId, mapping.hiveconnect_user_id);
      logMapping('task_complete', taskUser.id, { taskId: result.id, historyWritten: result.historyWritten });
      res.status(200).json({ ok: true, task: result });
    } catch (e) {
      const code = e.code || 'task_bridge_error';
      res.status(['task_not_found', 'bad_task_id', 'bad_task_title'].indexOf(code) !== -1 ? 400 : (code === 'not_mapped' ? 409 : 502)).json({ ok: false, error: e.message, code });
    }
    return;
  }

  if (action !== 'session') {
    res.status(400).json({ ok: false, error: `Unknown action "${action}"` });
    return;
  }

  // P0 security (2026-07-29): identity MUST come from the caller's verified
  // Supabase session, NEVER from client-supplied body fields. Before this,
  // anyone could POST any {hivelogicUserId, hivelogicEmail} and be minted a
  // real HiveConnect session as that person (read/send their chats). Verify
  // the Bearer token and derive identity from it; body id/email are ignored.
  const authedUser = await requireUser(req);
  if (!authedUser) {
    res.status(401).json({ ok: false, error: 'Not signed in.' });
    return;
  }
  const hivelogicUserId = authedUser.id;
  const hivelogicEmail = authedUser.email;
  if (!hivelogicEmail) {
    res.status(400).json({ ok: false, error: 'Your account has no email on file; cannot open HiveConnect.' });
    return;
  }

  try {
    const session = await ensureMappedAndMint(hivelogicUserId, hivelogicEmail, {});
    // This endpoint NEVER touches HiveLogic's own session/cookies -- success
    // or failure here has zero effect on the caller's HiveLogic login.
    res.status(200).json({ ok: true, session });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, code: e.code || 'bridge_error' });
  }
}
