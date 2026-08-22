// api/bookkeeping/reference-data.js — Vercel serverless function.
//
// Aggregates real QBO vendors + chart-of-accounts (via api/qbo/index.js's
// already-live getFinancials() -- the same authorized QBO connection every
// other real page in this app already uses: Financial Intelligence,
// api/track1.js's cash/forecast resources, the Vendor Catalog) and real
// synced Jobber jobs (via api/jobs.js's getJobsListData()) into the single
// resource=all shape public/app-bookkeeping.js and
// public/app-purchase-orders.js already expect and fetch on page load.
//
// Both frontend files were built (2026-07-22 expense/PO rebuild) already
// calling this exact URL, but the route itself was never created -- every
// request 404'd, which is why the Expense Entry vendor/account fields and
// the Purchase Orders vendor/job fields have been empty in production since
// that merge. This file closes that gap. It does NOT open a new QBO
// connection or add a second integration -- it only reads from the one
// already authorized and already working elsewhere in this app.
//
// Read-only, GET-only, resource=all is the only supported query today
// (matches the only value either frontend file ever sends). No actor/
// session check: neither frontend caller attaches an Authorization header
// for this specific request (unlike their write actions, which do), and
// this mirrors the current no-auth posture of /api/jobs and /api/clients
// elsewhere in this app -- not a new decision, just consistency with what
// already exists.

import { getFinancials } from '../qbo/index.js';
import { getJobsListData } from '../jobs.js';
import { guardBookkeepingRequest } from './_security.js';
import { requireApiAuth } from '../_lib/guard.js';

const BANK_ACCOUNT_TYPES = new Set(['Bank', 'Credit Card']);
const EXPENSE_ACCOUNT_TYPES = new Set(['Expense', 'Other Expense', 'Cost of Goods Sold']);

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  // Item 3 (2026-08-01): this route returns real QBO financials (vendors,
  // chart of accounts) and synced jobs, and previously ran with NO auth (see
  // the stale header note above). Require a signed-in employee now — the
  // in-app SPA already attaches the Supabase token to every /api call via its
  // global fetch shim, so this is transparent to signed-in users and closes
  // the anonymous-read hole. Belt-and-braces with the global /api middleware.
  const gate = await requireApiAuth(req);
  if (!gate.ok) { res.status(401).json({ ok: false, error: 'Not signed in — log into HiveLogic first.' }); return; }

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) {
    res.status(200).json({
      ok: true, enabled: false,
      vendors: [], jobs: [], expenseAccounts: [], bankAccounts: [],
      note: 'Bookkeeping preview is disabled. Set BOOKKEEPING_ENABLED=true to load real reference data.'
    });
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Only GET is supported for this route.' });
    return;
  }

  const resource = req.query.resource || 'all';
  if (resource !== 'all') {
    res.status(400).json({ ok: false, error: `Unknown resource "${resource}". Only resource=all is supported.` });
    return;
  }

  const [vendorsResult, accountsResult, jobsResult] = await Promise.allSettled([
    getFinancials('vendors'),
    getFinancials('accounts'),
    getJobsListData({ status: 'active', limit: 1000 })
  ]);

  const vendorsData = vendorsResult.status === 'fulfilled'
    ? (vendorsResult.value || {})
    : { error: vendorsResult.reason?.message || 'Vendor lookup failed.' };
  const accountsData = accountsResult.status === 'fulfilled'
    ? (accountsResult.value || {})
    : { error: accountsResult.reason?.message || 'Account lookup failed.' };
  const jobsData = jobsResult.status === 'fulfilled'
    ? (jobsResult.value || {})
    : { jobs: [] };

  const accounts = accountsData.accounts || [];

  res.status(200).json({
    ok: true,
    enabled: true,
    source: vendorsData.source || accountsData.source || null,
    vendors: vendorsData.vendors || [],
    vendorsError: vendorsData.error || null,
    expenseAccounts: accounts.filter(a => EXPENSE_ACCOUNT_TYPES.has(a.type)),
    bankAccounts: accounts.filter(a => BANK_ACCOUNT_TYPES.has(a.type)),
    accountsError: accountsData.error || null,
    jobs: (jobsData.jobs || []).map(j => ({ id: j.id, jobNumber: j.jobNumber, title: j.title }))
  });
}
