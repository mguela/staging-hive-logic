// api/gusto/index.js — Vercel serverless function.
// Overhead Registries + Payroll Integration — Slice 4 (Gusto OAuth).
//
// Structured exactly like api/qbo/index.js: one route handles OAuth start +
// callback + a status probe, tokens stored in the existing `integrations` table
// under key='gusto' (reusing access_token / refresh_token / expires_at, same as
// the jobber and qbo rows). READ-ONLY payroll pulls live in
// api/_lib/gusto-payroll-sync.js and call the exported helpers here.
//
// Behavior by query string:
//   (no params)              -> redirect to Gusto's OAuth screen (if configured)
//   ?code=...&state=...      -> callback: exchange code for tokens, store them
//   ?resource=status         -> { connected, configured } — never throws
//
// The credentials DO NOT EXIST YET. Every path degrades cleanly when
// GUSTO_CLIENT_ID / GUSTO_CLIENT_SECRET are unset (status -> connected:false;
// start -> a friendly "not configured" page) rather than crashing. See
// REPORT.md "Needs Chris" for the dev.gusto.com registration steps.

import { supabaseRequest } from '../_lib/jobber.js';
import { encryptSecret, decryptSecret } from '../_lib/secrets.js';
import { issueOAuthState, consumeOAuthState, escapeHtml } from '../_lib/oauth-state.js';
import { requireApiAuth } from '../_lib/guard.js';
import { runPayrollSync } from '../_lib/gusto-payroll-sync.js';

const ENV = (process.env.GUSTO_ENVIRONMENT || 'production').toLowerCase();
const CLIENT_ID = process.env.GUSTO_CLIENT_ID;
const CLIENT_SECRET = process.env.GUSTO_CLIENT_SECRET;
const REDIRECT_URI = process.env.GUSTO_REDIRECT_URI || 'https://hivelogic-live.vercel.app/api/gusto';

// Gusto has a production host and a demo host; both share the /oauth and /v1 paths.
export const API_BASE = ENV === 'demo' ? 'https://api.gusto-demo.com' : 'https://api.gusto.com';
const AUTH_BASE = `${API_BASE}/oauth/authorize`;
const TOKEN_URL = `${API_BASE}/oauth/token`;

const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh when < 5 minutes to expiry
// Gusto pins behavior to an API version; some endpoints reject calls without
// the header. Defaults to the app's shown default; overridable via env.
const API_VERSION = process.env.GUSTO_API_VERSION || '2026-06-15';
function gustoHeaders(token, json) {
  const h = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-Gusto-API-Version': API_VERSION };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

// ---------- token storage (integrations table, key='gusto') ----------
async function loadTokens() {
  const r = await supabaseRequest('integrations?key=eq.gusto&select=*');
  if (!r.ok) throw new Error(`Failed to read stored Gusto tokens: ${await r.text()}`);
  const row = (await r.json())[0] || null;
  if (row) { row.access_token = decryptSecret(row.access_token); row.refresh_token = decryptSecret(row.refresh_token); }
  return row;
}

async function saveTokens(t) {
  const expiresInSeconds = Number.isFinite(t.expires_in) ? t.expires_in : 7200;
  const r = await supabaseRequest('integrations?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      key: 'gusto',
      access_token: encryptSecret(t.access_token),
      refresh_token: encryptSecret(t.refresh_token),
      realm_id: t.company_uuid || null, // reuse realm_id to hold the Gusto company uuid
      environment: ENV,
      expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  if (!r.ok) throw new Error(`Failed to save Gusto tokens: ${await r.text()}`);
}

export function gustoConfigured() { return Boolean(CLIENT_ID && CLIENT_SECRET); }
export async function gustoConnected() {
  if (!gustoConfigured()) return false;
  try { return Boolean(await loadTokens()); } catch { return false; }
}
// Self-healing: if the stored company uuid is missing (discovery didn't match
// Gusto's response shape at connect time), discover it live and persist it.
export async function getGustoCompanyId() {
  const t = await loadTokens();
  if (!t) return null;
  if (t.realm_id) return t.realm_id;
  // Refresh first — a raw stored token may be expired (this was the bug).
  let accessToken = t.access_token;
  try { accessToken = await getValidAccessToken(); } catch { /* fall back to raw */ }
  const found = await discoverCompanyUuid(accessToken);
  if (found) {
    try {
      await supabaseRequest('integrations?key=eq.gusto', {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ realm_id: found, updated_at: new Date().toISOString() }),
      });
    } catch { /* best effort */ }
  }
  return found || null;
}

// Raw authed GET returning { ok, status, data } without throwing — used for
// discovery + diagnostics.
export async function gustoGetRaw(accessToken, path) {
  const r = await fetch(`${API_BASE}${path}`, { headers: gustoHeaders(accessToken) });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { /* non-JSON */ }
  return { ok: r.ok, status: r.status, data: data != null ? data : text.slice(0, 800) };
}

// Pull the company uuid out of whatever /v1/me shape Gusto returns.
function pickCompanyUuid(me) {
  if (!me || typeof me !== 'object') return null;
  const roles = me.roles || {};
  for (const key of Object.keys(roles)) {
    const cs = roles[key] && roles[key].companies;
    if (Array.isArray(cs) && cs[0] && cs[0].uuid) return cs[0].uuid;
  }
  if (Array.isArray(me.companies) && me.companies[0] && me.companies[0].uuid) return me.companies[0].uuid;
  return null;
}

// ---------- OAuth ----------
function authUrl(state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    state,
  });
  return `${AUTH_BASE}?${p.toString()}`;
}

async function tokenRequest(body) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }).toString(),
  });
  if (!r.ok) throw new Error(`Gusto token error ${r.status}: ${await r.text()}`);
  return r.json();
}

// Best-effort company-uuid discovery. Gusto's GET /v1/me returns the roles the
// authorized user holds; a payroll admin's companies live under
// roles.payroll_admin.companies[].uuid. Never throws — returns null if unknown.
async function discoverCompanyUuid(accessToken) {
  try {
    const me = await gustoGetRaw(accessToken, '/v1/me');
    const fromMe = me.ok ? pickCompanyUuid(me.data) : null;
    if (fromMe) return fromMe;
    // Fallback: some tokens can list companies directly.
    const cos = await gustoGetRaw(accessToken, '/v1/companies');
    if (cos.ok && Array.isArray(cos.data) && cos.data[0] && cos.data[0].uuid) return cos.data[0].uuid;
  } catch { /* fall through */ }
  return null;
}

async function exchangeCode(code) {
  const tok = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  const company_uuid = await discoverCompanyUuid(tok.access_token);
  await saveTokens({ access_token: tok.access_token, refresh_token: tok.refresh_token, expires_in: tok.expires_in, company_uuid });
  return loadTokens();
}

async function refresh(t) {
  const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  await saveTokens({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || t.refresh_token,
    expires_in: tok.expires_in,
    company_uuid: t.realm_id,
  });
  return loadTokens();
}

// Refresh a little before expiry rather than waiting for a 401 (same pattern as
// qbo validAccess / Jobber getValidAccessToken).
export async function getValidAccessToken() {
  const t = await loadTokens();
  if (!t) throw new Error('Gusto is not connected yet. Visit /api/gusto to authorize.');
  const expiresAt = t.expires_at ? new Date(t.expires_at).getTime() : 0;
  if (!expiresAt || expiresAt - Date.now() < REFRESH_SKEW_MS) { const nt = await refresh(t); return nt.access_token; }
  return t.access_token;
}

// Authenticated GET against the Gusto API with one refresh-retry on 401.
// Exported for the payroll sync. Returns parsed JSON.
export async function gustoGet(path) {
  let token = await getValidAccessToken();
  const url = `${API_BASE}${path.startsWith('/') ? path : '/' + path}`;
  const doFetch = (tok) => fetch(url, { headers: gustoHeaders(tok) });
  let r = await doFetch(token);
  if (r.status === 401) { const t = await loadTokens(); if (t) { token = (await refresh(t)).access_token; r = await doFetch(token); } }
  if (!r.ok) { const e = new Error(`Gusto API ${r.status}: ${(await r.text()).slice(0, 300)}`); e.gustoStatus = r.status; throw e; }
  return r.json();
}

// Authenticated POST to the Gusto API (write path). Mirrors gustoGet's
// refresh-retry. Returns { ok, status, data } without throwing so callers can
// surface Gusto's error body (e.g. a scope/permission problem) to the UI.
export async function gustoPost(path, body) {
  let token = await getValidAccessToken();
  const url = `${API_BASE}${path.startsWith('/') ? path : '/' + path}`;
  const doFetch = (tok) => fetch(url, { method: 'POST', headers: gustoHeaders(tok, true), body: JSON.stringify(body) });
  let r = await doFetch(token);
  if (r.status === 401) { const t = await loadTokens(); if (t) { token = (await refresh(t)).access_token; r = await doFetch(token); } }
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { ok: r.ok, status: r.status, data: data || text.slice(0, 600) };
}

// Authenticated PUT (update) against the Gusto API. Same shape as gustoPost.
export async function gustoPut(path, body) {
  let token = await getValidAccessToken();
  const url = `${API_BASE}${path.startsWith('/') ? path : '/' + path}`;
  const doFetch = (tok) => fetch(url, { method: 'PUT', headers: gustoHeaders(tok, true), body: JSON.stringify(body) });
  let r = await doFetch(token);
  if (r.status === 401) { const t = await loadTokens(); if (t) { token = (await refresh(t)).access_token; r = await doFetch(token); } }
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { /* non-JSON */ }
  return { ok: r.ok, status: r.status, data: data || text.slice(0, 600) };
}

// DEMO-ONLY write test: find the first W2 HOURLY employee in the connected demo
// company and push one 8-hour "Regular" shift to Gusto's Time Sheets API, then
// read the sheets back. This proves the write half end-to-end without touching
// a real company. Salary employees are skipped (their pay is fixed — hours are
// not pushed); contractors (1099) are a separate object entirely and are not in
// the /employees list. Refuses to run unless ENV === 'demo'.
async function pushTestTimesheet() {
  const companyId = await getGustoCompanyId();
  if (!companyId) return { ok: false, error: 'No Gusto company id on the stored connection.' };

  const employees = await gustoGet(`/v1/companies/${companyId}/employees`);
  for (const e of employees || []) {
    if (!e || !e.uuid) continue;
    let jobs = [];
    try { jobs = await gustoGet(`/v1/employees/${e.uuid}/jobs`); } catch { jobs = []; }
    const hourlyJob = (Array.isArray(jobs) ? jobs : []).find((j) => {
      const comps = Array.isArray(j.compensations) ? j.compensations : [];
      const comp = (j.current_compensation_uuid && comps.find((c) => c.uuid === j.current_compensation_uuid)) || comps[comps.length - 1] || {};
      return comp.payment_unit === 'Hour';
    });
    if (!hourlyJob) continue; // salaried or no job — skip

    // An 8-hour shift ending ~yesterday evening (well inside any pay period).
    const end = new Date(Date.now() - 17 * 3600 * 1000);
    const start = new Date(Date.now() - 25 * 3600 * 1000);
    const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const body = {
      entity_uuid: e.uuid,
      entity_type: 'Employee',
      job_uuid: hourlyJob.uuid,
      time_zone: 'America/New_York',
      shift_started_at: iso(start),
      shift_ended_at: iso(end),
      entries: [{ hours_worked: 8, pay_classification: 'Regular' }],
    };
    const post = await gustoPost(`/v1/companies/${companyId}/time_tracking/time_sheets`, body);
    let sheetsNow = null;
    try { const rb = await gustoGet(`/v1/companies/${companyId}/time_tracking/time_sheets`); sheetsNow = Array.isArray(rb) ? rb.length : rb; } catch { /* read-back optional */ }

    return {
      ok: post.ok,
      pushed_for: { name: [e.first_name, e.last_name].filter(Boolean).join(' ') || e.email, employee_uuid: e.uuid, job_uuid: hourlyJob.uuid },
      sent: body,
      gusto_status: post.status,
      gusto_response: post.data,
      time_sheets_now: sheetsNow,
    };
  }
  return { ok: false, error: 'No W2 hourly employee with a job was found in the demo company.' };
}

function page(title, bodyHtml) {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#222">` +
    `<h2>${escapeHtml(title)}</h2>${bodyHtml}</div>`;
}

export default async function handler(req, res) {
  const resource = req.query && req.query.resource;
  const { code, state, error: oauthError } = req.query || {};

  // status probe — never throws, safe without credentials.
  if (resource === 'status') {
    let connected = false;
    try { connected = await gustoConnected(); } catch { connected = false; }
    return res.status(200).json({ ok: true, connected, configured: gustoConfigured(), environment: ENV });
  }

  // ---- roster: HiveLogic hires with their Gusto link (auth-gated) ----------
  if (resource === 'roster') {
    const auth = await requireApiAuth(req);
    if (!auth.ok) return res.status(401).json({ ok: false, error: 'Not signed in.' });
    let roster = [];
    try {
      const r = await supabaseRequest('employee_pay?effective_to=is.null&select=id,display_name,pay_type,pay_class,base_rate,is_field,source,gusto_employee_uuid,gusto_job_uuid&order=created_at.desc');
      if (r.ok) roster = await r.json();
    } catch { /* table may be empty */ }
    let connected = false;
    try { connected = await gustoConnected(); } catch { connected = false; }
    return res.status(200).json({ ok: true, roster, environment: ENV, connected, configured: gustoConfigured() });
  }

  // ---- sync: pull payroll from Gusto (demo = dry-run only; prod can commit) -
  if (resource === 'sync') {
    const auth = await requireApiAuth(req);
    if (!auth.ok) return res.status(401).json({ ok: false, error: 'Not signed in.' });
    // Demo NEVER commits — writing the demo company's fake employees into the
    // real employee_pay table would pollute HiveLogic. Production may commit
    // with { commit: true }.
    const wantCommit = req.body && req.body.commit === true;
    const dryRun = ENV === 'demo' ? true : !wantCommit;
    try {
      const plan = await runPayrollSync({ dryRun });
      if (ENV === 'demo') plan.note_demo = 'Demo connection: dry-run only — never writes demo employees into HiveLogic.';
      return res.status(plan.ok === false ? 502 : 200).json(plan);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  }

  // ---- authenticated JSON tools (payroll dry-run + demo timesheet push) ----
  if (resource === 'payroll_dry_run' || resource === 'timesheet_test') {
    const auth = await requireApiAuth(req);
    if (!auth.ok) return res.status(401).json({ ok: false, error: 'Not signed in.' });
    if (!gustoConfigured()) return res.status(400).json({ ok: false, error: 'Gusto is not configured.' });
    try {
      if (resource === 'payroll_dry_run') {
        const cid = await getGustoCompanyId(); // self-heals + persists
        if (!cid) {
          // Diagnostics: token sanity + raw /v1/me & /v1/companies, plus a
          // refreshed-token retry — enough to pinpoint the 401.
          const t = await loadTokens();
          const tok = (t && t.access_token) || '';
          const me = t ? await gustoGetRaw(tok, '/v1/me') : null;
          const cos = t ? await gustoGetRaw(tok, '/v1/companies') : null;
          let me2 = null, refreshErr = null;
          try { const fresh = await getValidAccessToken(); me2 = await gustoGetRaw(fresh, '/v1/me'); }
          catch (e) { refreshErr = e.message; }
          return res.status(200).json({
            ok: false, error: 'Could not resolve the Gusto company id yet — diagnostics below.',
            api_version: API_VERSION,
            // Presence is enough to distinguish "not connected" from an
            // upstream rejection. Lengths and prefixes are credential
            // material and must never leave a setup/diagnostic endpoint.
            token_present: Boolean(tok),
            me_status: me && me.status, me: me && me.data,
            companies_status: cos && cos.status, companies: cos && cos.data,
            me_after_refresh_status: me2 && me2.status, me_after_refresh: me2 && me2.data, refresh_error: refreshErr,
          });
        }
        const plan = await runPayrollSync({ dryRun: true });
        return res.status(plan.ok === false ? 502 : 200).json(plan);
      }
      // timesheet_test — WRITE. Hard-guarded to the demo host only.
      if (ENV !== 'demo') return res.status(400).json({ ok: false, error: 'Refused: timesheet_test only runs against a Gusto DEMO company (GUSTO_ENVIRONMENT=demo).' });
      if (!(await gustoConnected())) return res.status(400).json({ ok: false, error: 'Gusto is not connected. Visit /api/gusto to authorize.' });
      return res.status(200).json(await pushTestTimesheet());
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  }

  if (!gustoConfigured()) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(page('Gusto is not configured',
      '<p>Payroll sync is not connected yet. An admin needs to register a Gusto app and set <code>GUSTO_CLIENT_ID</code>, <code>GUSTO_CLIENT_SECRET</code>, and <code>GUSTO_REDIRECT_URI</code>.</p>'));
  }

  try {
    // OAuth callback
    if (code) {
      const stateCheck = await consumeOAuthState({ provider: 'gusto', state });
      if (!state || !stateCheck.ok) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(400).send(page('Could not connect Gusto', `<p>Invalid or expired authorization state${stateCheck && stateCheck.reason ? ' (' + escapeHtml(stateCheck.reason) + ')' : ''}. Please try again.</p>`));
      }
      await exchangeCode(String(code));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(page('Gusto connected', '<p>Payroll is connected. You can close this window.</p>'));
    }
    if (oauthError) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(page('Gusto authorization cancelled', `<p>${escapeHtml(String(oauthError))}</p>`));
    }

    // OAuth start
    const st = await issueOAuthState({ provider: 'gusto' });
    res.writeHead(302, { Location: authUrl(st) });
    return res.end();
  } catch (e) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(page('Gusto connection error', `<p>${escapeHtml(e.message || 'Unknown error')}</p>`));
  }
}
