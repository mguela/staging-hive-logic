// claude/_patch_p0_jobber_refresh_lock.cjs
// P0 FIX (2026-07-29): the Jobber sync has died twice (2026-07-16 and
// 2026-07-26) with "The provided refresh token is not valid" -- and NOT
// because rotation wasn't persisted. saveTokens() already stores the rotated
// refresh_token (it demonstrably worked: integrations.updated_at shows a
// successful refresh+save at 2026-07-26 10:49 UTC, 2h before the token died).
//
// The actual bug is a concurrency race. Jobber refresh tokens are SINGLE-USE,
// and four Vercel crons fire on the same */15 minute marks (sync-extended
// ?resource=vehicles and track1 ?resource=check_new_leads both talk to
// Jobber). When two serverless invocations hit getValidAccessToken() in the
// same expiring-soon window, both call Jobber's token endpoint with the SAME
// single-use refresh token; the second use trips Jobber's reuse detection and
// the whole grant dies. A refresh whose save step fails loses the rotated
// token the same way.
//
// Fix, all inside api/_lib/jobber.js:
//   1. Refresh lock: before refreshing, atomically claim the refresh via a
//      conditional PATCH on integrations.updated_at (only one invocation can
//      match the old value; timestamptz equality is value-based so the ISO
//      string PostgREST returned matches exactly). Losers poll the stored row
//      and use the winner's new access token instead of double-spending the
//      refresh token. If the winner crashes mid-refresh, losers time out with
//      a clear error and the NEXT invocation can claim again -- the refresh
//      token is never consumed twice.
//   2. saveTokens() now retries (3x, backoff) before giving up, so a
//      transient Supabase blip can't strand a just-rotated token pair.
//
// Idempotent: safe to run more than once; aborts untouched if anchors drift.
// Run from the repo root:  node claude/_patch_p0_jobber_refresh_lock.cjs

const fs = require('fs');
const path = require('path');

// Optional argv: a target repo root to patch (defaults to the repo this
// script lives in). Lets the script run from one clone against another
// (e.g. an isolated worktree). It self-installs into <root>/claude/ so the
// canonical copy always travels with the patched code.
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'api', '_lib', 'jobber.js');
const DONE_MARKER = 'Refresh lock (2026-07-29)';

const raw = fs.readFileSync(FILE, 'utf8');
const hadCRLF = raw.includes('\r\n');
let src = hadCRLF ? raw.replace(/\r\n/g, '\n') : raw;
if (src.includes(DONE_MARKER)) {
  console.log('SKIP (already patched): api/_lib/jobber.js');
  process.exit(0);
}

const edits = [];

// --- Edit 1: saveTokens gains retry ---------------------------------------
const SAVE_ANCHOR = `async function saveTokens(tokens) {
    const expiresInSeconds = Number.isFinite(tokens.expires_in) ? tokens.expires_in : 3600;
    const res = await supabaseRequest('integrations?on_conflict=key', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
            key: 'jobber',
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
            updated_at: new Date().toISOString(),
        }),
    });
    if (!res.ok) throw new Error(\`Failed to save refreshed Jobber tokens: \${await res.text()}\`);
}`;

const SAVE_REPLACEMENT = `async function saveTokens(tokens) {
    const expiresInSeconds = Number.isFinite(tokens.expires_in) ? tokens.expires_in : 3600;
    const body = JSON.stringify({
        key: 'jobber',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
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
    throw new Error(\`CRITICAL: Jobber tokens were rotated but could not be saved after 3 attempts (the stored refresh token is now stale -- reconnect at /api/jobber/connect if the next refresh fails): \${lastErr}\`);
}`;

edits.push({ anchor: SAVE_ANCHOR, replacement: SAVE_REPLACEMENT });

// --- Edit 2: getValidAccessToken gains the refresh lock --------------------
const GET_ANCHOR = `// Jobber access tokens last 60 minutes and refresh tokens rotate on every
// use, so every refresh must overwrite the stored refresh_token too.
export async function getValidAccessToken() {
    const stored = await getStoredTokens();
    const expiresAt = stored.expires_at ? new Date(stored.expires_at).getTime() : 0;
    const isExpiringSoon = !expiresAt || expiresAt - Date.now() < 2 * 60 * 1000;

if (!isExpiringSoon) return stored.access_token;

const refreshed = await refreshAccessToken(stored.refresh_token);
    await saveTokens(refreshed);
    return refreshed.access_token;
}`;

const GET_REPLACEMENT = `// Jobber access tokens last 60 minutes and refresh tokens rotate on every
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
        \`integrations?key=eq.jobber&updated_at=eq.\${encodeURIComponent(stored.updated_at)}\`,
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
}`;

edits.push({ anchor: GET_ANCHOR, replacement: GET_REPLACEMENT });

// --- Verify all anchors, then apply all-or-nothing -------------------------
const failures = [];
for (const e of edits) {
  const count = src.split(e.anchor).length - 1;
  if (count !== 1) failures.push(`anchor not found exactly once (found ${count}): ${e.anchor.slice(0, 80)}...`);
}
if (failures.length) {
  console.error('ABORTED -- api/_lib/jobber.js untouched. Anchor problems:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
for (const e of edits) src = src.replace(e.anchor, e.replacement);
fs.writeFileSync(FILE, hadCRLF ? src.replace(/\n/g, '\r\n') : src);
console.log('PATCHED: api/_lib/jobber.js');
console.log('Done.');

// Self-install the canonical copy next to the patched code.
const selfDest = path.join(ROOT, 'claude', '_patch_p0_jobber_refresh_lock.cjs');
if (path.resolve(__filename) !== selfDest) {
  fs.copyFileSync(__filename, selfDest);
  console.log('Installed script copy at claude/_patch_p0_jobber_refresh_lock.cjs');
}
