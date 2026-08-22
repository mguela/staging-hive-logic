// api/_lib/oauth-state.js
// Single-use, short-lived, optionally user-bound OAuth `state` tokens
// (2026-08-01, Item 5). Every OAuth flow in this repo (Jobber, QuickBooks,
// Microsoft) either used a STATIC state ("hivelogic-live") or no state check
// at all, so the callbacks were open to CSRF / authorization-code injection:
// an attacker could get an admin's browser to complete a flow that connects
// the ATTACKER's account (or replays a stolen code).
//
// The fix: connect issues a cryptographically-random state, stored server-side
// as a SHA-256 hash with a short expiry and (where the initiator is signed in)
// the initiating user's id. The callback CONSUMES it: it must exist, be
// unexpired, and be unused — and the consume is atomic (a conditional PATCH on
// used_at IS NULL) so a replayed state loses the race and is rejected.
//
// Backed by the oauth_states table (sql/047_oauth_states.sql), service-role
// only. Dependency-injectable for tests.

import crypto from 'node:crypto';
import { supabaseRequest as defaultSupabaseRequest } from './jobber.js';

export function genOAuthState(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function hashState(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

async function sbJson(sb, path, options) {
  const res = await sb(path, options);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`oauth_states supabase error on ${path}: ${res.status} ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Issue a fresh state, persist its hash, return the RAW state for the redirect.
export async function issueOAuthState({ provider, userId = null, ttlMs = 10 * 60 * 1000, deps } = {}) {
  const sb = (deps && deps.supabaseRequest) || defaultSupabaseRequest;
  const raw = genOAuthState();
  await sbJson(sb, 'oauth_states', {
    method: 'POST',
    body: JSON.stringify({
      provider,
      state_hash: hashState(raw),
      user_id: userId || null,
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
    }),
  });
  return raw;
}

// Consume a state exactly once. Returns { ok, userId, reason }.
//   reason ∈ 'missing' | 'unknown' | 'expired' | 'reused'
export async function consumeOAuthState({ provider, state, deps } = {}) {
  const sb = (deps && deps.supabaseRequest) || defaultSupabaseRequest;
  if (!state) return { ok: false, reason: 'missing' };
  const h = hashState(state);
  const rows = await sbJson(sb, `oauth_states?provider=eq.${encodeURIComponent(provider)}&state_hash=eq.${encodeURIComponent(h)}&select=*`);
  const row = rows && rows[0];
  if (!row) return { ok: false, reason: 'unknown' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (row.used_at) return { ok: false, reason: 'reused' };
  // Atomic single-use: only the request that flips used_at from NULL wins.
  const patched = await sbJson(sb, `oauth_states?id=eq.${row.id}&used_at=is.null`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ used_at: new Date().toISOString() }),
  });
  if (!patched || !patched.length) return { ok: false, reason: 'reused' };
  return { ok: true, userId: row.user_id, reason: null };
}

// Claim a state hash exactly once by INSERTing it (used_at set). A duplicate
// insert conflicts on the unique (provider, state_hash) index -> already used.
// For flows (msmail) whose state is self-contained (HMAC-signed) rather than
// issued-then-consumed. Fails OPEN on a store error so a DB blip can't sever
// mailbox connections — the state's signature + expiry still protect it.
export async function claimOAuthStateOnce({ provider, stateHash, deps } = {}) {
  const sb = (deps && deps.supabaseRequest) || defaultSupabaseRequest;
  try {
    const res = await sb('oauth_states', {
      method: 'POST',
      body: JSON.stringify({
        provider,
        state_hash: stateHash,
        used_at: new Date().toISOString(),
        expires_at: new Date().toISOString(),
      }),
    });
    if (res.status === 409) return { ok: false, reason: 'reused' };
    return { ok: true, reason: res.ok ? null : 'store-error-open' };
  } catch (e) {
    return { ok: true, reason: 'store-exception-open' };
  }
}

// Escape untrusted text for interpolation into an HTML callback page.
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escape a value that will sit inside a <script> tag as JSON. Neutralizes the
// only sequences that can break OUT of a script/JSON string context.
export function escapeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}
