// api/_lib/ms-mailbox-tokens.js
//
// Minting a usable Microsoft Graph access token from a stored hc_ms_tokens row.
//
// WHY THIS EXISTS. There are two entirely separate Microsoft 365 credential
// stores in this repo, and until 2026-08-17 the Command Center read the wrong
// one:
//
//   integrations key='microsoft'  -- ONE shared org mailbox, connected through
//       /api/track1?resource=mailconnect using the MS_CLIENT_ID app. Nobody
//       ever completed that connect flow, so the row does not exist.
//
//   hc_ms_tokens                  -- ONE ROW PER PERSON PER MAILBOX, connected
//       through /api/msmail using the HiveConnect Email app registration
//       (CLIENT_ID below). This is what everyone actually uses: Chris has two
//       mailboxes in here, Jomell one, all refreshing normally.
//
// The Team To-Do "Emails awaiting reply" detection asked the first store and
// therefore always reported "Microsoft 365 is not connected" -- true about the
// store it asked, useless as a statement about anyone's mail. It now reads the
// caller's own hc_ms_tokens rows, which is the same place HiveConnect Email
// reads, so the two can never disagree about whether you have mail connected.
//
// WHY THE TOKEN LOGIC LIVES HERE rather than in each caller. Microsoft ROTATES
// refresh tokens: every refresh returns a new one and invalidates the old. Two
// copies of that logic drifting apart does not fail loudly -- it silently
// disconnects a mailbox and asks the user to re-authenticate. So the freshness
// margin, the rotation write-back and the encryption round-trip are defined
// once here, and both /api/msmail (the Email UI's token endpoint) and
// /api/track1 (the detection) go through it.
//
// The DB read/write stays with the callers, which each have their own Supabase
// idiom (msmail.js speaks to either realm; track1.js uses supabaseRequest).
// What is centralized is the part that breaks quietly.

// The HiveConnect Email app registration. Pinned, not read from MS_CLIENT_ID:
// that env var holds a DIFFERENT app's id (see api/msmail.js) and the tokens in
// hc_ms_tokens were issued to this one. Refreshing them against the wrong
// client id fails with AADSTS7000215.
export const MS_MAILBOX_CLIENT_ID = 'ff9bda24-d7e9-4905-a94e-f3ccc0239eb2';
export const MS_MAILBOX_SCOPES = 'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Tasks.ReadWrite';

// Refresh this far before actual expiry. A token that expires mid-request is
// indistinguishable from a revoked one at the Graph call site.
export const MS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function msMailboxTenant() { return (process.env.MS_TENANT || 'organizations').trim(); }
export function msMailboxRedirectUri() { return process.env.MS_REDIRECT_URI || 'https://hivelogic-live.vercel.app/api/msmail'; }
export function msMailboxTokenUrl() { return `https://login.microsoftonline.com/${msMailboxTenant()}/oauth2/v2.0/token`; }
function msMailboxClientSecret() { return (process.env.MS_CLIENT_SECRET || '').trim() || undefined; }

// The mailbox needs a human to sign in again -- distinct from "Microsoft is
// having a bad day", because only one of the two is worth telling the user
// about. Callers map this to a 401 and everything else to a 502.
export class MsMailboxReauthRequired extends Error {
  constructor(message, ms) {
    super(message);
    this.name = 'MsMailboxReauthRequired';
    this.reauth = true;
    if (ms) this.ms = ms;
  }
}

export async function exchangeMsMailboxToken(params) {
  const body = new URLSearchParams(Object.assign({
    client_id: MS_MAILBOX_CLIENT_ID,
    client_secret: msMailboxClientSecret(),
    redirect_uri: msMailboxRedirectUri(),
  }, params));
  const r = await fetch(msMailboxTokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return j;
  const message = j.error_description || j.error || `ms token ${r.status}`;
  // invalid_grant = the refresh token is spent, revoked, or the password
  // changed. interaction_required = MFA/conditional access wants the human.
  if (j.error === 'invalid_grant' || j.error === 'interaction_required') {
    throw new MsMailboxReauthRequired(message, j);
  }
  const e = new Error(message);
  e.ms = j;
  throw e;
}

// Returns a usable access token for one hc_ms_tokens row, refreshing first if
// the stored one is spent. `patchTokens(patch)` writes the refreshed values
// back to whichever project the row came from; omit it only for a caller that
// genuinely must not write (there is none today).
//
// Note the write-back is not optional in spirit: skipping it would leave the
// rotated refresh token unsaved and break the mailbox on the NEXT refresh.
export async function mailboxAccessToken(row, deps = {}) {
  const { decryptSecret, encryptSecret, patchTokens } = deps;
  const accessToken = decryptSecret ? decryptSecret(row.access_token) : row.access_token;
  const refreshToken = decryptSecret ? decryptSecret(row.refresh_token) : row.refresh_token;

  const expiresAtMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (accessToken && expiresAtMs - Date.now() > MS_TOKEN_REFRESH_MARGIN_MS) {
    return { accessToken, expiresAt: row.expires_at, refreshed: false };
  }
  if (!refreshToken) throw new MsMailboxReauthRequired('mailbox has no refresh token on file');

  const tok = await exchangeMsMailboxToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: MS_MAILBOX_SCOPES,
  });
  if (!tok.access_token) throw new MsMailboxReauthRequired('Microsoft returned no access token');

  const patch = {
    access_token: encryptSecret ? encryptSecret(tok.access_token) : tok.access_token,
    expires_at: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  // Microsoft rotates refresh tokens; the old one dies the moment this succeeds.
  if (tok.refresh_token) patch.refresh_token = encryptSecret ? encryptSecret(tok.refresh_token) : tok.refresh_token;
  if (patchTokens) await patchTokens(patch);

  return { accessToken: tok.access_token, expiresAt: patch.expires_at, refreshed: true, patch };
}
