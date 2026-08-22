// api/tiktok/connect.js - Vercel serverless function
// Starts the TikTok Content Posting API OAuth flow (TikTok Login Kit v2).
// This is a SEPARATE app/flow from any TikTok Ads Marketing API connection
// (platform='tiktok' in ad_platform_connections) -- Content Posting uses its
// own developer app, client key/secret, and scopes. See the header of
// api/_lib/social-platform-tiktok.js and sql/059_organic_social_posting.sql
// for why this is platform='tiktok_content', a distinct row.
//
// Modeled directly on api/jobber/connect.js: same signed-in-only gate and
// single-use, user-bound OAuth state (api/_lib/oauth-state.js) protecting
// the callback from CSRF / authorization-code injection.
import { requireApiAuth } from '../_lib/guard.js';
import { issueOAuthState } from '../_lib/oauth-state.js';

const TIKTOK_CONTENT_SCOPES = 'user.info.basic,video.publish,video.upload';

export default async function handler(req, res) {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const redirectUri = process.env.TIKTOK_CONTENT_REDIRECT_URI || 'https://hivelogic-live.vercel.app/api/tiktok/callback';
  if (!clientKey) {
    return res.status(500).send('<h2>TIKTOK_CLIENT_KEY is not set for this deployment.</h2>');
  }

  // This endpoint STARTS the OAuth flow, so it must be initiated by a
  // signed-in employee -- same rule as every other connect.js in this repo.
  const gate = await requireApiAuth(req);
  if (!gate.ok) {
    return res.status(401).json({ ok: false, error: 'Sign in first — start the TikTok connection from inside HiveLogic.' });
  }

  const state = await issueOAuthState({ provider: 'tiktok_content', userId: gate.user && gate.user.id });
  const params = new URLSearchParams({
    client_key: clientKey,
    response_type: 'code',
    scope: TIKTOK_CONTENT_SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  const authorizeUrl = `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;

  // Dual-mode so an authenticated fetch caller can navigate the top window
  // itself (it can't follow a cross-origin 302), while a direct authed hit
  // still redirects.
  const accept = String(req.headers['accept'] || '');
  if (accept.includes('application/json')) {
    return res.status(200).json({ ok: true, url: authorizeUrl });
  }
  res.redirect(authorizeUrl);
}
