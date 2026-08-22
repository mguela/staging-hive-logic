// api/_lib/tiktok-token.js
// Keeps TikTok Content Posting API tokens fresh automatically, mirroring
// api/_lib/jobber.js's getValidAccessToken() claim-lock pattern.
//
// Real tokens are encrypted and stored in the generic Supabase
// `integrations` table (key='tiktok_content') -- the SAME table Jobber and
// QuickBooks already use, and the SAME encryptSecret/decryptSecret helpers.
// This is a deliberate departure from ad_platform_connections' "env var
// only, never a token in this database" convention (see sql/058's header):
// that convention works for platforms whose tokens are long-lived and set
// once by hand, but TikTok's access token expires every 24 hours, so a
// static Vercel env var goes stale in a day with nobody to refresh it.
// Automatic refresh needs a place to atomically read-and-write the current
// token, which is exactly what `integrations` already provides for Jobber.
//
// ad_platform_connections.platform='tiktok_content' still exists and still
// gates whether publishing is allowed (its `state` column), same as every
// other surface -- this file only changes where the actual bearer token
// comes from.
import { supabaseRequest } from './jobber.js';
import { encryptSecret, decryptSecret } from './secrets.js';

const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const INTEGRATION_KEY = 'tiktok_content';

async function getStoredTokens() {
  const res = await supabaseRequest(`integrations?key=eq.${INTEGRATION_KEY}&select=*`);
  if (!res.ok) throw new Error(`Failed to read stored TikTok tokens: ${await res.text()}`);
  const rows = await res.json();
  if (!rows.length) return null;
  const row = rows[0];
  row.access_token = decryptSecret(row.access_token);
  row.refresh_token = decryptSecret(row.refresh_token);
  return row;
}

// Called once by api/tiktok/callback.js right after the OAuth code exchange,
// and again by getValidTikTokAccessToken() every time it refreshes.
export async function saveTikTokTokens(tokens) {
  const expiresInSeconds = Number.isFinite(tokens.expires_in) ? tokens.expires_in : 86400;
  const body = JSON.stringify({
    key: INTEGRATION_KEY,
    access_token: encryptSecret(tokens.access_token),
    refresh_token: encryptSecret(tokens.refresh_token || ''),
    expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  });
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await supabaseRequest('integrations?on_conflict=key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body,
    });
    if (res.ok) return;
    lastErr = await res.text();
    if (attempt < 3) await sleep(500 * attempt);
  }
  throw new Error(`CRITICAL: TikTok tokens could not be saved after 3 attempts (reconnect at /api/tiktok/connect if posting starts failing): ${lastErr}`);
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const raw = await res.text();
  let tokens = null;
  try { tokens = JSON.parse(raw); } catch (e) { tokens = null; }
  if (!res.ok || !tokens || !tokens.access_token) {
    throw new Error(/invalid|expired|revoked/i.test(raw)
      ? 'TikTok authorization expired or was revoked -- reconnect at /api/tiktok/connect'
      : `TikTok token refresh failed (HTTP ${res.status}): ${String(raw).slice(0, 200)}`);
  }
  return tokens;
}

// Claim lock (same reasoning as jobber.js): the */15 min process_scheduled_posts
// cron and a manual publish click could both see an expiring token at once.
// Whichever invocation wins the conditional PATCH on integrations.updated_at
// does the real refresh; everyone else polls the row for the winner's result
// instead of racing TikTok's token endpoint twice.
export async function getValidTikTokAccessToken() {
  const stored = await getStoredTokens();
  if (!stored) {
    throw new Error('No TikTok connection found -- connect it at /api/tiktok/connect first.');
  }
  const expiresAt = stored.expires_at ? new Date(stored.expires_at).getTime() : 0;
  const isExpiringSoon = !expiresAt || expiresAt - Date.now() < 2 * 60 * 1000;

  if (!isExpiringSoon) return stored.access_token;

  const claimRes = await supabaseRequest(
    `integrations?key=eq.${INTEGRATION_KEY}&updated_at=eq.${encodeURIComponent(stored.updated_at)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ updated_at: new Date().toISOString() }),
    }
  );
  const claimedRows = claimRes.ok ? await claimRes.json() : [];

  if (!claimedRows.length) {
    for (let i = 0; i < 10; i++) {
      await sleep(1500);
      const latest = await getStoredTokens();
      const latestExpiresAt = latest && latest.expires_at ? new Date(latest.expires_at).getTime() : 0;
      const latestIsFresh = latestExpiresAt && latestExpiresAt - Date.now() >= 2 * 60 * 1000;
      if (latestIsFresh || (latest && latest.access_token !== stored.access_token)) {
        return latest.access_token;
      }
    }
    throw new Error('TikTok token refresh: another invocation claimed the refresh but no new token appeared within 15s.');
  }

  const refreshed = await refreshAccessToken(stored.refresh_token);
  await saveTikTokTokens(refreshed);
  return refreshed.access_token;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
