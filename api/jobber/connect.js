// api/jobber/connect.js - Vercel serverless function
// NEW, additive-only file -- does not touch sync.js/callback.js/_lib/jobber.js.
//
// Production never had a route that actually STARTS the Jobber OAuth flow --
// only callback.js (which RECEIVES it) existed. That was fine as long as the
// original token pair kept refreshing itself, but as of 2026-07-16 the shared
// Jobber token started failing with a non-JSON "The provided..." error on
// every refresh attempt (confirmed via Vercel's own logs -- both the new
// sync-extended endpoint AND the original, already-working
// /api/jobber/sync?resource=clients hit the identical error, so this is not
// something built tonight broke; the stored refresh token itself needs to be
// replaced). Visiting this route re-authorizes with Jobber and callback.js
// stores the new token pair, exactly like the original one-time setup did.
import { requireApiAuth } from '../_lib/guard.js';
import { issueOAuthState } from '../_lib/oauth-state.js';
import { supabaseRequest } from '../_lib/jobber.js';

export default async function handler(req, res) {
  const clientId = process.env.JOBBER_CLIENT_ID;
  const redirectUri = process.env.JOBBER_REDIRECT_URI || 'https://hivelogic-live.vercel.app/api/jobber/callback';
  if (!clientId) {
    return res.status(500).send('<h2>JOBBER_CLIENT_ID is not set for this deployment.</h2>');
  }

  // Item 5 (2026-08-01): this endpoint STARTS the OAuth flow, so it must be
  // initiated by a signed-in employee (the global /api middleware already
  // gates it — only authenticated callers get here). The state is now a
  // random, single-use, 10-minute token BOUND to that user, replacing the old
  // static state:'hivelogic-live' that made the callback trivially CSRF-able.
  const gate = await requireApiAuth(req);
  if (!gate.ok) {
    return res.status(401).json({ ok: false, error: 'Sign in first — start the Jobber connection from inside HiveLogic.' });
  }

  // ?status=1: real connection-health check for the Settings panel's Jobber
  // row (added alongside the Reconnect button). Reads only updated_at/
  // expires_at off the integrations row -- never the token values themselves.
  // No token row at all = never connected; present but expired is still
  // reported as "connected" (Jobber refresh handles that silently) with its
  // real last-refreshed time, never invented.
  if (req.query.status === '1') {
    try {
      const r = await supabaseRequest('integrations?key=eq.jobber&select=updated_at,expires_at');
      if (!r.ok) return res.status(502).json({ ok: false, error: 'Could not read the Jobber connection state: ' + (await r.text()) });
      const rows = await r.json();
      const row = rows && rows[0];
      return res.status(200).json({
        ok: true,
        connected: !!row,
        updatedAt: row ? row.updated_at : null,
        expiresAt: row ? row.expires_at : null,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
    }
  }

  const state = await issueOAuthState({ provider: 'jobber', userId: gate.user && gate.user.id });
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  });
  const authorizeUrl = `https://api.getjobber.com/api/oauth/authorize?${params.toString()}`;

  // Dual-mode so an authenticated fetch caller can navigate the top window
  // itself (it can't follow a cross-origin 302), while a direct authed hit
  // still redirects.
  const accept = String(req.headers['accept'] || '');
  if (accept.includes('application/json')) {
    return res.status(200).json({ ok: true, url: authorizeUrl });
  }
  res.redirect(authorizeUrl);
}
