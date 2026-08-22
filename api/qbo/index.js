// api/qbo/index.js - Vercel serverless function
// NEW, additive-only file. Ports the QuickBooks Online integration that
// already exists and works in the LOCAL reina-ai prototype (qbo.js) onto the
// LIVE hivelogic-live app, following the exact same pattern used for Jobber:
// one route handles OAuth start + OAuth callback + live read, so this stays
// ONE serverless function instead of three (Vercel Hobby's 12-function cap
// is already close to full -- see sync-extended.js's header comment).
//
// Three things this single route does, based on the query string:
// 1. No query params at all -> redirect to Intuit's OAuth screen
// 2. ?code=...&realmId=... -> Intuit's callback: exchange the
//    code for tokens, store them in
//    Supabase (integrations table)
// 3. ?resource=financials&kind=summary -> live read from QuickBooks,
//    refreshing the token first if needed
//
// Tokens are stored in Supabase's existing `integrations` table (the same
// table Jobber's tokens already live in, keyed by `key='jobber'`) instead of
// the local .qbo-tokens.json file reina-ai/qbo.js uses, because serverless
// functions don't persist disk writes between invocations. This row uses
// key='qbo' -- it does not touch the Jobber row. Everything else (endpoints,
// report names, the getFinancials() shape) is copied from the
// already-working local code.
//
// Setup Chris needs to do (same Intuit app as reina-ai works fine -- Intuit
// apps support MULTIPLE redirect URIs under one app, no need for a second app):
// 1. Run sql/004_qbo_integration.sql in Supabase (adds 2 nullable columns
//    to the existing integrations table -- does not touch Jobber's row).
// 2. developer.intuit.com -> your existing app (or a new one) -> Keys & credentials
// 3. Under Redirect URIs, ADD (don't replace): https://hivelogic-live.vercel.app/api/qbo
// 4. In Vercel -> this project -> Settings -> Environment Variables, add:
//    QBO_CLIENT_ID = (Production Client ID)
//    QBO_CLIENT_SECRET = (Production Client Secret)
//    QBO_ENVIRONMENT = production
//    QBO_REDIRECT_URI = https://hivelogic-live.vercel.app/api/qbo
// 5. Redeploy, then visit https://hivelogic-live.vercel.app/api/qbo and
//    approve the QuickBooks connection.

import { supabaseRequest } from '../_lib/jobber.js';
import { encryptSecret, decryptSecret } from '../_lib/secrets.js';
import { issueOAuthState, consumeOAuthState, escapeHtml } from '../_lib/oauth-state.js';

const ENV = (process.env.QBO_ENVIRONMENT || 'production').toLowerCase();
const CLIENT_ID = process.env.QBO_CLIENT_ID;
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;
const REDIRECT_URI = process.env.QBO_REDIRECT_URI || 'https://hivelogic-live.vercel.app/api/qbo';
const SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR = '73';

const AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = ENV === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';

// ---------- token storage (Supabase `integrations` table, key='qbo') ----------
// Same table + same upsert pattern as api/_lib/jobber.js's getStoredTokens()/
// saveTokens() for the Jobber row (key='jobber') -- just a different key, so
// the two integrations' tokens live side by side without touching each other.

async function loadTokens() {
  const r = await supabaseRequest('integrations?key=eq.qbo&select=*');
  if (!r.ok) throw new Error(`Failed to read stored QuickBooks tokens: ${await r.text()}`);
  const rows = await r.json();
  const row = rows[0] || null;
  if (row) { row.access_token = decryptSecret(row.access_token); row.refresh_token = decryptSecret(row.refresh_token); }
  return row;
}

async function saveTokens(t) {
  const expiresInSeconds = Number.isFinite(t.expires_in) ? t.expires_in : 3600;
  const r = await supabaseRequest('integrations?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      key: 'qbo',
      access_token: encryptSecret(t.access_token),
      refresh_token: encryptSecret(t.refresh_token),
      realm_id: t.realm_id,
      environment: t.environment,
      expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  if (!r.ok) throw new Error(`Failed to save QuickBooks tokens: ${await r.text()}`);
}

export function qboConfigured() { return Boolean(CLIENT_ID && CLIENT_SECRET); }
export async function qboConnected() { return Boolean(await loadTokens()); }

// ---------- OAuth ----------

function authUrl(state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    state,
  });
  return `${AUTH_BASE}?${p.toString()}`;
}

async function tokenRequest(body) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!r.ok) throw new Error(`QBO token error ${r.status}: ${await r.text()}`);
  return r.json();
}

async function exchangeCode(code, realmId) {
  const tok = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  await saveTokens({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    realm_id: realmId,
    environment: ENV,
    expires_in: tok.expires_in,
  });
  return loadTokens();
}

async function refresh(t) {
  const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  await saveTokens({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || t.refresh_token,
    realm_id: t.realm_id,
    environment: t.environment || ENV,
    expires_in: tok.expires_in,
  });
  return loadTokens();
}

// QBO access tokens last ~60 minutes and the refresh token can rotate on
// use, same rationale as Jobber's getValidAccessToken() -- refresh a little
// before expiry rather than waiting for a 401.
async function validAccess() {
  const t = await loadTokens();
  if (!t) throw new Error('QuickBooks is not connected yet. Visit /api/qbo to authorize.');
  const expiresAt = t.expires_at ? new Date(t.expires_at).getTime() : 0;
  const isExpiringSoon = !expiresAt || expiresAt - Date.now() < 2 * 60 * 1000;
  if (isExpiringSoon) return refresh(t);
  return t;
}

// ---------- QBO API ----------

// ---------- friendly error messages ----------

// QBO error responses are wrapped in a "Fault" object per Intuit's QBO API
// spec: {"Fault":{"Error":[{"Message":"...","Detail":"...","code":"..."}],
// "type":"..."}}. That raw blob isn't readable by anyone but a developer --
// this maps the fault codes/status codes actually seen in practice (rate
// limiting, expired auth, bad requests, QBO-side outages) to a plain-English
// message. Nothing is hidden: apiGet() below still attaches the real status
// + raw detail to the thrown Error (as .qboStatus/.qboRaw) so it stays
// available for debugging even though the user-facing message is friendly.
function friendlyQboError(status, rawText) {
  let faultCode = null, faultMessage = null, faultDetail = null;
  try {
    const parsed = JSON.parse(rawText);
    const err = parsed && parsed.Fault && parsed.Fault.Error && parsed.Fault.Error[0];
    if (err) { faultCode = err.code || null; faultMessage = err.Message || null; faultDetail = err.Detail || null; }
  } catch { /* not JSON, or not the expected Fault shape -- fall through to status-based mapping */ }

  if (status === 429 || faultCode === '429' || /throttle/i.test(faultMessage || '')) {
    return 'QuickBooks is rate-limiting requests right now (too many API calls in a short window). This resolves on its own -- try again in a minute.';
  }
  if (status === 401 || faultCode === '3200' || /authenticationfailed/i.test(faultMessage || '')) {
    return 'QuickBooks needs to be reconnected -- the connection has expired or was revoked. Visit /api/qbo to reconnect.';
  }
  if (status === 403) {
    return 'QuickBooks denied this request -- the connected account may not have permission for this data.';
  }
  if (faultCode === '6240' || /validationfault/i.test(faultMessage || '') || status === 400) {
    return `QuickBooks rejected this request as invalid${faultDetail ? ': ' + faultDetail : (faultMessage ? ': ' + faultMessage : '')}.`;
  }
  if (status >= 500) {
    return "QuickBooks is temporarily unavailable (an error on Intuit's side, not ours). Try again shortly.";
  }
  // Unknown/uncommon case -- still plain English, but keeps the real fault
  // message visible instead of hiding an error type nobody has mapped yet.
  return `QuickBooks returned an unexpected error (status ${status})${faultMessage ? ': ' + faultMessage : ''}.`;
}

async function apiGet(endpointPath) {
  let t = await validAccess();
  const url = `${API_BASE}/v3/company/${t.realm_id}/${endpointPath}`;
  const doFetch = (tok) => fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' } });
  let r = await doFetch(t.access_token);
  if (r.status === 401) { t = await refresh(t); r = await doFetch(t.access_token); } // one retry
  if (!r.ok) {
    // Bug fix (2026-07-23): this used to throw a raw `QBO API 429: {...json...}`
    // blob straight through -- every frontend caller does
    // `if(d.error) throw new Error(d.error)` and shows e.message verbatim,
    // so that raw blob was reaching the UI unmodified. Now runs it through
    // friendlyQboError() first; the real status + raw body are still kept
    // on the Error (not discarded) for logging/debugging.
    const rawText = await r.text();
    const err = new Error(friendlyQboError(r.status, rawText));
    err.qboStatus = r.status;
    err.qboRaw = rawText.slice(0, 300);
    throw err;
  }
  return r.json();
}

async function query(sql) {
  const d = await apiGet(`query?query=${encodeURIComponent(sql)}&minorversion=${MINOR}`);
  return d.QueryResponse || {};
}
async function report(name, params = {}) {
  const p = new URLSearchParams({ ...params, minorversion: MINOR });
  return apiGet(`reports/${name}?${p.toString()}`);
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const sum = (arr, f) => arr.reduce((a, x) => a + num(f(x)), 0);

function flattenReport(rep) {
  const out = [];
  const walk = (rows) => {
    if (!rows || !rows.Row) return;
    for (const row of rows.Row) {
      const cd = row.ColData || (row.Summary && row.Summary.ColData);
      if (cd && cd.length) {
        const label = cd[0].value;
        const amount = cd[cd.length - 1].value;
        if (label && amount !== undefined && amount !== '') out.push({ label, amount: num(amount) });
      }
      if (row.Rows) walk(row.Rows);
    }
  };
  walk(rep && rep.Rows);
  return out;
}

// Thin exports so api/_lib/qbo-cost-import.js (the cost-model import_qbo
// resource) can pull the chart of accounts and a trailing-12-month P&L
// without duplicating the token/refresh plumbing. Additive only — nothing
// about the existing QBO behavior changes. (query/report/flattenReport are
// hoisted function declarations, so exporting them here is safe.)
export async function qboQuery(sql) { return query(sql); }
export async function qboReport(name, params = {}) { return report(name, params); }
export function qboFlattenReport(rep) { return flattenReport(rep); }

function todayISO() { return new Date().toISOString().slice(0, 10); }
function yearStartISO() { return `${new Date().getFullYear()}-01-01`; }

// Like flattenReport, but for a report fetched with summarize_column_by=Month
// (or Week/Quarter/Year). QBO's report JSON, with multiple columns, shapes
// each section (Income/COGS/Expenses) as a Rows.Row list; every top-level
// section carries a `group` tag ("Income","COGS","GrossProfit","Expenses",
// "NetOperatingIncome","NetIncome", etc). Detail lines live in row.ColData
// (label + one value per column + a trailing Total column); section subtotals
// (e.g. "Total Income", "Gross Profit", "Net Income") live in row.Summary.ColData
// with the same shape. This walks the whole tree once and buckets every row
// by its nearest ancestor's group, so the frontend can pick out whichever
// real subtotal QBO actually labeled things (label text isn't hardcoded/
// guessed here -- the frontend regex-matches labels the same way getFinancials'
// 'summary' case already does for the YTD pick()).
//
// Works equally for a plain (non-summarized) report -- QBO still returns a
// label column + a single "Total" column, so `months` comes back empty and
// every row's `.total` is the one real number for that line across the
// whole requested range.
function flattenMonthlyReport(rep) {
  const cols = (rep && rep.Columns && rep.Columns.Column) || [];
  // First column is the account/label column (no real title); last is the
  // report's own "Total" column for the whole range -- both excluded from months.
  const months = cols.slice(1, -1).map(c => c.ColTitle || '').filter(Boolean);

  const detail = { income: [], cogs: [], expenses: [] };
  const summaryRows = [];

  const rowValues = (colData) => ({
    values: colData.slice(1, -1).map(c => num(c.value)),
    total: num(colData[colData.length - 1] && colData[colData.length - 1].value),
  });

  function walk(rows, group) {
    if (!rows || !rows.Row) return;
    for (const row of rows.Row) {
      const g = row.group || group;
      const bucket = g === 'Income' ? 'income' : g === 'COGS' ? 'cogs' : g === 'Expenses' ? 'expenses' : null;
      if (row.ColData && row.ColData.length && row.ColData[0].value) {
        const { values, total } = rowValues(row.ColData);
        if (bucket) detail[bucket].push({ label: row.ColData[0].value, values, total });
      }
      if (row.Rows) walk(row.Rows, g);
      if (row.Summary && row.Summary.ColData && row.Summary.ColData.length && row.Summary.ColData[0].value) {
        const { values, total } = rowValues(row.Summary.ColData);
        summaryRows.push({ label: row.Summary.ColData[0].value, group: g || null, values, total });
      }
    }
  }
  walk(rep && rep.Rows, null);
  return { months, income: detail.income, cogs: detail.cogs, expenses: detail.expenses, summaryRows };
}

// kind: 'summary' | 'profit_and_loss' | 'profit_and_loss_monthly' | 'balance_sheet'
//     | 'ar_aging' | 'ap_aging' | 'open_invoices' | 'open_bills' | 'accounts' | 'classes'
// Same shape as reina-ai/qbo.js's getFinancials() -- copied, not reinvented,
// so anything built against the local version ports over unchanged.
//
// `opts` (only read by 'profit_and_loss_monthly'):
//   start_date, end_date       -- ISO dates. Default: Jan 1 of this year -> today,
//                                 same default this kind always had.
//   summarize_by               -- 'Month' | 'Week' | 'Quarter' | 'Year' | 'Total'.
//                                 'Total' (or anything falsy/invalid) omits QBO's
//                                 summarize_column_by param entirely, which
//                                 makes QBO return one single Total column --
//                                 the report's own grand total for the whole
//                                 range, not a fabricated "Total" bucket.
//   accounting_method          -- 'Cash' | 'Accrual'. Default 'Accrual' (QBO's
//                                 own default), mirrors the toggle on QBO's
//                                 real P&L report screen.
// Perf note (2026-07-27): getFinancials() makes live QuickBooks Reports/API
// calls -- QBO latency, commonly several seconds, sometimes 10-15s for
// job-costing. Multiple frontend widgets independently request the same
// kind+opts (e.g. Command Center loadFinancials() and the Financial view both
// call kind='summary'). Memoizing the in-flight PROMISE per kind+opts means
// concurrent callers share one real QBO round trip, cached 50s for the next
// poll. Same pattern as the watching_margin_fade cache in api/track1.js.
const _financialsCache = new Map();
export async function getFinancials(kind = 'summary', opts = {}) {
  const _cacheKey = kind + '|' + JSON.stringify(opts || {});
  const _entry = _financialsCache.get(_cacheKey);
  if (!_entry || (Date.now() - _entry.t) >= 50 * 1000) {
    const _promise = getFinancialsUncached(kind, opts).catch(function(e){
      _financialsCache.delete(_cacheKey); // don't cache a failure -- next call should retry
      throw e;
    });
    _financialsCache.set(_cacheKey, { t: Date.now(), promise: _promise });
  }
  return _financialsCache.get(_cacheKey).promise;
}

// ---------- durable report cache (Supabase `qbo_report_cache`) ----------
// The in-memory memo above only survives inside one warm serverless
// instance -- every cold start re-pays the full QBO scan. For expensive
// kinds (job_costing_summary paginates EVERY Purchase + Bill: 10-15s), the
// computed payload is also persisted to Supabase (sql/042_qbo_report_cache
// .sql) so ANY invocation can serve it instantly.
//
// getFinancialsDurable() implements stale-while-revalidate WITHOUT hiding
// staleness from the caller:
//   fresh cache (< freshMs old)  -> { data, cachedAt, stale: false }
//   stale cache                  -> { data, cachedAt, stale: true, refresh }
//        `refresh` is an async fn the HANDLER calls AFTER sending the
//        response, so the user never waits on QuickBooks; it goes through
//        getFinancials() above, so concurrent refreshes share one QBO trip.
//   no cache (first ever call)   -> computes live (slow, once), persists,
//                                   returns fresh.
// Payloads are exactly what getFinancials() returned -- real QBO data,
// cached, never altered. Errors are never cached.
async function readQboReportCache(cacheKey) {
  try {
    const r = await supabaseRequest('qbo_report_cache?cache_key=eq.' + encodeURIComponent(cacheKey) + '&select=payload,computed_at');
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0] || null;
  } catch (e) { return null; }
}
async function writeQboReportCache(cacheKey, payload) {
  try {
    const r = await supabaseRequest('qbo_report_cache?on_conflict=cache_key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ cache_key: cacheKey, payload, computed_at: new Date().toISOString() }),
    });
    return r.ok;
  } catch (e) { return false; }
}
export async function getFinancialsDurable(kind = 'summary', opts = {}, { freshMs = 15 * 60 * 1000 } = {}) {
  const cacheKey = kind + '|' + JSON.stringify(opts || {});
  const refresh = async () => {
    const fresh = await getFinancials(kind, opts);
    if (fresh && !fresh.error) await writeQboReportCache(cacheKey, fresh);
    return fresh;
  };
  const row = await readQboReportCache(cacheKey);
  if (row && row.payload && !row.payload.error) {
    const cachedAt = row.computed_at;
    const ageMs = Date.now() - new Date(cachedAt).getTime();
    if (ageMs < freshMs) return { data: row.payload, cachedAt, stale: false, refresh: null };
    return { data: row.payload, cachedAt, stale: true, refresh };
  }
  // First ever call (or cache unreadable): pay the live cost once, persist.
  const data = await refresh();
  return { data, cachedAt: new Date().toISOString(), stale: false, refresh: null };
}

async function getFinancialsUncached(kind = 'summary', opts = {}) {
  if (!(await qboConnected())) return { error: 'QuickBooks is not connected yet. Visit /api/qbo to authorize.' };
  try {
    switch (kind) {
      case 'accounts': {
        const q = await query("SELECT Name, AccountType, AccountSubType, CurrentBalance FROM Account WHERE Active = true");
        return { source: `QuickBooks (${ENV})`, accounts: (q.Account || []).map(a => ({ id: a.Id, name: a.Name, type: a.AccountType, balance: num(a.CurrentBalance) })) };
      }
      case 'vendors': {
        // Vendor directory for HiveDocs' "Vendors & Subcontractors" folder
        // dropdown -- real QBO vendor list, alphabetical, active only.
        // Paginated with STARTPOSITION: QBO caps each query at 1000 rows.
        const all = [];
        for (let start = 1; start <= 9001; start += 1000) {
          const q = await query(`SELECT Id, DisplayName, CompanyName, Active FROM Vendor WHERE Active = true ORDERBY DisplayName STARTPOSITION ${start} MAXRESULTS 1000`);
          const page = q.Vendor || [];
          all.push(...page);
          if (page.length < 1000) break;
        }
        return {
          source: `QuickBooks (${ENV})`,
          vendors: all.map(v => ({ id: v.Id, name: v.DisplayName || v.CompanyName || 'Unnamed vendor' }))
        };
      }
      case 'bills_due_range': {
        // Precise, server-side date-filtered bill query for the Financial
        // Intelligence "true cash" bridge and commitments calendar
        // (api/track1.js's resource=cash/forecast). Deliberately NOT reusing
        // 'open_bills' below: that case has a flat MAXRESULTS 100 with
        // ORDERBY DueDate ASC, so once there are more than 100 open bills
        // (there already are), it silently shows only the 100 OLDEST-due
        // ones and can miss bills due in the actual window being asked about
        // here. Filtering DueDate in QBO's own SQL avoids that.
        const start = /^\d{4}-\d{2}-\d{2}$/.test(opts.start_date || '') ? opts.start_date : todayISO();
        const end = /^\d{4}-\d{2}-\d{2}$/.test(opts.end_date || '') ? opts.end_date : todayISO();
        const sql = `SELECT DocNumber, TotalAmt, Balance, DueDate, VendorRef FROM Bill WHERE Balance > '0' AND DueDate >= '${start}' AND DueDate <= '${end}' ORDERBY DueDate ASC MAXRESULTS 1000`;
        const q = await query(sql);
        const bills = (q.Bill || []).map(b => ({ num: b.DocNumber, vendor: b.VendorRef && b.VendorRef.name, total: num(b.TotalAmt), balance: num(b.Balance), due: b.DueDate }));
        return { source: `QuickBooks (${ENV})`, start, end, bills, total_balance: sum(bills, b => b.balance) };
      }
      case 'invoices_due_range': {
        // Same rationale/shape as 'bills_due_range', for real cash-IN
        // instead of cash-out -- powers the Financial Intelligence
        // near-term cash forecast (api/track1.js's resource=forecast).
        const start = /^\d{4}-\d{2}-\d{2}$/.test(opts.start_date || '') ? opts.start_date : todayISO();
        const end = /^\d{4}-\d{2}-\d{2}$/.test(opts.end_date || '') ? opts.end_date : todayISO();
        const sql = `SELECT DocNumber, TotalAmt, Balance, DueDate, CustomerRef FROM Invoice WHERE Balance > '0' AND DueDate >= '${start}' AND DueDate <= '${end}' ORDERBY DueDate ASC MAXRESULTS 1000`;
        const q = await query(sql);
        const invoices = (q.Invoice || []).map(i => ({ num: i.DocNumber, customer: i.CustomerRef && i.CustomerRef.name, total: num(i.TotalAmt), balance: num(i.Balance), due: i.DueDate }));
        return { source: `QuickBooks (${ENV})`, start, end, invoices, total_balance: sum(invoices, i => i.balance) };
      }
      case 'open_invoices': {
        const q = await query("SELECT Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance, CustomerRef FROM Invoice WHERE Balance > '0' ORDERBY DueDate ASC MAXRESULTS 100");
        return { source: `QuickBooks (${ENV})`, open_invoices: (q.Invoice || []).map(i => ({ num: i.DocNumber, customer: i.CustomerRef && i.CustomerRef.name, total: num(i.TotalAmt), balance: num(i.Balance), due: i.DueDate, date: i.TxnDate })) };
      }
      case 'open_bills': {
        const q = await query("SELECT Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance, VendorRef FROM Bill WHERE Balance > '0' ORDERBY DueDate ASC MAXRESULTS 100");
        return { source: `QuickBooks (${ENV})`, open_bills: (q.Bill || []).map(b => ({ num: b.DocNumber, vendor: b.VendorRef && b.VendorRef.name, total: num(b.TotalAmt), balance: num(b.Balance), due: b.DueDate })) };
      }
      case 'profit_and_loss': {
        const rep = await report('ProfitAndLoss', { start_date: yearStartISO(), end_date: todayISO() });
        return { source: `QuickBooks (${ENV})`, period: `${yearStartISO()} -> ${todayISO()}`, rows: flattenReport(rep) };
      }
      case 'profit_and_loss_monthly': {
        // Real P&L, filterable by date range, column granularity, and
        // accounting method -- mirrors the controls on QBO's own P&L report
        // screen. No fabricated line items -- every row/value here is exactly
        // what QuickBooks' own report returns, just parsed into a friendlier shape.
        const start = /^\d{4}-\d{2}-\d{2}$/.test(opts.start_date || '') ? opts.start_date : yearStartISO();
        const end = /^\d{4}-\d{2}-\d{2}$/.test(opts.end_date || '') ? opts.end_date : todayISO();
        const validSummarize = ['Month', 'Week', 'Quarter', 'Year'];
        const summarizeBy = validSummarize.includes(opts.summarize_by) ? opts.summarize_by : null;
        const accountingMethod = opts.accounting_method === 'Cash' ? 'Cash' : 'Accrual';
        const reportParams = { start_date: start, end_date: end, accounting_method: accountingMethod };
        if (summarizeBy) reportParams.summarize_column_by = summarizeBy;
        const rep = await report('ProfitAndLoss', reportParams);
        return {
          source: `QuickBooks (${ENV})`,
          period: `${start} -> ${end}`,
          summarize_by: summarizeBy || 'Total',
          accounting_method: accountingMethod,
          ...flattenMonthlyReport(rep),
        };
      }
      case 'classes': {
        // Checks whether Chris's QuickBooks has real Class tracking set up
        // (QBO's mechanism for tagging transactions to a service line/division).
        // If this comes back non-empty, a real per-service-line P&L becomes
        // possible later; if empty, that filter honestly isn't available yet
        // rather than being faked with made-up categories.
        const q = await query('SELECT Id, Name FROM Class WHERE Active = true MAXRESULTS 100');
        return { source: `QuickBooks (${ENV})`, classes: (q.Class || []).map(c => ({ id: c.Id, name: c.Name })) };
      }
      case 'job_costing_check': {
        // Diagnostic only (read-only, additive): checks whether Bills/Purchases in
        // QBO have LINE-LEVEL CustomerRef populated -- this is QBO's 'Customer:Job'
        // tracking mechanism, distinct from Class tracking (checked above, and
        // already known to be empty). If real job-linked expense lines exist here,
        // per-job cost history becomes buildable for margin-fade detection; if not,
        // that data isn't being captured yet and margin-fade needs an operational
        // change (coding expenses to jobs going forward), not more code.
        const qp = await query('SELECT * FROM Purchase MAXRESULTS 25');
        const purchases = qp.Purchase || [];
        const lineHasJob = (l) => (l.AccountBasedExpenseLineDetail && l.AccountBasedExpenseLineDetail.CustomerRef) || (l.ItemBasedExpenseLineDetail && l.ItemBasedExpenseLineDetail.CustomerRef);
        const purchasesWithJobLine = purchases.filter(p => (p.Line || []).some(lineHasJob));
        const qb2 = await query('SELECT * FROM Bill MAXRESULTS 25');
        const bills = qb2.Bill || [];
        const billsWithJobLine = bills.filter(b => (b.Line || []).some(lineHasJob));
        const sample = purchasesWithJobLine[0] || billsWithJobLine[0] || null;
        return {
          source: `QuickBooks (${ENV})`,
          purchasesSampled: purchases.length,
          purchasesWithJobLine: purchasesWithJobLine.length,
          billsSampled: bills.length,
          billsWithJobLine: billsWithJobLine.length,
          sampleJobLine: sample
        };
      }
      case 'job_costing_summary': {
        // Real per-job actual-cost totals from QBO's Customer:Job tracking,
        // confirmed real via job_costing_check above. Paginates ALL Purchases
        // and Bills (not a 25-row sample) via STARTPOSITION -- same pattern as
        // 'vendors' above -- and sums job-costed line amounts by the Jobber
        // job number parsed out of the sub-customer's display name (e.g.
        // "Rich Suarino - Job # 2763" -> 2763). Lines that don't match that
        // naming pattern are counted, not silently dropped: unmatchedAmount/
        // unmatchedLines report exactly how much spend can't be attributed to
        // a job number, so nothing here is hidden or guessed.
        const jobNumberRe = /Job\s*#\s*(\d+)/i;
        const jobRefOnLine = (l) => (l.AccountBasedExpenseLineDetail && l.AccountBasedExpenseLineDetail.CustomerRef) || (l.ItemBasedExpenseLineDetail && l.ItemBasedExpenseLineDetail.CustomerRef);

        async function fetchAllEntity(entity) {
          const all = [];
          for (let start = 1; start <= 9001; start += 1000) {
            const q = await query(`SELECT * FROM ${entity} STARTPOSITION ${start} MAXRESULTS 1000`);
            const page = q[entity] || [];
            all.push(...page);
            if (page.length < 1000) break;
          }
          return all;
        }

        const [jcPurchases, jcBills] = await Promise.all([fetchAllEntity('Purchase'), fetchAllEntity('Bill')]);
        const byJob = {};
        let unmatchedAmount = 0, unmatchedLines = 0, matchedLines = 0;

        for (const txn of [...jcPurchases, ...jcBills]) {
          for (const l of (txn.Line || [])) {
            const ref = jobRefOnLine(l);
            if (!ref) continue;
            const amt = num(l.Amount);
            const m = (ref.name || '').match(jobNumberRe);
            if (m) {
              const jobNumber = m[1];
              if (!byJob[jobNumber]) byJob[jobNumber] = { actualCost: 0, lineCount: 0 };
              byJob[jobNumber].actualCost += amt;
              byJob[jobNumber].lineCount += 1;
              matchedLines++;
            } else {
              unmatchedAmount += amt;
              unmatchedLines++;
            }
          }
        }

        const jcJobs = Object.keys(byJob).map(jobNumber => ({
          jobNumber,
          actualCost: Math.round(byJob[jobNumber].actualCost * 100) / 100,
          lineCount: byJob[jobNumber].lineCount,
        }));

        return {
          source: `QuickBooks (${ENV})`,
          purchasesScanned: jcPurchases.length,
          billsScanned: jcBills.length,
          matchedLines,
          unmatchedLines,
          unmatchedAmount: Math.round(unmatchedAmount * 100) / 100,
          jobs: jcJobs,
        };
      }
      case 'bills_by_job': {
        // Real per-job vendor bills for the last N days (default 45), matched
        // via QBO's Customer:Job line-level tracking -- same 'Job # NNNN'
        // naming pattern already proven out by job_costing_summary above.
        // Powers the Schedule calendar's real vendor-bill badges, replacing
        // the old hand-typed "material delivery" mockup data. QBO has no
        // delivery-ETA/status concept (in transit / delayed / etc) -- this
        // returns exactly what was billed (vendor, amount, due date), nothing
        // simulated.
        const days = Math.max(1, Math.min(365, parseInt(opts.days, 10) || 45));
        const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const jobNumberRe = /Job\s*#\s*(\d+)/i;
        const jobRefOnLine = (l) => (l.AccountBasedExpenseLineDetail && l.AccountBasedExpenseLineDetail.CustomerRef) || (l.ItemBasedExpenseLineDetail && l.ItemBasedExpenseLineDetail.CustomerRef);
        const q = await query(`SELECT * FROM Bill WHERE TxnDate >= '${start}' MAXRESULTS 1000`);
        const bills = q.Bill || [];
        const out = [];
        for (const b of bills) {
          const vendor = (b.VendorRef && b.VendorRef.name) || 'Unknown vendor';
          for (const l of (b.Line || [])) {
            const ref = jobRefOnLine(l);
            if (!ref) continue;
            const m = (ref.name || '').match(jobNumberRe);
            if (!m) continue;
            out.push({ jobNumber: m[1], vendor, amount: num(l.Amount), due: b.DueDate, date: b.TxnDate, docNumber: b.DocNumber });
          }
        }
        return { source: `QuickBooks (${ENV})`, start, end: todayISO(), bills: out };
      }
      case 'invoices_by_job': {
        // Real per-job invoices for the last N days (default 45), matched via
        // the invoice's own top-level CustomerRef (the job sub-customer QBO
        // already bills the whole invoice to) -- same 'Job # NNNN' naming
        // pattern already proven out by bills_by_job/job_costing_summary above.
        // Powers the Schedule board's real money-due badge, replacing the old
        // hand-typed 'financial event' mockup (fake exact-time events like
        // 'Deposit cleared @ 9am'). QBO has no intraday event-log concept --
        // this returns exactly what's on the invoice (amount, balance, due
        // date), nothing simulated.
        const days = Math.max(1, Math.min(365, parseInt(opts.days, 10) || 45));
        const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const jobNumberRe = /Job\s*#\s*(\d+)/i;
        const q = await query(`SELECT DocNumber, TotalAmt, Balance, DueDate, TxnDate, CustomerRef FROM Invoice WHERE TxnDate >= '${start}' MAXRESULTS 1000`);
        const invoices = q.Invoice || [];
        const out = [];
        for (const i of invoices) {
          const ref = i.CustomerRef;
          if (!ref) continue;
          const m = (ref.name || '').match(jobNumberRe);
          if (!m) continue;
          out.push({ jobNumber: m[1], docNumber: i.DocNumber, total: num(i.TotalAmt), balance: num(i.Balance), due: i.DueDate, date: i.TxnDate });
        }
        return { source: `QuickBooks (${ENV})`, start, end: todayISO(), invoices: out };
      }
      case 'balance_sheet': {
        const rep = await report('BalanceSheet', { end_date: todayISO() });
        return { source: `QuickBooks (${ENV})`, as_of: todayISO(), rows: flattenReport(rep) };
      }
      case 'ar_aging': {
        const rep = await report('AgedReceivables');
        return { source: `QuickBooks (${ENV})`, ar_aging: flattenReport(rep) };
      }
      case 'ap_aging': {
        const rep = await report('AgedPayables');
        return { source: `QuickBooks (${ENV})`, ap_aging: flattenReport(rep) };
      }
      case 'summary':
      default: {
        const t = await validAccess();
        const [info, acctQ, plRep] = await Promise.all([
          apiGet(`companyinfo/${t.realm_id}?minorversion=${MINOR}`).catch(() => null),
          query("SELECT Name, AccountType, AccountSubType, CurrentBalance FROM Account WHERE Active = true").catch(() => ({})),
          report('ProfitAndLoss', { start_date: yearStartISO(), end_date: todayISO() }).catch(() => null),
        ]);
        const accts = acctQ.Account || [];
        const bank = accts.filter(a => a.AccountType === 'Bank');
        const cashInBank = sum(bank, a => a.CurrentBalance);
        const ar = sum(accts.filter(a => a.AccountType === 'Accounts Receivable'), a => a.CurrentBalance);
        const ap = sum(accts.filter(a => a.AccountType === 'Accounts Payable'), a => a.CurrentBalance);
        const depositAccts = accts.filter(a => /deposit/i.test(a.Name) && /liab/i.test(a.AccountType || ''));
        const unearnedDeposits = sum(depositAccts, a => a.CurrentBalance);
        const pl = plRep ? flattenReport(plRep) : [];
        const pick = (re) => { const row = pl.find(r => re.test(r.label)); return row ? row.amount : null; };
        return {
          source: `QuickBooks (${ENV})`,
          company: info && info.CompanyInfo ? info.CompanyInfo.CompanyName : null,
          cash_in_bank: cashInBank,
          bank_accounts: bank.map(a => ({ name: a.Name, balance: num(a.CurrentBalance) })),
          unearned_deposits_estimate: unearnedDeposits,
          deposit_accounts_matched: depositAccts.map(a => a.Name),
          true_cash_estimate: cashInBank - unearnedDeposits,
          accounts_receivable: ar,
          accounts_payable: ap,
          pnl_ytd: { total_income: pick(/total income/i), total_expenses: pick(/total expense/i), gross_profit: pick(/gross profit/i), net_income: pick(/net income/i) },
          period: `${yearStartISO()} -> ${todayISO()}`,
          note: 'true_cash_estimate subtracts deposit-named liability accounts -- confirm which account holds unearned deposits.',
        };
      }
    }
  } catch (e) {
    // Bug fix (2026-07-23): decide whether to keep the existing
    // "QuickBooks read failed:" prefix. Errors that came from a real QBO
    // API HTTP failure already carry a friendly, complete message (via
    // friendlyQboError() in apiGet(), marked by the presence of
    // e.qboStatus) -- prefixing those would just bury the plain-English
    // message under jargon again. Errors from anywhere else (e.g.
    // validAccess() throwing "QuickBooks is not connected yet...") keep the
    // old prefix unchanged. Either way the real status/raw QBO detail is
    // preserved on the response, never silently dropped.
    return {
      error: e.qboStatus ? e.message : `QuickBooks read failed: ${e.message}`,
      ...(e.qboStatus ? { qboStatus: e.qboStatus, qboRaw: e.qboRaw } : {}),
    };
  }
}

// ---------- route handler ----------

import { requireUser } from '../_lib/auth.js';
import { checkCronSecret } from '../_lib/guard.js';

export default async function handler(req, res) {
  try {
    const { code, realmId, error, resource, kind, start_date, end_date, summarize_by, accounting_method } = req.query;

    if (error) {
      // Item 5: escape the provider-supplied error before reflecting it.
      return res.status(400).send(`<h2>QuickBooks connection was not approved.</h2><p>${escapeHtml(error)}</p>`);
    }

    // Intuit's redirect back after the user approves. Item 5 (2026-08-01):
    // validate + single-use-consume the OAuth state before exchanging the
    // code — was previously exchanged with no state check at all (CSRF / code
    // injection). Reject missing/expired/reused/forged state.
    if (code && realmId) {
      const stateCheck = await consumeOAuthState({ provider: 'qbo', state: req.query.state });
      if (!stateCheck.ok) {
        return res.status(400).send(`<h2>QuickBooks connection could not be verified.</h2><p>${escapeHtml('Invalid or expired sign-in state (' + stateCheck.reason + '). Please start the connection again from HiveLogic.')}</p>`);
      }
      await exchangeCode(code, realmId);
      return res.status(200).send('<h2>QuickBooks is connected.</h2><p>You can close this tab.</p>');
    }

    // P0 security round 2 (2026-07-29): the data resources return real
    // QuickBooks financials -- require a signed-in session. The OAuth callback
    // (code & realmId, handled above) and the connect redirect (below) stay
    // public because Intuit itself calls them unauthenticated.
    if (resource === 'financials' || resource === 'status') {
      // Service reads (2026-08-15): /api/qbo is on the middleware's public
      // prefix list because Intuit calls the OAuth legs unauthenticated, so
      // these two data resources are gated HERE instead. Unattended read-only
      // checks carry no Supabase session, so they 401'd on every run -- accept
      // the same CRON_SECRET bearer api/snapshot.js already accepts. Narrow on
      // purpose: GET only, only these two read resources, and only as an
      // alternative to a real session -- never a write path, and a caller with
      // no valid secret still falls through to requireUser below. Fail-closed:
      // checkCronSecret returns false when CRON_SECRET is unset.
      const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
      const isServiceRead = String(req.method || 'GET').toUpperCase() === 'GET' && checkCronSecret(authHeader);
      if (!isServiceRead) {
        const _authedUser = await requireUser(req);
        if (!_authedUser) return res.status(401).json({ ok: false, error: 'Not signed in.' });
      }
    }

    // Live read: /api/qbo?resource=financials&kind=summary
    if (resource === 'financials') {
      const data = await getFinancials(kind || 'summary', { start_date, end_date, summarize_by, accounting_method });
      return res.status(data && data.error ? 502 : 200).json(data);
    }

    // Status check: /api/qbo?resource=status
    if (resource === 'status') {
      return res.status(200).json({
        configured: qboConfigured(),
        connected: await qboConnected(),
        environment: ENV,
      });
    }

    // No params at all -- start the OAuth flow. Item 5 (2026-08-01): issue a
    // random, single-use, short-lived state (was a static 'hivelogic-live').
    // This connect redirect stays public (Intuit's spec), so the state binds
    // to the initiating user only when a session is present; its single-use +
    // expiry still defeat callback CSRF / code replay.
    if (!qboConfigured()) {
      return res.status(500).send('<h2>QBO_CLIENT_ID / QBO_CLIENT_SECRET are not set for this deployment.</h2>');
    }
    let _connectUser = null;
    try { _connectUser = await requireUser(req); } catch { _connectUser = null; }
    const state = await issueOAuthState({ provider: 'qbo', userId: _connectUser && _connectUser.id });
    return res.redirect(authUrl(state));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
