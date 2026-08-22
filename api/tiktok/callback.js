// api/tiktok/callback.js — Vercel serverless function
// Handles TikTok's OAuth redirect for the Content Posting API: exchanges the
// one-time authorization code for an access token + refresh token, then
// stores both (encrypted) in Supabase and flips the connection straight to
// launch_enabled. Automatic refresh (api/_lib/tiktok-token.js) keeps the
// access token current from here on, so there is no manual token-copying
// step and nothing for Chris to do once TikTok redirects back here.
import { consumeOAuthState } from '../_lib/oauth-state.js';
import { saveTikTokTokens } from '../_lib/tiktok-token.js';

const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';

export default async function handler(req, res) {
  const { code, error, state } = req.query;

  if (error) {
    return res.redirect(`/?tiktok_error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return res.status(400).send('Missing authorization code from TikTok.');
  }

  const stateCheck = await consumeOAuthState({ provider: 'tiktok_content', state });
  if (!stateCheck.ok) {
    return res.redirect(`/?tiktok_error=${encodeURIComponent('invalid_state_' + stateCheck.reason)}`);
  }

  try {
    const redirectUri = process.env.TIKTOK_CONTENT_REDIRECT_URI || 'https://hivelogic-live.vercel.app/api/tiktok/callback';
    const tokenRes = await fetch(TIKTOK_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body: new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        code: decodeURIComponent(code),
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    const tokens = await tokenRes.json();

    if (!tokenRes.ok || !tokens.access_token) {
      console.error('TikTok token exchange failed:', tokens);
      return res.redirect('/?tiktok_error=token_exchange_failed');
    }

    // Persist the real tokens (encrypted) so getValidTikTokAccessToken() can
    // read and auto-refresh them from here on -- see api/_lib/tiktok-token.js.
    try {
      await saveTikTokTokens(tokens);
    } catch (saveErr) {
      console.error('TikTok token save failed:', saveErr);
      return res.redirect('/?tiktok_error=' + encodeURIComponent('token_storage_failed: ' + saveErr.message));
    }

    // Record real connection-state metadata (no secrets) so the Connect
    // Everything UI reflects reality. state goes straight to launch_enabled
    // -- tokens are stored and auto-refreshing, so posting works immediately
    // with nothing left for Chris to configure by hand.
    try {
      const upsertRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/ad_platform_connections?on_conflict=tenant_id,platform`,
        {
          method: 'POST',
          headers: {
            apikey: process.env.SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates',
          },
          body: JSON.stringify({
            tenant_id: 'ghgrp',
            platform: 'tiktok_content',
            env_var_name: 'TIKTOK_CONTENT_ACCESS_TOKEN',
            state: 'launch_enabled',
            scopes: (tokens.scope || '').split(',').filter(Boolean),
            last_error: null,
            updated_at: new Date().toISOString(),
          }),
        }
      );
      if (!upsertRes.ok) {
        console.error('Supabase ad_platform_connections upsert failed:', await upsertRes.text());
      }
    } catch (upsertErr) {
      console.error('Supabase ad_platform_connections upsert threw:', upsertErr);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TikTok connected — HiveLogic</title>
<style>
  body{font-family:'Segoe UI',Arial,sans-serif;background:#faf7f0;margin:0;padding:48px 22px;color:#12213f;line-height:1.6}
  .card{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e7e2d6;border-radius:12px;padding:32px}
  h1{font-size:22px;margin-top:0}
  .warn{background:#eefaf0;border:1px solid #b9e6c2;border-radius:8px;padding:12px 14px;font-size:13.5px;margin-top:22px}
</style></head>
<body><div class="card">
<h1>TikTok connected ✓</h1>
<p>HiveLogic can now post to this TikTok account. Tokens are stored securely and refresh automatically -- nothing to copy, nothing to redeploy, nothing to do here again unless you disconnect and reconnect.</p>
<div class="warn">Access token expires every 24 hours; HiveLogic renews it automatically before that happens. If posting ever stops working, reconnect at /api/tiktok/connect.</div>
</div></body></html>`);
  } catch (err) {
    console.error('TikTok callback error:', err);
    return res.redirect('/?tiktok_error=unexpected');
  }
}
