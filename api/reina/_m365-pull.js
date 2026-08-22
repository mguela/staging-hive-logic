// api/reina/_m365-pull.js
//
// Reina M1a v0.2 — pull the client's message from Microsoft 365 instead of a
// pasted string. This is the real thing behind the v0.1 seam: given the
// client's email, find the most recent message they sent to the operator's
// connected mailbox and return its text as `request_text` for the observe
// pipeline. Everything downstream (summarize + one approvals row) is unchanged.
//
// OWNERSHIP MODEL (important): M365 tokens are OWNER-SCOPED — they belong to
// the signed-in operator who connected their mailbox (see api/msmail.js,
// `hc_ms_tokens` keyed by owner_id). So this searches the OPERATOR's mailbox
// for mail FROM the client. It does not, and cannot, read a mailbox the
// operator hasn't connected.
//
// TOKENS: we never mint or refresh Microsoft tokens here. Refresh tokens are
// single-use and rotate; duplicating that logic risks the exact double-spend
// bug the Jobber/QBO integrations warn about. Instead we call the existing
// /api/msmail?action=token endpoint (the single source of refresh truth),
// forwarding the caller's Authorization header. `getToken` is injectable so
// tests never touch the network.

// Strip an HTML (or plain) mail body down to readable text. Deliberately small
// and dependency-free: drop scripts/styles, turn block-ish tags into newlines,
// unescape the handful of entities that actually show up, collapse whitespace.
export function htmlToText(input) {
  let s = String(input || '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n');
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&#39;|&apos;/gi, "'");
  s = s.replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// Default token getter: reuse /api/msmail?action=token so refresh stays in one
// place. Derives the deployment origin from the incoming request host.
async function defaultGetToken({ authHeader, host, homeAccountId, fetchImpl }) {
  const f = fetchImpl || fetch;
  if (!host) throw new Error('cannot resolve deployment host to reach /api/msmail');
  const res = await f(`https://${host}/api/msmail?action=token`, {
    method: 'POST',
    headers: { Authorization: authHeader || '', 'Content-Type': 'application/json' },
    body: JSON.stringify(homeAccountId ? { homeAccountId } : {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(j.error || `msmail token ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return j.accessToken || null;
}

// Build the Graph query. `$filter` on the sender address is deterministic
// (more reliable than `$search`, which needs eventual-consistency headers).
export function buildMessagesUrl(clientEmail, { top = 1 } = {}) {
  const safe = String(clientEmail).replace(/'/g, "''"); // OData single-quote escape
  const filter = `from/emailAddress/address eq '${safe}'`;
  return 'https://graph.microsoft.com/v1.0/me/messages'
    + `?$filter=${encodeURIComponent(filter)}`
    + '&$select=subject,receivedDateTime,bodyPreview,body,from'
    + '&$orderby=receivedDateTime%20desc'
    + `&$top=${top}`;
}

// Returns { ok, requestText?, meta?, error?, status? }. Never throws for the
// expected "no mailbox / no message" cases — the caller maps them to a clean
// response. `getToken` and `fetchImpl` are injectable for tests.
export async function pullClientMessageFromGraph(
  { clientEmail, authHeader, host, homeAccountId },
  deps = {},
) {
  const getToken = deps.getToken || defaultGetToken;
  const graphFetch = deps.fetchImpl || fetch;
  const email = String(clientEmail || '').trim();
  if (!email) return { ok: false, error: 'No client email on file to search the mailbox for.' };

  let token;
  try {
    token = await getToken({ authHeader, host, homeAccountId, fetchImpl: deps.fetchImpl });
  } catch (e) {
    const reauth = e.status === 401;
    return { ok: false, error: reauth ? 'The connected M365 mailbox needs to be reconnected.' : `Could not get a mailbox token: ${e.message}`, status: e.status || 502 };
  }
  if (!token) return { ok: false, error: 'No connected M365 mailbox for this operator.', status: 404 };

  let res;
  try {
    res = await graphFetch(buildMessagesUrl(email), { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    return { ok: false, error: `Microsoft Graph request failed: ${e.message}`, status: 502 };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `Microsoft Graph returned ${res.status}: ${String(detail).slice(0, 200)}`, status: 502 };
  }
  const j = await res.json().catch(() => ({}));
  const msg = (j.value || [])[0];
  if (!msg) return { ok: false, error: `No email found from ${email} in the connected mailbox.`, status: 404 };

  const body = msg.body || {};
  const raw = body.contentType && /html/i.test(body.contentType) ? body.content : (body.content || msg.bodyPreview || '');
  const requestText = htmlToText(raw);
  if (!requestText) return { ok: false, error: `The most recent email from ${email} had no readable text.`, status: 422 };

  return {
    ok: true,
    requestText,
    meta: {
      subject: msg.subject || null,
      receivedDateTime: msg.receivedDateTime || null,
      from: email,
    },
  };
}

// Build the recent-inbox query for the scanner: messages received on/after
// `sinceIso`, newest first. Selects only what the scan needs.
export function buildInboxUrl(sinceIso, { top = 25 } = {}) {
  const filter = `receivedDateTime ge ${sinceIso}`;
  return 'https://graph.microsoft.com/v1.0/me/messages'
    + `?$filter=${encodeURIComponent(filter)}`
    + '&$select=subject,receivedDateTime,bodyPreview,body,from,internetMessageId'
    + '&$orderby=receivedDateTime%20desc'
    + `&$top=${top}`;
}

// List recent inbound messages (for the scheduled scanner). Returns
// { ok, messages:[{from,subject,receivedDateTime,internetMessageId,text}], error?, status? }.
// Same owner-scoped token + injection model as pullClientMessageFromGraph.
export async function listInboundMessages(
  { sinceIso, authHeader, host, homeAccountId, top = 25 },
  deps = {},
) {
  const getToken = deps.getToken || defaultGetToken;
  const graphFetch = deps.fetchImpl || fetch;
  let token;
  try {
    token = await getToken({ authHeader, host, homeAccountId, fetchImpl: deps.fetchImpl });
  } catch (e) {
    const reauth = e.status === 401;
    return { ok: false, error: reauth ? 'The connected M365 mailbox needs to be reconnected.' : `Could not get a mailbox token: ${e.message}`, status: e.status || 502 };
  }
  if (!token) return { ok: false, error: 'No connected M365 mailbox for this operator.', status: 404 };

  let res;
  try {
    res = await graphFetch(buildInboxUrl(sinceIso, { top }), { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    return { ok: false, error: `Microsoft Graph request failed: ${e.message}`, status: 502 };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `Microsoft Graph returned ${res.status}: ${String(detail).slice(0, 200)}`, status: 502 };
  }
  const j = await res.json().catch(() => ({}));
  return { ok: true, messages: (j.value || []).map(mapGraphMessage) };
}

// Normalize a Graph message into the shape the scanner consumes.
export function mapGraphMessage(m) {
  const body = m.body || {};
  const raw = body.contentType && /html/i.test(body.contentType) ? body.content : (body.content || m.bodyPreview || '');
  return {
    from: (m.from && m.from.emailAddress && m.from.emailAddress.address ? m.from.emailAddress.address : '').toLowerCase(),
    subject: m.subject || null,
    receivedDateTime: m.receivedDateTime || null,
    internetMessageId: m.internetMessageId || null,
    text: htmlToText(raw),
  };
}

// ---- Application-level (shared mailbox) path -----------------------------
// The delegated path above is owner-scoped, so a cron has no session to mint a
// token. This path uses the CLIENT-CREDENTIALS grant (an app token, no user)
// to read a configured SHARED mailbox (e.g. info@ghgrp.net) via /users/{addr}.
// That's what makes truly unattended scanning possible -- but it requires the
// Azure app to hold an APPLICATION Mail.Read permission with admin consent
// (ideally narrowed to just the shared mailbox by an Application Access Policy).

// Same Azure app registration as api/msmail.js (it holds the client secret).
const APP_CLIENT_ID = process.env.REINA_MS_CLIENT_ID || 'ff9bda24-d7e9-4905-a94e-f3ccc0239eb2';

export async function getAppGraphToken(deps = {}) {
  const f = deps.fetchImpl || fetch;
  // Client-credentials needs the REAL tenant, not msmail's multi-tenant
  // 'organizations'. Resolve from dedicated/known vars only -- deliberately NOT
  // process.env.MS_TENANT, because msmail leaves that unset on purpose so its
  // delegated flow stays multi-tenant. Order: explicit dep -> REINA_MS_TENANT
  // -> MS_TENANT_ID (already set in prod).
  const tenant = deps.tenant || process.env.REINA_MS_TENANT || process.env.MS_TENANT_ID;
  const clientId = deps.clientId || APP_CLIENT_ID;
  const clientSecret = deps.clientSecret || process.env.MS_CLIENT_SECRET;
  if (!tenant || !clientSecret) {
    throw Object.assign(new Error('REINA_MS_TENANT (or MS_TENANT_ID) and MS_CLIENT_SECRET are required for app-level mailbox access'), { status: 503 });
  }
  const res = await f(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw Object.assign(new Error(j.error_description || j.error || `app token ${res.status}`), { status: res.status });
  }
  return j.access_token;
}

// /users/{mailbox}/messages recent-inbox query (app-token addressable).
export function buildMailboxInboxUrl(mailbox, sinceIso, { top = 25 } = {}) {
  const filter = `receivedDateTime ge ${sinceIso}`;
  return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages`
    + `?$filter=${encodeURIComponent(filter)}`
    + '&$select=subject,receivedDateTime,bodyPreview,body,from,internetMessageId'
    + '&$orderby=receivedDateTime%20desc'
    + `&$top=${top}`;
}

// List recent inbound messages from a SHARED mailbox using an app token. Same
// return shape as listInboundMessages. `token`/`fetchImpl` injectable for tests.
export async function listSharedInboxMessages({ mailbox, sinceIso, top = 25 }, deps = {}) {
  const graphFetch = deps.fetchImpl || fetch;
  if (!mailbox) return { ok: false, error: 'No shared mailbox configured (set REINA_SCAN_MAILBOX).', status: 400 };
  let token;
  try {
    token = deps.token || await getAppGraphToken(deps);
  } catch (e) {
    return { ok: false, error: `Could not get an app-level mailbox token: ${e.message}`, status: e.status || 502 };
  }
  let res;
  try {
    res = await graphFetch(buildMailboxInboxUrl(mailbox, sinceIso, { top }), { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    return { ok: false, error: `Microsoft Graph request failed: ${e.message}`, status: 502 };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `Microsoft Graph returned ${res.status} for ${mailbox}: ${String(detail).slice(0, 200)}`, status: 502 };
  }
  const j = await res.json().catch(() => ({}));
  return { ok: true, messages: (j.value || []).map(mapGraphMessage) };
}
