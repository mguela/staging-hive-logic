// api/_lib/jobber.js
// Shared helpers for talking to Jobber's GraphQL API and for keeping the
// stored OAuth tokens fresh. Every endpoint that needs Jobber data should
// import jobberGraphQL from here instead of calling the API directly.

import { encryptSecret, decryptSecret } from './secrets.js';

const JOBBER_API_VERSION = '2025-04-16';
const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const JOBBER_TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';

export async function supabaseRequest(path, options = {}) {
    return fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
        ...options,
        headers: {
            apikey: process.env.SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            ...options.headers,
        },
    });
}

async function getStoredTokens() {
    const res = await supabaseRequest('integrations?key=eq.jobber&select=*');
    if (!res.ok) throw new Error(`Failed to read stored Jobber tokens: ${await res.text()}`);
    const rows = await res.json();
    if (!rows.length) throw new Error('No Jobber connection found. Reconnect Jobber first.');
    const row = rows[0];
    if (row) { row.access_token = decryptSecret(row.access_token); row.refresh_token = decryptSecret(row.refresh_token); }
    return row;
}

async function saveTokens(tokens) {
    const expiresInSeconds = Number.isFinite(tokens.expires_in) ? tokens.expires_in : 3600;
    const body = JSON.stringify({
        key: 'jobber',
        access_token: encryptSecret(tokens.access_token),
        refresh_token: encryptSecret(tokens.refresh_token),
        expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
        updated_at: new Date().toISOString(),
    });
    // Retry the save (2026-07-29): Jobber refresh tokens are single-use, so a
    // rotated pair that never reaches the database is lost forever and kills
    // the whole connection (the next refresh replays a consumed token). A
    // transient Supabase error here must not strand the new pair -- retry
    // before giving up, and make the final failure loud and specific.
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
    throw new Error(`CRITICAL: Jobber tokens were rotated but could not be saved after 3 attempts (the stored refresh token is now stale -- reconnect at /api/jobber/connect if the next refresh fails): ${lastErr}`);
}

async function refreshAccessToken(refreshToken) {
    const res = await fetch(JOBBER_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: process.env.JOBBER_CLIENT_ID,
            client_secret: process.env.JOBBER_CLIENT_SECRET,
        }),
    });
    const raw = await res.text(); let tokens = null; try { tokens = JSON.parse(raw); } catch (e) { tokens = null; }
    if (!res.ok || !tokens || !tokens.access_token) {
        throw new Error(/invalid|expired|revoked|grant/i.test(raw) ? 'Jobber authorization expired or was revoked \u2014 reconnect at /api/jobber/connect' : ('Jobber token refresh failed (HTTP ' + res.status + '): ' + String(raw).slice(0, 200)));
    }
    return tokens;
}

// Jobber access tokens last 60 minutes and refresh tokens rotate on every
// use, so every refresh must overwrite the stored refresh_token too.
//
// Refresh lock (2026-07-29): refresh tokens are also SINGLE-USE, and several
// Vercel crons fire on the same */15 minute marks -- two serverless
// invocations that both find the token expiring would both spend the same
// refresh token, and Jobber's reuse detection then kills the whole grant
// (this is what took the sync down on 2026-07-16 and again on 2026-07-26).
// Before refreshing, atomically claim the refresh with a conditional PATCH
// on integrations.updated_at: exactly one invocation can match the old
// value. Everyone else polls the stored row and uses the winner's new
// access token instead. If the winner dies mid-refresh the losers time out
// loudly and the next invocation claims again -- at no point can the same
// refresh token be sent to Jobber twice.
export async function getValidAccessToken() {
    const stored = await getStoredTokens();
    const expiresAt = stored.expires_at ? new Date(stored.expires_at).getTime() : 0;
    const isExpiringSoon = !expiresAt || expiresAt - Date.now() < 2 * 60 * 1000;

if (!isExpiringSoon) return stored.access_token;

const claimRes = await supabaseRequest(
        `integrations?key=eq.jobber&updated_at=eq.${encodeURIComponent(stored.updated_at)}`,
        {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ updated_at: new Date().toISOString() }),
        }
    );
    const claimedRows = claimRes.ok ? await claimRes.json() : [];

if (!claimedRows.length) {
        // Another invocation holds the refresh. Wait for its saved result.
        for (let i = 0; i < 10; i++) {
            await sleep(1500);
            const latest = await getStoredTokens();
            const latestExpiresAt = latest.expires_at ? new Date(latest.expires_at).getTime() : 0;
            const latestIsFresh = latestExpiresAt && latestExpiresAt - Date.now() >= 2 * 60 * 1000;
            if (latestIsFresh || latest.access_token !== stored.access_token) {
                return latest.access_token;
            }
        }
        throw new Error('Jobber token refresh: another invocation claimed the refresh but no new token appeared within 15s. Not retrying with the same single-use refresh token; the next scheduled run will refresh normally.');
    }

const refreshed = await refreshAccessToken(stored.refresh_token);
    await saveTokens(refreshed);
    return refreshed.access_token;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Jobber uses a query-cost rate limiter (leaky bucket). When a query is
// throttled, the response tells us how many points are available and how
// fast they refill, so we wait exactly long enough and retry automatically
// instead of failing the whole sync.
export async function jobberGraphQL(query, variables = {}, retriesLeft = 4) {
    const accessToken = await getValidAccessToken();
    const res = await fetch(JOBBER_GRAPHQL_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `bearer ${accessToken}`,
            'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION,
        },
        body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();

const isThrottled = Array.isArray(json.errors) && json.errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED');

if (isThrottled && retriesLeft > 0) {
    const cost = json.extensions && json.extensions.cost;
    const throttleStatus = cost && cost.throttleStatus;
    const restoreRate = (throttleStatus && throttleStatus.restoreRate) || 500;
    const currentlyAvailable = (throttleStatus && throttleStatus.currentlyAvailable) || 0;
    const requestedCost = (cost && cost.requestedQueryCost) || restoreRate;
    const deficit = Math.max(requestedCost - currentlyAvailable, restoreRate);
    const waitMs = Math.min(Math.ceil((deficit / restoreRate) * 1000) + 750, 25000);
    await sleep(waitMs);
    return jobberGraphQL(query, variables, retriesLeft - 1);
}

if (!res.ok || json.errors) {
    throw new Error(`Jobber GraphQL error: ${JSON.stringify(json.errors || json)}`);
}
    return json.data;
}
