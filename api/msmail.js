// /api/msmail — server-side Microsoft 365 mail connection for HiveConnect.
//
// WHY THIS EXISTS: the old flow used MSAL in the browser (a "SPA" app).
// Microsoft caps browser refresh tokens at 24h, so mailboxes kept "dropping
// off" and asking to be reconnected. This route runs the OAuth code flow as a
// CONFIDENTIAL client instead: Microsoft gives us a ~90-day rolling refresh
// token, we store it server-side (HiveConnect Supabase, service-role only),
// and we mint fresh access tokens on demand. Result: connect once, stays
// connected — same model as the QBO + Jobber integrations in this repo
// (api/qbo/index.js `integrations` table pattern).
//
// Frontend counterpart: public/hiveconnect/mail-engine.js (an MSAL-shaped
// shim, so app.js needed zero changes).
//
// Actions (single route, Azure redirect URIs can't carry query strings so the
// bare /api/msmail URL doubles as the OAuth callback):
//   GET  ?action=health          -> {configured}
//   POST ?action=start           -> auth'd; returns {url} (our ?action=go bounce)
//   GET  ?action=go&state=...    -> 302 to Microsoft authorize (popup-friendly)
//   GET  ?code=...&state=...     -> OAuth callback; stores tokens; postMessage+close
//   POST ?action=accounts        -> auth'd; list connected mailboxes
//   POST ?action=token           -> auth'd; {homeAccountId} -> fresh access token
//   POST ?action=disconnect      -> auth'd; {homeAccountId} -> remove mailbox
//
// Required Vercel env: MS_CLIENT_SECRET (Azure app client secret),
// HIVECONNECT_SUPABASE_URL + HIVECONNECT_SUPABASE_SERVICE_KEY (already set for
// api/hiveconnect-bridge.js). Optional: MS_CLIENT_ID, MS_TENANT, MS_REDIRECT_URI.

const crypto = require('crypto');

// HiveConnect Email app registration. Not MS_CLIENT_ID -- that env var
// predates this route (added Jul 20 for an earlier attempt) and holds a
// different app's ID, which made Azure reject our secret (AADSTS7000215).
// MS_MAILBOX_CLIENT_ID lets a staging deployment point at its own Azure app
// registration (2026-08-28) without touching production's default. Must
// match public/hiveconnect/config.js msGraph.clientId for whichever
// deployment this is, and api/_lib/ms-mailbox-tokens.js's msMailboxClientId().
const CLIENT_ID = (process.env.MS_MAILBOX_CLIENT_ID || '').trim() || 'ff9bda24-d7e9-4905-a94e-f3ccc0239eb2';
const CLIENT_SECRET = (process.env.MS_CLIENT_SECRET || '').trim() || undefined;
const TENANT = (process.env.MS_TENANT || 'organizations').trim();
const REDIRECT_URI = process.env.MS_REDIRECT_URI || 'https://hivelogic-live.vercel.app/api/msmail';
const SCOPES = 'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Tasks.ReadWrite';

// Two auth "realms": HiveConnect standalone logins live in the hiveconnect
// Supabase project; the embedded app (inside HiveLogic, incl. the desktop app)
// authenticates with the MAIN project's session. /api/msmail accepts either,
// and stores tokens + mailbox links in the SAME project the caller belongs to,
// so app.js's hc_mailbox_links filter finds them in both modes.
const REALMS = {
  hc: { url: process.env.HIVECONNECT_SUPABASE_URL, key: process.env.HIVECONNECT_SUPABASE_SERVICE_KEY },
  main: { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY },
};

const AUTH_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

function configured() { return !!(CLIENT_SECRET && (REALMS.hc.url && REALMS.hc.key || REALMS.main.url && REALMS.main.key)); }

// ---------- tiny helpers ----------
function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64url(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
function hmac(s) { return crypto.createHmac('sha256', CLIENT_SECRET).update(s).digest('hex'); }

// Item 5 (2026-08-01): the state now carries a cryptographically-random nonce
// (was uid.realm.ts only — deterministic). Still HMAC-signed (unforgeable) and
// bound to the initiating user + 15-min window; the nonce makes it random and
// gives the callback a unique value to enforce single-use against.
function makeState(uid, realm) {
  const ts = Date.now().toString();
  const nonce = crypto.randomBytes(9).toString('hex');
  const payload = `${uid}.${realm}.${ts}.${nonce}`;
  return b64url(`${payload}.${hmac(payload)}`);
}
function readState(state) {
  try {
    const parts = unb64url(state).split('.');
    const sig = parts.pop();
    const [uid, realm, ts, nonce] = parts;
    if (!uid || !realm || !ts || !nonce || !sig || !REALMS[realm]) return null;
    if (hmac(`${uid}.${realm}.${ts}.${nonce}`) !== sig) return null;
    if (Date.now() - Number(ts) > 15 * 60 * 1000) return null; // 15 min window
    return { uid, realm, nonce };
  } catch (e) { return null; }
}

// Local HTML/JSON escapers for the callback page (this file is CommonJS, so it
// can't statically import the ESM oauth-state helpers; the single-use claim
// below uses a dynamic import()).
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function jsonForScript(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function decodeJwtPayload(jwt) {
  try { return JSON.parse(unb64url(jwt.split('.')[1])); } catch (e) { return {}; }
}

// ---------- Supabase (REST, service role, per realm) ----------
async function dbFetch(realm, path, opts = {}) {
  const R = REALMS[realm];
  const r = await fetch(R.url + path, {
    method: opts.method || 'GET',
    headers: Object.assign({
      apikey: R.key,
      Authorization: 'Bearer ' + R.key,
      'Content-Type': 'application/json',
    }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 204) return null;
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch (e) {}
  if (!r.ok) throw new Error(`supabase ${r.status}: ${text.slice(0, 200)}`);
  return j;
}

// Verify the caller's Supabase JWT against whichever project issued it
// (hiveconnect standalone, or the main app for embedded/desktop).
async function requireUser(req) {
  const auth = req.headers.authorization || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!jwt) return null;
  for (const realm of ['hc', 'main']) {
    const R = REALMS[realm];
    if (!R.url || !R.key) continue;
    try {
      const r = await fetch(R.url + '/auth/v1/user', {
        headers: { apikey: R.key, Authorization: 'Bearer ' + jwt },
      });
      if (!r.ok) continue;
      const u = await r.json().catch(() => null);
      if (u && u.id) return { uid: u.id, realm };
    } catch (e) {}
  }
  return null;
}

// ---------- Microsoft token exchange ----------
async function msToken(params) {
  const body = new URLSearchParams(Object.assign({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
  }, params));
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error_description || j.error || `ms token ${r.status}`); e.ms = j; throw e; }
  return j;
}

// hc_ms_tokens held refresh/access tokens in plaintext (2026-08-06 fix) --
// api/_lib/secrets.js already encrypts the main `integrations` table's
// Jobber/QBO/TikTok tokens the same way; this table was just missed when
// that rollout happened. Dynamic import because this file is CommonJS
// (module.exports below) and secrets.js is ESM -- same pattern this file
// already uses for _lib/oauth-state.js in the callback handler. Existing
// plaintext rows stay readable, but production writes now require the active
// TOKEN_ENC_KEY; refreshes write the key-addressable v2 envelope.
async function getSecretsLib() {
  return import('./_lib/secrets.js');
}

async function saveTokens(uid, realm, tok) {
  const claims = decodeJwtPayload(tok.id_token || '');
  const homeAccountId = claims.oid && claims.tid ? `${claims.oid}.${claims.tid}` : (claims.oid || claims.sub || 'unknown');
  const username = claims.preferred_username || claims.email || null;
  const name = claims.name || null;
  const { encryptSecret } = await getSecretsLib();
  const row = {
    owner_id: uid,
    home_account_id: homeAccountId,
    username, name,
    refresh_token: encryptSecret(tok.refresh_token),
    access_token: encryptSecret(tok.access_token),
    expires_at: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  await dbFetch(realm, '/rest/v1/hc_ms_tokens?on_conflict=owner_id,home_account_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: [row],
  });
  // Keep the existing mailbox-link table in sync so app.js's account filter
  // (hcOwnAccountIds) recognizes this mailbox without any frontend change.
  await dbFetch(realm, '/rest/v1/hc_mailbox_links?on_conflict=owner_id,ms_home_account_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: [{ owner_id: uid, ms_home_account_id: homeAccountId, ms_username: username }],
  });
  return { homeAccountId, username, name };
}

function accountShape(r) { return { homeAccountId: r.home_account_id, username: r.username, name: r.name }; }

// ---------- handler ----------
module.exports = async (req, res) => {
  const q = req.query || {};
  const action = q.action || (q.code ? 'callback' : (q.error ? 'callback' : 'health'));

  try {
    if (action === 'health') {
      return res.status(200).json({ configured: configured() });
    }

    if (action === 'diag') {
      // This route is globally reachable because the same endpoint hosts the
      // OAuth callback. Diagnostics are not public: require a real session
      // before making an upstream probe or returning configuration state.
      const who = await requireUser(req);
      if (!who) return res.status(401).json({ ok: false, error: 'Not signed in.' });
      // Validates the Azure client secret WITHOUT any user involvement
      // (client_credentials probe). Never returns the secret itself.
      if (!configured()) return res.status(200).json({ ok: false, why: 'not configured' });
      try {
        // Probe with a deliberately-bogus refresh token (same grant our real
        // flow uses). Azure checks the client secret FIRST:
        //   secret good  -> invalid_grant  (it got as far as the bogus token)
        //   secret bad   -> invalid_client (AADSTS7000215)
        const body = new URLSearchParams({
          client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
          grant_type: 'refresh_token', refresh_token: 'diag-probe',
          scope: 'openid',
        });
        const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
        const j = await r.json().catch(() => ({}));
        const secretBad = j.error === 'invalid_client';
        return res.status(200).json({
          ok: !secretBad, secretValid: !secretBad,
          msError: j.error || null,
          msCode: (String(j.error_description || '').match(/AADSTS\d+/) || [null])[0],
        });
      } catch (e) {
        return res.status(200).json({ ok: false, why: String(e.message).slice(0, 200) });
      }
    }

    if (!configured()) return res.status(503).json({ error: 'msmail not configured (missing MS_CLIENT_SECRET or HiveConnect Supabase env)' });

    if (action === 'start') {
      const who = await requireUser(req);
      if (!who) return res.status(401).json({ error: 'not signed in' });
      const state = makeState(who.uid, who.realm);
      return res.status(200).json({ url: `/api/msmail?action=go&state=${encodeURIComponent(state)}` });
    }

    if (action === 'go') {
      // Popup opens THIS same-origin URL (works in browser + both desktop app
      // versions), then we bounce to Microsoft.
      if (!readState(q.state || '')) return res.status(400).send('Sign-in link expired — close this window and try again.');
      const u = new URL(AUTH_URL);
      u.searchParams.set('client_id', CLIENT_ID);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('redirect_uri', REDIRECT_URI);
      u.searchParams.set('response_mode', 'query');
      u.searchParams.set('scope', SCOPES);
      u.searchParams.set('state', q.state);
      u.searchParams.set('prompt', 'select_account');
      res.statusCode = 302;
      res.setHeader('Location', u.toString());
      return res.end();
    }

    if (action === 'callback') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const fail = (msg) => res.status(200).send(
        `<!doctype html><body style="font-family:sans-serif;padding:24px"><b>Could not connect the mailbox.</b><br>${msg}<br><br>You can close this window and try again.</body>`);
      if (q.error) return fail(escHtml(String(q.error_description || q.error)));
      const who = readState(q.state || '');
      if (!who) return fail('The sign-in link expired.');
      // Item 5: single-use. Claim the state's hash exactly once; a replayed
      // state (same code delivered twice) is rejected. Fails open on a store
      // error so a DB blip can't sever mailbox connections.
      try {
        const { claimOAuthStateOnce, hashState } = await import('./_lib/oauth-state.js');
        const claim = await claimOAuthStateOnce({ provider: 'msmail', stateHash: hashState(q.state) });
        if (!claim.ok) return fail('This sign-in link was already used — please reconnect the mailbox.');
      } catch (e) { /* fail open: signature + expiry still protect the state */ }
      const tok = await msToken({ grant_type: 'authorization_code', code: q.code });
      const account = await saveTokens(who.uid, who.realm, tok);
      // Item 5: postMessage now targets the EXACT app origin (was '*').
      // BroadcastChannel remains the cross-context fallback (survives COOP).
      const APP_ORIGIN = (() => { try { return new URL(REDIRECT_URI).origin; } catch (e) { return ''; } })();
      return res.status(200).send(
        `<!doctype html><body style="font-family:sans-serif;padding:24px">✅ <b>${escHtml(account.username || 'Mailbox')}</b> connected.` +
        `<script>var m={type:'hc-ms-connected',account:${jsonForScript(account)}};` +
        `try{new BroadcastChannel('hc-ms-auth').postMessage(m)}catch(e){};` +
        `try{window.opener&&window.opener.postMessage(m,${JSON.stringify(APP_ORIGIN)})}catch(e){};` +
        `setTimeout(function(){window.close()},400);</script></body>`);
    }

    // Everything below requires a signed-in user (either realm).
    const who = await requireUser(req);
    if (!who) return res.status(401).json({ error: 'not signed in' });
    const uid = who.uid, realm = who.realm;

    if (action === 'accounts') {
      const rows = await dbFetch(realm, `/rest/v1/hc_ms_tokens?owner_id=eq.${uid}&select=home_account_id,username,name`) || [];
      return res.status(200).json({ accounts: rows.map(accountShape) });
    }

    if (action === 'token') {
      const body = typeof req.body === 'object' && req.body ? req.body : {};
      const id = body.homeAccountId;
      const filter = id ? `&home_account_id=eq.${encodeURIComponent(id)}` : '';
      const rows = await dbFetch(realm, `/rest/v1/hc_ms_tokens?owner_id=eq.${uid}${filter}&select=*&limit=1`) || [];
      const row = rows[0];
      if (!row) return res.status(404).json({ error: 'mailbox not connected' });

      // Freshness check, refresh, rotation write-back and encryption all live
      // in _lib/ms-mailbox-tokens.js so that /api/track1's "Emails awaiting
      // reply" detection -- which reads these same rows -- cannot drift from
      // this path. Microsoft rotates refresh tokens, and two copies of that
      // logic disagreeing does not fail loudly: it quietly disconnects the
      // mailbox. Dynamic import because this file is CommonJS.
      const { encryptSecret, decryptSecret } = await getSecretsLib();
      const { mailboxAccessToken } = await import('./_lib/ms-mailbox-tokens.js');
      let minted;
      try {
        minted = await mailboxAccessToken(row, {
          encryptSecret,
          decryptSecret,
          patchTokens: (patch) => dbFetch(realm, `/rest/v1/hc_ms_tokens?owner_id=eq.${uid}&home_account_id=eq.${encodeURIComponent(row.home_account_id)}`, {
            method: 'PATCH', body: patch,
          }),
        });
      } catch (e) {
        const code = e.reauth || (e.ms && (e.ms.error === 'invalid_grant' || e.ms.error === 'interaction_required')) ? 401 : 502;
        return res.status(code).json({ error: 'reauth required', detail: String(e.message).slice(0, 300) });
      }
      return res.status(200).json({ accessToken: minted.accessToken, expiresAt: minted.expiresAt, account: accountShape(row) });
    }

    if (action === 'disconnect') {
      const body = typeof req.body === 'object' && req.body ? req.body : {};
      const id = body.homeAccountId;
      if (!id) return res.status(400).json({ error: 'homeAccountId required' });
      await dbFetch(realm, `/rest/v1/hc_ms_tokens?owner_id=eq.${uid}&home_account_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      await dbFetch(realm, `/rest/v1/hc_mailbox_links?owner_id=eq.${uid}&ms_home_account_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
};
