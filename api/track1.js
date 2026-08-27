// api/track1.js - Vercel serverless function
// Consolidates the 6 new Track-1 read routes (quotes, requests, visits,
// expenses, timesheets, users) into ONE serverless function instead of six.
//
// Why: Vercel's Hobby plan caps a deployment at 12 serverless functions total.
// The original one-file-per-resource design (matching clients.js/jobs.js/
// invoices.js's existing style) pushed the count to 15 and the deploy
// errored with "No more than 12 Serverless Functions can be added... on the
// Hobby plan" (confirmed via Vercel's own deploy log, 2026-07-16). Rather
// than ask Chris to upgrade to a paid plan for this, folding these 6 routes
// into one function is functionally identical and free.
//
// Usage: /api/track1?resource=quotes|requests|visits|expenses|timesheets|users&limit=...
//
// ALSO folds in the Financial Intelligence aggregation (resource=cash,
// resource=leaks -- Build-list #25 / GHOS System 1) for the same reason:
// a standalone api/fix.js would have been the 13th function and Vercel
// rejected the deploy ("No more than 12 Serverless Functions... Hobby
// plan", confirmed live 2026-07-17). Folded in here instead of into
// api/qbo/index.js because this file already has the Supabase
// pagination/shape pattern these two resources need; qbo/index.js is kept
// QBO-OAuth-only. LAW 1, applied literally: every number these two
// resources return is arithmetic over data already synced from real
// QuickBooks (via getFinancials, imported below) or real Jobber
// (Supabase). Anything the GHOS spec asks for that this app does NOT yet
// have a real source for (payroll, deposit-liability tracking, per-job
// cost coding, signed-backlog forecasting) comes back as a plain-English
// "not connected" note, never a fabricated number.
import { supabaseRequest, jobberGraphQL } from './_lib/jobber.js';
import { requireApiAuth, checkCronSecret } from './_lib/guard.js';
import { listFindings, setFindingStatus, createManualFinding, listFindingAttachments, addFindingAttachment } from './_lib/status-hub.js';
import { companySlugForUser } from './_lib/tenant.js';
import { createNativeJob } from './_lib/native-job.js';
import { jobRef } from './_lib/project-numbers.js';
import { invoiceAmountDue } from './_lib/invoice-balance.js';
import { twilioRequest } from './_lib/voice.js';
import { checkRateLimit } from './_lib/portal-auth.js';
import crypto from 'crypto';
import { provisionHiveConnectAccount, getMapping, postBotMessage } from './hiveconnect-bridge.js';
import { encryptSecret as _encSecret, decryptSecret as _decSecret } from './_lib/secrets.js';
import { mailboxAccessToken } from './_lib/ms-mailbox-tokens.js';
import { sendEmail, isEmailConfigured } from './_lib/email.js';
import { generateInvoicePdf } from './_lib/invoice-pdf.js';
import { getFinancials, getFinancialsDurable, qboConnected } from './qbo/index.js';
// Material Catalog & Procurement -- Vendor Catalog module (view-vcx). Folded
// in here for the same 12-function-cap reason as everything else in this
// file (see comment block above). Schema: sql/008_material_catalog.sql.
// Full design: reina/material-catalog-procurement-prd-2026-07-19.md +
// reina/vendor-integrations-deep-dive-2026-07-19.md (Build Reina project).
import { getAdapter, listAdapters, ADAPTERS } from './_lib/adapters/index.js';
import { hashAgentToken, generateAgentToken, generatePairingCode, validateScreenshotBase64, requireMonitorAgent, pruneMonitorData, MONITOR_RETENTION_DAYS } from './_lib/monitor.js';
import { isOwner, OWNER_NO_CLOCK_IN_MESSAGE } from './_lib/owner.js';
import { PAGE_BUILD, pageBuildState, shouldRecordPageBuild } from './_lib/page-build.js';
import { monitoringDecision, monitoringPolicy, CLOSE_REASON_DECLINED, CLOSE_REASONS_WORTH_EXPLAINING, CLOSE_NOTICE_WINDOW_MINUTES, closeReasonNotice } from './_lib/monitor-consent.js';
import { EXPECTED_AGENT_VERSION, isWellFormedAgentVersion, agentVersionState } from './_lib/agent-version.js';
import { VEHICLE_GPS_COLUMNS, VEHICLE_GPS_STALE_MS, vehicleGps } from './_lib/vehicle-gps.js';
import { todayRangeInTz, isValidTimeZone, DEFAULT_TIMEZONE } from './_lib/workday.js';
import { mergeSettings } from './user-settings.js';
export { VEHICLE_GPS_COLUMNS, VEHICLE_GPS_STALE_MS, vehicleGps } from './_lib/vehicle-gps.js';

const RESOURCE_CONFIG = {
  quotes: {
    table: 'quotes', order: 'jobber_updated_at.desc', defaultLimit: 50,
    notSyncedMsg: 'Quotes are not synced in this deployment yet.',
    shape: q => ({
      id: q.jobber_id, quoteNumber: q.quote_number, title: q.title, status: q.quote_status,
      total: q.total, clientId: q.client_id, clientName: q.client_name,
      jobberUrl: q.jobber_web_uri || null,
      createdAt: q.jobber_created_at, updatedAt: q.jobber_updated_at
    })
  },
  requests: {
    table: 'requests', order: 'jobber_updated_at.desc', defaultLimit: 50,
    notSyncedMsg: 'Requests are not synced in this deployment yet.',
    shape: r => ({
      id: r.jobber_id, title: r.title, status: r.request_status, clientId: r.client_id,
      jobberUrl: r.jobber_web_uri, createdAt: r.jobber_created_at, updatedAt: r.jobber_updated_at
    })
  },
  visits: {
    table: 'visits', order: 'start_at.asc', defaultLimit: 100,
    notSyncedMsg: 'Visits/schedule are not synced in this deployment yet.',
    shape: v => ({
      id: v.jobber_id, title: v.title, startAt: v.start_at, endAt: v.end_at,
      completedAt: v.completed_at, isAllDay: v.is_all_day, clientId: v.client_id,
      jobId: v.job_id, jobberUrl: v.jobber_web_uri
    })
  },
  expenses: {
    table: 'expenses', order: 'expense_date.desc', defaultLimit: 50,
    notSyncedMsg: 'Expenses are not synced in this deployment yet.',
    shape: e => ({
      id: e.jobber_id, title: e.title, total: e.total, date: e.expense_date,
      reimbursableToUser: e.reimbursable_to_user, jobId: e.job_id
    }),
    extra: rows => ({ totalAmount: Math.round(rows.reduce((s, e) => s + (Number(e.total) || 0), 0) * 100) / 100 })
  },
  timesheets: {
    table: 'time_sheet_entries', order: 'start_at.desc', defaultLimit: 50,
    notSyncedMsg: 'Timesheets are not synced in this deployment yet.',
    shape: t => ({
      id: t.jobber_id, startAt: t.start_at, endAt: t.end_at,
      durationSeconds: t.final_duration, userId: t.user_id, jobId: t.job_id
    })
  },
  users: {
    table: 'users', order: 'name.asc', defaultLimit: 100,
    notSyncedMsg: 'Users/team are not synced in this deployment yet.',
    shape: u => ({ id: u.jobber_id, name: u.name, email: u.email })
  }
};

// ---------- Financial Intelligence (resource=cash, resource=leaks) ----------

const FI_PAGE = 1000;
const FI_MAX_PAGES = 10; // safety cap: 10k rows, well above current table sizes

function fiNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fiRound2(v) { return Math.round(fiNum(v) * 100) / 100; }
function fiTodayISO() { return new Date().toISOString().slice(0, 10); }
function fiAddDaysISO(days) { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function fiDaysAgo(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

// Paginates a Supabase/PostgREST table with a `select=` + filter query string
// already built by the caller, looping on `offset` until a short page comes
// back. Needed because PostgREST's own default row cap (1000) silently
// truncates a single request long before these tables' real row counts
// (jobs: ~2,700 / invoices: ~2,700).
async function fiFetchAllRows(table, query) {
  let all = [];
  for (let page = 0; page < FI_MAX_PAGES; page++) {
    const offset = page * FI_PAGE;
    const sep = query.includes('?') ? '&' : '?';
    const r = await supabaseRequest(`${table}${query}${sep}limit=${FI_PAGE}&offset=${offset}`);
    if (!r.ok) throw new Error(`${table} query failed: ${await r.text()}`);
    const rows = await r.json();
    all = all.concat(rows);
    if (rows.length < FI_PAGE) break;
  }
  return all;
}

// True available cash + the next-8-weeks bill commitments calendar. Only
// the pieces below are wired to a real source; payroll and client-deposit
// liability are explicitly reported as not connected rather than guessed.
async function handleFiCash(res) {
  if (!(await qboConnected())) {
    return res.status(200).json({ ok: false, error: 'QuickBooks is not connected yet. Visit /api/qbo to authorize.' });
  }

  const [acctData, billsNear, bills8wk] = await Promise.all([
    getFinancials('accounts'),
    getFinancials('bills_due_range', { start_date: fiTodayISO(), end_date: fiAddDaysISO(14) }),
    getFinancials('bills_due_range', { start_date: fiTodayISO(), end_date: fiAddDaysISO(56) }),
  ]);
  if (acctData.error) return res.status(502).json({ ok: false, error: acctData.error });
  if (billsNear.error) return res.status(502).json({ ok: false, error: billsNear.error });
  if (bills8wk.error) return res.status(502).json({ ok: false, error: bills8wk.error });

  const accounts = acctData.accounts || [];
  const bankBalance = fiRound2(accounts.filter(a => a.type === 'Bank').reduce((s, a) => s + a.balance, 0));
  const bankAccounts = accounts.filter(a => a.type === 'Bank' && a.balance !== 0)
    .map(a => ({ name: a.name, balance: fiRound2(a.balance) }))
    .sort((a, b) => b.balance - a.balance);

  // Real CT/FL tax-liability accounts in the chart of accounts -- matched by
  // name, not invented. If Chris's books ever rename/add one, it's picked up
  // automatically; if none match, this is honestly $0, not a guess.
  const taxAccts = accounts.filter(a => /sales tax payable|commissioner of revenue|department of revenue/i.test(a.name));
  const taxLiabilities = fiRound2(taxAccts.reduce((s, a) => s + Math.abs(a.balance), 0));

  const billsDue14 = fiRound2(billsNear.total_balance);
  const trueAvailable = fiRound2(bankBalance - billsDue14 - taxLiabilities);

  // 8-week commitments calendar, bucketed from the SAME real bill list --
  // no separate fabricated numbers. Week labels are real calendar weeks
  // starting today; the "why" text lists the real vendors due that week
  // (top 3 by $), not invented categories like "payroll".
  const weeks = [];
  for (let w = 0; w < 8; w++) {
    const startD = new Date(); startD.setUTCDate(startD.getUTCDate() + w * 7);
    const endD = new Date(); endD.setUTCDate(endD.getUTCDate() + w * 7 + 6);
    const startStr = startD.toISOString().slice(0, 10);
    const endStr = endD.toISOString().slice(0, 10);
    const inWeek = (bills8wk.bills || []).filter(b => b.due >= startStr && b.due <= endStr);
    const total = fiRound2(inWeek.reduce((s, b) => s + b.balance, 0));
    const byVendor = {};
    for (const b of inWeek) byVendor[b.vendor || 'Unknown vendor'] = (byVendor[b.vendor || 'Unknown vendor'] || 0) + b.balance;
    const topVendors = Object.entries(byVendor).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v]) => v);
    weeks.push({ weekStart: startStr, total, billCount: inWeek.length, topVendors });
  }

  return res.status(200).json({
    ok: true,
    source: 'QuickBooks (bank + bills) -- live',
    asOf: new Date().toISOString(),
    bankBalance,
    bankAccounts,
    billsDue14,
    billsDue14Count: (billsNear.bills || []).length,
    taxLiabilities,
    taxAccounts: taxAccts.map(a => ({ name: a.name, balance: fiRound2(Math.abs(a.balance)) })),
    trueAvailable,
    weeks,
    notConnected: {
      payroll: 'No payroll system (Gusto/ADP/etc.) is connected -- upcoming payroll runs cannot be subtracted yet.',
      depositsHeld: 'Jobber sync does not yet capture a deposit/retainer flag per invoice or job -- client deposits held as a liability cannot be isolated from total cash yet.',
      debtService: 'Loan balances are in QuickBooks (see chart of accounts), but amortization schedules/next-payment amounts are not synced, so a monthly debt-service figure cannot be computed yet.',
    },
  });
}

// Cash-leak radar: only the two leaks this app can compute honestly today.
async function handleFiLeaks(res) {
  const [jobsDone, pastDue, badDebt, linkedInv] = await Promise.all([
    fiFetchAllRows('jobs', '?select=jobber_id,job_number,title,total,completed_at,jobber_web_uri,client_id&job_status=eq.requires_invoicing&order=completed_at.desc'),
    fiFetchAllRows('invoices', '?select=jobber_id,invoice_number,subject,total,payments,deposit,discount,due_date,invoice_status,client_id,jobber_web_uri&invoice_status=eq.past_due&order=due_date.asc'),
    fiFetchAllRows('invoices', '?select=jobber_id,invoice_number,subject,total,due_date,client_id&invoice_status=eq.bad_debt&order=due_date.asc'),
    fiFetchAllRows('invoices', '?select=job_id,total&job_id=not.is.null'),
  ]);

  const nonZero = jobsDone.filter(j => fiNum(j.total) > 0);
  const zeroValue = jobsDone.length - nonZero.length;
  // 2026-07-31: invoices.job_id is now synced, so we can see how much of each
  // requires_invoicing job is ALREADY billed -- most of the old headline number
  // was fully-billed jobs nobody closed in Jobber.
  const billedByJob = {};
  for (const inv of linkedInv) { if (inv.job_id) billedByJob[inv.job_id] = (billedByJob[inv.job_id] || 0) + fiNum(inv.total); }
  const remainingOf = (j) => Math.max(0, fiNum(j.total) - (billedByJob[j.jobber_id] || 0));
  const completedNotInvoiced = {
    count: jobsDone.length,
    nonZeroCount: nonZero.length,
    sumOfPricedJobs: fiRound2(nonZero.reduce((s, j) => s + fiNum(j.total), 0)),
    sumRemainingToBill: fiRound2(nonZero.reduce((s, j) => s + remainingOf(j), 0)),
    alreadyBilledJobs: nonZero.filter(j => remainingOf(j) <= 0.01).length,
    zeroValueCount: zeroValue,
    note: zeroValue > 0
      ? `${zeroValue} of ${jobsDone.length} finished jobs show $0 in Jobber because pricing wasn't entered until invoicing (mostly T&M/handyman visits) -- the dollar total below is a floor, not the true leak size.`
      : null,
    sample: jobsDone.slice(0, 25).map(j => ({
      jobNumber: j.job_number, title: j.title, total: fiRound2(j.total),
      completedDaysAgo: fiDaysAgo(j.completed_at), url: j.jobber_web_uri,
    })),
  };

  const fiBucket = (rows) => {
    const b = { d0_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    for (const r of rows) {
      const age = fiDaysAgo(r.due_date) || 0;
      const amt = Math.max(0, fiNum(r.total) - fiNum(r.payments || 0) - fiNum(r.deposit || 0) - fiNum(r.discount || 0));
      if (age <= 30) b.d0_30 += amt; else if (age <= 60) b.d31_60 += amt; else if (age <= 90) b.d61_90 += amt; else b.d90plus += amt;
    }
    for (const k in b) b[k] = fiRound2(b[k]);
    return b;
  };

  const pastDueInvoices = {
    count: pastDue.length,
    sum: fiRound2(pastDue.reduce((s, i) => s + Math.max(0, fiNum(i.total) - fiNum(i.payments || 0) - fiNum(i.deposit || 0) - fiNum(i.discount || 0)), 0)),
    aging: fiBucket(pastDue),
    sample: pastDue.slice(0, 25).map(i => ({
      invoiceNumber: i.invoice_number, subject: i.subject, amount: fiRound2(Math.max(0, fiNum(i.total) - fiNum(i.payments || 0) - fiNum(i.deposit || 0) - fiNum(i.discount || 0))),
      daysOverdue: fiDaysAgo(i.due_date), url: i.jobber_web_uri,
    })),
  };

  const badDebtInvoices = {
    count: badDebt.length,
    sum: fiRound2(badDebt.reduce((s, i) => s + fiNum(i.total), 0)),
    note: 'Already written off in Jobber as bad debt -- shown separately, not counted in the collectible past-due total above.',
  };

  return res.status(200).json({
    ok: true,
    source: 'Jobber via Supabase -- live',
    asOf: new Date().toISOString(),
    completedNotInvoiced,
    pastDueInvoices,
    badDebtInvoices,
    notConnected: {
      changeOrders: 'Change-order documents/signature status are not synced from Jobber yet.',
      cardFees: 'Payment method (card vs. ACH) per transaction is not synced from Jobber/QuickBooks yet.',
      stalePriceBook: 'No price-book / vendor-catalog sync exists yet -- there is nothing to compare current prices against.',
    },
  });
}

// Owner Cost % -- the one CEO-cockpit metric this app can compute for real
// today (owner's draw as a share of real YTD overhead, both straight from
// QuickBooks). Everything else the GHOS spec asks for on this tab needs
// either per-job cost-driver data that isn't synced yet, or a business
// threshold only Chris can set -- those come back as honest notAvailable
// reasons instead of an invented number/verdict.
async function handleFiOverhead(res) {
  if (!(await qboConnected())) {
    return res.status(200).json({ ok: false, error: 'QuickBooks is not connected yet. Visit /api/qbo to authorize.' });
  }
  const [acctData, plData] = await Promise.all([
    getFinancials('accounts'),
    getFinancials('profit_and_loss'),
  ]);
  if (acctData.error) return res.status(502).json({ ok: false, error: acctData.error });
  if (plData.error) return res.status(502).json({ ok: false, error: plData.error });

  const accounts = acctData.accounts || [];
  const ownerAccts = accounts.filter(a => a.type === 'Equity' && /draw|owner/i.test(a.name));
  const ownerDraw = fiRound2(ownerAccts.reduce((s, a) => s + Math.abs(a.balance), 0));

  const rows = plData.rows || [];
  const totalExpenseRow = rows.find(r => /^total expenses$/i.test(r.label));
  const totalOverheadYTD = totalExpenseRow ? fiRound2(totalExpenseRow.amount) : null;
  const ownerCostPct = totalOverheadYTD ? fiRound2((ownerDraw / totalOverheadYTD) * 100) : null;

  return res.status(200).json({
    ok: true,
    source: 'QuickBooks -- live',
    period: plData.period,
    ownerDrawAccounts: ownerAccts.map(a => ({ name: a.name, balance: fiRound2(Math.abs(a.balance)) })),
    ownerDraw,
    totalOverheadYTD,
    ownerCostPct,
    notAvailable: {
      dynamicAllocation: 'Per-job cost drivers (PM time logged, permit/inspection events) are not synced yet -- QuickBooks Class tracking on this account is empty, and every synced Jobber expense has no job link (job_id is null). A real per-job overhead split needs one of those wired first.',
      canWeHire: 'No defined "fully-loaded new seat" cost has been set. Give Reina a number (e.g. $9,100/mo for an electrician) and this becomes a live, computed yes/no against real operating profit.',
      canWeExpand: 'No defined "safe cash reserve" threshold has been set. Give Reina a number and this becomes a live, computed check against true available cash + trailing operating profit.',
    },
  });
}

// Near-term (8-week) real cash-in vs. cash-out, built from open QuickBooks
// invoices/bills due in that window -- NOT a 12-month forecast. A longer
// horizon needs a signed-backlog data model (what counts as "signed"?
// quotes accepted, deposits paid?) that isn't configured, so it is
// reported honestly as not available rather than guessed at.
async function handleFiForecast(res) {
  if (!(await qboConnected())) {
    return res.status(200).json({ ok: false, error: 'QuickBooks is not connected yet. Visit /api/qbo to authorize.' });
  }
  const [billsData, invoicesData, approvedQuotes, openJobs] = await Promise.all([
    getFinancials('bills_due_range', { start_date: fiTodayISO(), end_date: fiAddDaysISO(56) }),
    getFinancials('invoices_due_range', { start_date: fiTodayISO(), end_date: fiAddDaysISO(56) }),
    // Chris's rule for "signed": a client-approved quote is real future work,
    // even before it's scheduled or invoiced. quote_status is Jobber's own
    // string, synced verbatim (see api/jobber/sync-extended.js mapQuote) --
    // matched case-insensitively since the exact casing Jobber returns
    // hasn't been pinned down byte-for-byte the way jobStatus/invoiceStatus
    // have elsewhere in this file.
    fiFetchAllRows('quotes', '?select=jobber_id,quote_number,title,total,client_id,client_name,jobber_updated_at&quote_status=ilike.approved&order=jobber_updated_at.desc'),
    // Real scheduled work: a job (already converted from a quote) that
    // hasn't completed yet. start_at/total are both synced straight from
    // Jobber (api/jobber/sync.js mapJob) -- no invented dates, no invented
    // dollars.
    fiFetchAllRows('jobs', '?select=jobber_id,job_number,title,total,start_at,completed_at,jobber_web_uri,client_id&completed_at=is.null&order=start_at.asc'),
  ]);
  if (billsData.error) return res.status(502).json({ ok: false, error: billsData.error });
  if (invoicesData.error) return res.status(502).json({ ok: false, error: invoicesData.error });

  const weeks = [];
  for (let w = 0; w < 8; w++) {
    const startD = new Date(); startD.setUTCDate(startD.getUTCDate() + w * 7);
    const endD = new Date(); endD.setUTCDate(endD.getUTCDate() + w * 7 + 6);
    const startStr = startD.toISOString().slice(0, 10);
    const endStr = endD.toISOString().slice(0, 10);
    const outThisWeek = (billsData.bills || []).filter(b => b.due >= startStr && b.due <= endStr);
    const inThisWeek = (invoicesData.invoices || []).filter(i => i.due >= startStr && i.due <= endStr);
    const cashOut = fiRound2(outThisWeek.reduce((s, b) => s + b.balance, 0));
    const cashIn = fiRound2(inThisWeek.reduce((s, i) => s + i.balance, 0));
    weeks.push({ weekStart: startStr, cashIn, cashOut, net: fiRound2(cashIn - cashOut) });
  }

  // ---- Backlog beyond 8 weeks (Chris's spec, 2026-07-22): "work approved" ----
  // is real signed revenue even with no invoice yet. Two honest buckets,
  // never blended into one number that hides which dollars have a real
  // date behind them:
  //
  //   scheduledNotYetInvoiced -- a job already exists (quote converted),
  //     it has a real start_at from Jobber, and it hasn't completed yet.
  //     Bucketed into real calendar weeks/months by that real date.
  //     The dollar figure is the job's total per Jobber, which is the
  //     estimate at time of scheduling -- it can differ from what's
  //     eventually invoiced (change orders, T&M overages, etc.), and this
  //     is labeled as such rather than presented as guaranteed cash.
  //
  //   approvedNotYetScheduled -- a quote the client has approved, but it
  //     hasn't been converted into a job yet, so there is no real date to
  //     bucket it by. Still real signed work; shown as backlog with
  //     "timing not yet on the calendar" rather than guessed at.
  const horizonEnd = fiAddDaysISO(56);
  const scheduledJobs = openJobs.filter(j => j.start_at && j.start_at.slice(0, 10) > horizonEnd && fiNum(j.total) > 0);

  const BACKLOG_BUCKET_DAYS = 28; // ~4-week buckets beyond the 8-week weekly view, so the backlog table doesn't sprawl into 40+ rows
  const BACKLOG_BUCKET_COUNT = 6; // ~24 more weeks of visibility (roughly to the 32-week mark)
  const backlogBuckets = [];
  for (let b = 0; b < BACKLOG_BUCKET_COUNT; b++) {
    const startD = new Date(); startD.setUTCDate(startD.getUTCDate() + 56 + b * BACKLOG_BUCKET_DAYS);
    const endD = new Date(); endD.setUTCDate(endD.getUTCDate() + 56 + b * BACKLOG_BUCKET_DAYS + (BACKLOG_BUCKET_DAYS - 1));
    const startStr = startD.toISOString().slice(0, 10);
    const endStr = endD.toISOString().slice(0, 10);
    const inBucket = scheduledJobs.filter(j => { const d = j.start_at.slice(0, 10); return d >= startStr && d <= endStr; });
    backlogBuckets.push({
      bucketStart: startStr,
      bucketEnd: endStr,
      jobCount: inBucket.length,
      total: fiRound2(inBucket.reduce((s, j) => s + fiNum(j.total), 0)),
      jobs: inBucket.slice(0, 10).map(j => ({ jobNumber: j.job_number, title: j.title, total: fiRound2(j.total), startAt: j.start_at, url: j.jobber_web_uri }))
    });
  }
  // Anything scheduled further out than the bucket window still counts in
  // the total -- it's just not broken into its own row, to keep the table
  // readable. Nothing is silently dropped from the dollar totals below.
  const scheduledTotal = fiRound2(scheduledJobs.reduce((s, j) => s + fiNum(j.total), 0));
  const bucketedTotal = fiRound2(backlogBuckets.reduce((s, b) => s + b.total, 0));
  const beyondBucketWindow = fiRound2(scheduledTotal - bucketedTotal);

  const approvedTotal = fiRound2(approvedQuotes.reduce((s, q) => s + fiNum(q.total), 0));
  const backlogTotal = fiRound2(scheduledTotal + approvedTotal);

  // Confidence score, computed the way GHOS law asks: the real basis is
  // "how much of this backlog dollar figure sits on an actual calendar
  // date vs. is still just a client's yes with no start date yet." A
  // scheduled job is a much firmer number than an approved-but-unscheduled
  // quote, so this is a schedule-coverage ratio, not a guess.
  const confidenceScore = backlogTotal > 0 ? Math.round((scheduledTotal / backlogTotal) * 100) : null;

  return res.status(200).json({
    ok: true,
    source: 'QuickBooks (open invoices + open bills) + Jobber (approved quotes + scheduled jobs) -- live',
    asOf: new Date().toISOString(),
    horizonDays: 56,
    weeks,
    backlog: {
      scheduledNotYetInvoiced: {
        count: scheduledJobs.length,
        total: scheduledTotal,
        buckets: backlogBuckets,
        beyondBucketWindow,
        note: 'Job total from Jobber (real, scheduled start date), not yet invoiced -- the actual invoiced amount can differ once billed (change orders, T&M overages, etc.).'
      },
      approvedNotYetScheduled: {
        count: approvedQuotes.length,
        total: approvedTotal,
        sample: approvedQuotes.slice(0, 25).map(q => ({ quoteNumber: q.quote_number, title: q.title, total: fiRound2(q.total), clientName: q.client_name })),
        note: 'Client-approved quotes with no job/start date yet -- real signed work, but there is no calendar date to bucket it by until it\'s scheduled.'
      },
      backlogTotal,
      confidenceScore,
      confidenceNote: confidenceScore != null
        ? confidenceScore + '% of forecasted backlog dollars sit on a real scheduled date; the rest (' + (100 - confidenceScore) + '%) is signed but not yet on the calendar.'
        : 'No approved or scheduled backlog to score yet.'
    },
    notAvailable: {
      unquotedPipeline: 'Leads/requests that have not yet reached an approved quote are not counted here -- this is signed backlog only, never a sales-pipeline guess.',
      revisedInvoiceAmounts: 'Scheduled-job dollars above are Jobber\'s job total at time of scheduling, not a re-forecast of what will actually be invoiced -- change orders and T&M overages are not reflected until they\'re billed.'
    },
  });
}

// ---------- Map: real service-area hot spots ----------
// Aggregates geocoded client_locations (from sync-extended.js's ?resource=
// locations + ?resource=geocode) with real job counts/$ from the jobs table,
// grouped by city so the map shows real towns instead of the old hardcoded
// demo clusters. Distance is straight-line (haversine), not real drive time
// -- same honest approximation the original mock's "15 mi radius" implied,
// just computed from real coordinates now instead of an illustration.
function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function handleMapLocations(res) {
  try {
        const [officeRes, locations, jobs, clientRows, visitRows] = await Promise.all([
      supabaseRequest('office_location?id=eq.hq&select=*'),
            fiFetchAllRows('client_locations', '?lat=not.is.null&select=jobber_id,street,city,province,lat,lng'), // paginated -- PostgREST caps a single request at 1000 rows, but geocoded clients exceed that. street added so map pins/popups can show a real address, not just city.
      // Active only -- completed_at is null. A map of every job ever done is a
      // lot less useful than "here's where the open work actually is."
            fiFetchAllRows('jobs', '?completed_at=is.null&select=jobber_id,client_id,job_number,title,job_status,total,jobber_web_uri'),
      // Client names for the map popup -- same name-shape logic as api/jobs.js's fetchAllClientNames, duplicated locally to keep this endpoint self-contained.
            fiFetchAllRows('clients', '?select=jobber_id,name,first_name,last_name,company_name'),
      // Assigned techs + next scheduled visit per job, for the map List view.
            fiFetchAllRows('visits', '?completed_at=is.null&select=job_id,start_at,assigned_users'),
    ]);
        if (!officeRes.ok) {
            const text = await officeRes.text();
      return res.status(500).json({ ok: false, error: text });
    }
    const officeRows = await officeRes.json();
    const office = officeRows[0] || null;

    const byClient = {};
    for (const loc of locations) byClient[loc.jobber_id] = loc;

    const nameByClient = {};
    for (const c2 of clientRows) {
      const nm = c2.name || [c2.first_name, c2.last_name].filter(Boolean).join(' ') || c2.company_name || null;
      if (nm) nameByClient[c2.jobber_id] = nm;
    }

    // Next scheduled visit + assigned tech names per job (List view columns).
    // "Next" = earliest visit from ~today forward; falls back to the most
    // recent past one so a slipped job still shows when it WAS planned.
    const nowMs = Date.now() - 12 * 3600 * 1000;
    const visitByJob = {};
    const techsByJob = {};
    for (const v of (visitRows || [])) {
      if (!v.job_id) continue;
      for (const u of (v.assigned_users || [])) {
        if (u && u.name) (techsByJob[v.job_id] = techsByJob[v.job_id] || new Set()).add(u.name);
      }
      if (!v.start_at) continue;
      const t = new Date(v.start_at).getTime();
      const fut = t >= nowMs;
      const cur = visitByJob[v.job_id];
      if (!cur) { visitByJob[v.job_id] = { t, fut }; continue; }
      if (fut && (!cur.fut || t < cur.t)) visitByJob[v.job_id] = { t, fut: true };
      else if (!fut && !cur.fut && t > cur.t) visitByJob[v.job_id] = { t, fut: false };
    }

    // Individual pins -- one per active job with a geocoded client address.
    // No jitter here anymore: jobs at the identical address share the exact
    // same lat/lng on purpose. The frontend groups points by clientId and
    // renders ONE marker per real-world address (with a Jobber-style count
    // badge + a stacked job list in the popup) instead of faking separation
    // with an offset that used to read as "different addresses" (Chris
    // flagged this twice, 2026-07-25 -- jitter was the wrong tool for this).
    const points = [];
    const clusters = {};
    for (const j of jobs) {
      const loc = j.client_id && byClient[j.client_id];
      if (!loc) continue;
      points.push({
        jobId: j.jobber_id,
        jobNumber: j.job_number,
        title: j.title,
        status: j.job_status,
        total: Number(j.total) || 0,
        clientId: j.client_id,
        clientName: (j.client_id && nameByClient[j.client_id]) || null,
        street: loc.street || null,
        city: loc.city, province: loc.province,
        address: [loc.street, [loc.city, loc.province].filter(Boolean).join(', ')].filter(Boolean).join(', ') || null,
        lat: loc.lat,
        lng: loc.lng,
        jobberUrl: j.jobber_web_uri || null,
        nextVisitAt: visitByJob[j.jobber_id] ? new Date(visitByJob[j.jobber_id].t).toISOString() : null,
        techs: techsByJob[j.jobber_id] ? Array.from(techsByJob[j.jobber_id]).join(', ') : null,
      });

      const key = `${loc.city || 'Unknown'}, ${loc.province || ''}`.trim();
      if (!clusters[key]) {
        clusters[key] = { city: loc.city || 'Unknown', province: loc.province || null, jobCount: 0, jobTotal: 0, latSum: 0, lngSum: 0, points: 0 };
      }
      clusters[key].jobCount++;
      clusters[key].jobTotal += Number(j.total) || 0;
      clusters[key].latSum += loc.lat;
      clusters[key].lngSum += loc.lng;
      clusters[key].points++;
    }

    const clusterList = Object.values(clusters).map((c) => {
      const lat = c.latSum / c.points;
      const lng = c.lngSum / c.points;
      return {
        city: c.city,
        province: c.province,
        jobCount: c.jobCount,
        jobTotal: Math.round(c.jobTotal * 100) / 100,
        lat, lng,
        distanceMi: office && office.lat != null ? Math.round(haversineMiles(office.lat, office.lng, lat, lng) * 10) / 10 : null,
      };
    }).sort((a, b) => b.jobCount - a.jobCount);

    res.status(200).json({
      ok: true,
      source: 'Jobber via Supabase (real client addresses, US Census geocoding)',
      office: office ? { address: office.address, lat: office.lat, lng: office.lng } : null,
      geocodedClients: locations.length,
      jobsWithLocation: points.length,
      activeJobsTotal: jobs.length,
      points,
      clusters: clusterList,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

// ---- Daily-brief cache ----------------------------------------------------
// The brief is expensive (3 live QuickBooks reports + table scans). Cache the
// finished payload for 10 minutes so only the first viewer of a cycle pays.
const FI_BRIEF_TTL_MS = 10 * 60 * 1000;
function fiBriefCacheHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json',
  };
}
async function fiBriefCacheRead() {
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/fi_brief_cache?id=eq.dailybrief&select=payload,computed_at', { headers: fiBriefCacheHeaders() });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows.length || !rows[0].payload) return null;
    const age = Date.now() - new Date(rows[0].computed_at).getTime();
    if (!(age >= 0) || age > FI_BRIEF_TTL_MS) return null;
    return { payload: rows[0].payload, ageSeconds: Math.round(age / 1000) };
  } catch (e) { return null; }
}
async function fiBriefCacheWrite(payload) {
  try {
    await fetch(process.env.SUPABASE_URL + '/rest/v1/fi_brief_cache', {
      method: 'POST',
      headers: { ...fiBriefCacheHeaders(), Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ id: 'dailybrief', payload, computed_at: new Date().toISOString() }),
    });
  } catch (e) { /* cache is best-effort; never fail the brief over it */ }
}

async function handleFiDailyBrief(res) {
    const fiCachedBrief = await fiBriefCacheRead();
    if (fiCachedBrief) {
      const p = fiCachedBrief.payload;
      p.cached = true;
      p.cacheAgeSeconds = fiCachedBrief.ageSeconds;
      return res.status(200).json(p);
    }
    const asOf = new Date().toISOString();
    const todayStart = fiTodayISO();
    const todayEnd = fiAddDaysISO(1);
    const notConnected = {};
    let cash = null;
    let cashRunway = null;
    let pastDueInvoices = null;
    let completedNotInvoiced = null;
    let todaysVisits = null;
    let openQuotes = null;
    let stalledJobs = null;
  
    let briefWeather = null;

    // Perf (2026-08-04): these six data-gathering blocks are fully
    // independent -- none reads another block's result; they only get combined
    // at the decisions/headline assembly below, and each writes its own
    // outer-scoped vars plus a distinct notConnected key. They used to run
    // sequentially, so the cache-miss brief cost the SUM of all six
    // (QuickBooks cold + several full-table Supabase scans + weather) -- ~a
    // minute, which is exactly what the first viewer of each 10-minute cache
    // cycle paid. Running them concurrently in one Promise.all drops that to
    // roughly the slowest single block (the QuickBooks reports). Each block
    // keeps its own try/catch, so a single source failing still degrades to
    // its notConnected note without taking the others down -- behaviour and
    // the emitted payload are unchanged; only the wall-clock differs.
    await Promise.all([
      (async () => {
        try {
          if (await qboConnected()) {
                  const [acctData, billsNear, plData] = await Promise.all([
                            getFinancials('accounts'),
                            getFinancials('bills_due_range', { start_date: fiTodayISO(), end_date: fiAddDaysISO(14) }),
                            getFinancials('profit_and_loss'),
                          ]);
                  if (acctData.error || billsNear.error) {
                            notConnected.cash = 'QuickBooks responded but returned an error -- cash figures skipped this brief.';
                  } else {
                            const accounts = acctData.accounts || [];
                            const bankBalance = fiRound2(accounts.filter(a => a.type === 'Bank').reduce((s, a) => s + a.balance, 0));
                            const billsDue14 = fiRound2((billsNear.bills || []).reduce((s, b) => s + fiNum(b.amount), 0));
                            cash = { bankBalance, billsDue14, billsDue14Count: (billsNear.bills || []).length };

                            if (!plData.error) {
                                      const plRows = plData.rows || [];
                                      const totalExpenseRow = plRows.find(r => /^total expenses$/i.test(r.label));
                                      let totalOverheadYTD = totalExpenseRow ? fiNum(totalExpenseRow.amount) : null;
                                      const jan1 = new Date(new Date().getFullYear(), 0, 1);
                                      const elapsedWeeks = Math.max(1, (Date.now() - jan1.getTime()) / (7 * 86400000));
                                      if (totalOverheadYTD && totalOverheadYTD > 0) {
                                                const weeklyRunRate = fiRound2(totalOverheadYTD / elapsedWeeks);
                                                const runwayWeeks = weeklyRunRate > 0 ? fiRound2(bankBalance / weeklyRunRate) : null;
                                                let level = 'healthy';
                                                if (runwayWeeks != null) {
                                                          if (runwayWeeks < 2) level = 'crisis';
                                                          else if (runwayWeeks < 4) level = 'red';
                                                          else if (runwayWeeks < 8) level = 'watch';
                                                          else level = 'healthy';
                                                }
                                                cashRunway = {
                                                          weeklyRunRate,
                                                          runwayWeeks,
                                                          level,
                                                          period: plData.period,
                                                          note: 'Derived estimate: YTD QuickBooks overhead / elapsed weeks since Jan 1 -- not a tracked weekly burn rate. Thresholds: >=8wk healthy, 4-8wk watch, <4wk RED ALERT, <2wk crisis.',
                                                };
                                      }
                            }
                  }
          } else {
                  notConnected.cash = 'QuickBooks is not connected yet. Visit /api/qbo to authorize.';
          }
        } catch (e) {
          notConnected.cash = 'QuickBooks lookup failed: ' + e.message;
        }
      })(),

      (async () => {
        try {
          const [jobsDone, pastDue, linkedInv2] = await Promise.all([
                  fiFetchAllRows('jobs', '?select=jobber_id,title,total,completed_at&job_status=eq.requires_invoicing&order=completed_at.desc'),
                  fiFetchAllRows('invoices', '?select=jobber_id,invoice_number,total,payments,deposit,discount,due_date&invoice_status=eq.past_due&order=due_date.asc'),
                  fiFetchAllRows('invoices', '?select=job_id,total&job_id=not.is.null'),
                ]);
          const nonZero = jobsDone.filter(j => fiNum(j.total) > 0);
          const billedByJob2 = {}; for (const inv of linkedInv2) { if (inv.job_id) billedByJob2[inv.job_id] = (billedByJob2[inv.job_id] || 0) + fiNum(inv.total); }
          const remainingOf2 = (j) => Math.max(0, fiNum(j.total) - (billedByJob2[j.jobber_id] || 0));
          completedNotInvoiced = { count: jobsDone.length, sumOfPricedJobs: fiRound2(nonZero.reduce((s, j) => s + fiNum(j.total), 0)), sumRemainingToBill: fiRound2(nonZero.reduce((s, j) => s + remainingOf2(j), 0)), alreadyBilledJobs: nonZero.filter(j => remainingOf2(j) <= 0.01).length };
          pastDueInvoices = { count: pastDue.length, sum: fiRound2(pastDue.reduce((s, i) => s + Math.max(0, fiNum(i.total) - fiNum(i.payments) - fiNum(i.deposit || 0) - fiNum(i.discount || 0)), 0)) };
        } catch (e) {
          notConnected.jobberLeaks = 'Jobber lookup failed: ' + e.message;
        }
      })(),

      (async () => {
        try {
          const stallThreshold = new Date(Date.now() - 3 * 86400000).toISOString();
          const candidates = await fiFetchAllRows('jobs', '?select=jobber_id,job_number,title,job_status,jobber_updated_at&job_status=in.(active,late,today)&jobber_updated_at=lt.' + stallThreshold + '&order=jobber_updated_at.asc');
          if (candidates.length) {
                  const recentMedia = await fiFetchAllRows('media', '?select=job_id,captured_at,created_at&or=(captured_at.gte.' + stallThreshold + ',created_at.gte.' + stallThreshold + ')');
                  const recentJobIds = new Set(recentMedia.map(m => m.job_id).filter(Boolean));
                  const stalled = candidates.filter(j => !recentJobIds.has(j.jobber_id));
                  stalledJobs = {
                          count: stalled.length,
                          jobs: stalled.slice(0, 10).map(j => ({ jobberId: j.jobber_id, jobNumber: j.job_number, title: j.title, status: j.job_status, daysSinceUpdate: fiDaysAgo(j.jobber_updated_at) })),
                          note: 'Stalled = job_status active/late/today with no Jobber status change AND no CompanyCam photo in 3+ days. WebWork clock-ins and a notes/stage-history log are not synced yet, so this signal is Jobber + CompanyCam only.',
                  };
          } else {
                  stalledJobs = { count: 0, jobs: [], note: 'No in-progress jobs (active/late/today) are 3+ days without a Jobber update.' };
          }
        } catch (e) {
          notConnected.jobStalls = 'Job-stall lookup failed: ' + e.message;
        }
      })(),

      (async () => {
        try {
          const visits = await fiFetchAllRows('visits', '?select=jobber_id,title,start_at&start_at=gte.' + todayStart + '&start_at=lt.' + todayEnd + '&order=start_at.asc');
          todaysVisits = { count: visits.length };
        } catch (e) {
          notConnected.schedule = 'Schedule lookup failed: ' + e.message;
        }
      })(),

      (async () => {
        try {
          const quotes = await fiFetchAllRows('quotes', '?select=jobber_id,total,quote_status&quote_status=eq.awaiting_response');
          openQuotes = { count: quotes.length, sum: fiRound2(quotes.reduce((s, q) => s + fiNum(q.total), 0)) };
        } catch (e) {
          notConnected.quotes = 'Quotes lookup failed: ' + e.message;
        }
      })(),

      (async () => {
        try {
          const wxj = await getWeatherBedford();
          briefWeather = wxSummarize(wxj);
        } catch (e) {
          notConnected.weather = 'Weather lookup failed: ' + e.message;
        }
      })(),
    ]);

    const decisions = [];
    if (cashRunway && (cashRunway.level === 'crisis' || cashRunway.level === 'red')) {
          const alertLabel = cashRunway.level === 'crisis' ? 'CRISIS' : 'RED ALERT';
          decisions.push({ view: 'fix', type: 'DECIDE', text: alertLabel + ': ~' + cashRunway.runwayWeeks + ' week(s) of cash runway left at the current overhead run-rate ($' + cashRunway.weeklyRunRate.toLocaleString() + '/wk) -- act now.', source: 'QuickBooks' });
    }
    if (pastDueInvoices && pastDueInvoices.count > 0) {
          decisions.push({ view: 'invx', type: 'DECIDE', text: pastDueInvoices.count + ' invoice(s) past due, $' + pastDueInvoices.sum.toLocaleString() + ' total -- chase or write off?', source: 'Jobber' });
    }
    if (completedNotInvoiced && completedNotInvoiced.count > 0) {
          decisions.push({ view: 'jobs', type: 'SIGN', text: completedNotInvoiced.count + ' completed job(s) awaiting invoicing -- $' + ((completedNotInvoiced.sumRemainingToBill != null ? completedNotInvoiced.sumRemainingToBill : completedNotInvoiced.sumOfPricedJobs)).toLocaleString() + ' actually left to bill' + (completedNotInvoiced.alreadyBilledJobs ? ' (' + completedNotInvoiced.alreadyBilledJobs + ' of them look fully billed already -- just close them in Jobber)' : '') + '.', source: 'Jobber' });
    }
    if (stalledJobs && stalledJobs.count > 0) {
          const stallNames = stalledJobs.jobs.slice(0, 3).map(j => j.title || ('Job #' + j.jobNumber)).join(', ');
          const stallExtra = stalledJobs.count > 3 ? (' + ' + (stalledJobs.count - 3) + ' more') : '';
          decisions.push({ view: 'jobs', type: 'REVIEW', text: stalledJobs.count + ' job(s) stalled 3+ days with no status change or new photo: ' + stallNames + stallExtra + '.', source: 'Jobber + CompanyCam' });
    }
    if (cash && cash.billsDue14 > 0 && cash.bankBalance > 0 && cash.billsDue14 > cash.bankBalance * 0.5) {
          decisions.push({ view: 'fix', type: 'DECIDE', text: '$' + cash.billsDue14.toLocaleString() + ' in bills due within 14 days against a $' + cash.bankBalance.toLocaleString() + ' bank balance -- confirm cash is covered.', source: 'QuickBooks' });
    }
    if (openQuotes && openQuotes.count > 0) {
          decisions.push({ view: 'estimates', type: 'DECIDE', text: openQuotes.count + ' quote(s) awaiting a client response, $' + openQuotes.sum.toLocaleString() + ' in the pipeline -- follow up?', source: 'Jobber' });
    }
  
    if (cashRunway && cashRunway.level === "watch") {
      decisions.push({ view: "fix", type: "CONSULT", text: "Cash runway is ~" + cashRunway.runwayWeeks + " week(s) at the current overhead run-rate ($" + cashRunway.weeklyRunRate.toLocaleString() + "/wk) -- still healthy, but worth a look before it becomes urgent. Tighten overhead, accelerate collections, or confirm this is seasonal.", source: "QuickBooks", confidence: "Derived from YTD run-rate -- see cashRunway note." });
    }
    if (stalledJobs && todaysVisits && stalledJobs.count > 0 && todaysVisits.count > 0 && stalledJobs.count >= todaysVisits.count) {
      decisions.push({ view: "jobs", type: "CONSULT", text: stalledJobs.count + " job(s) stalled 3+ days is at or above the " + todaysVisits.count + " visit(s) scheduled today -- possible PM/dispatch bandwidth gap rather than one-off jobs. Worth checking if this is a pattern over the last few weeks, not just today.", source: "Jobber + CompanyCam", confidence: "Single-day comparison -- would need a multi-week trend to be more confident." });
    }
    if (openQuotes && cash && openQuotes.sum > 0 && cash.bankBalance > 0 && openQuotes.sum > cash.bankBalance * 2) {
      decisions.push({ view: "estimates", type: "CONSULT", text: "$" + openQuotes.sum.toLocaleString() + " in open quotes is more than 2x the current $" + cash.bankBalance.toLocaleString() + " cash balance -- real growth in the pipeline. Worth checking crew capacity can actually absorb this much new work if it closes.", source: "Jobber + QuickBooks", confidence: "Pipeline value only -- not adjusted for historical close rate (not tracked yet)." });
    }
    const knownSourceCount = [cash, pastDueInvoices, todaysVisits].filter(Boolean).length;
    let headline;
    if (knownSourceCount === 0) {
          headline = 'Reina could not reach any data sources this morning -- check the connections below.';
    } else {
          const jobsPart = todaysVisits ? (todaysVisits.count + ' job(s) on the board today') : 'schedule not synced yet';
          const cashPart = cash ? ('$' + cash.bankBalance.toLocaleString() + ' in the bank' + (cashRunway && cashRunway.runwayWeeks != null ? (' (~' + cashRunway.runwayWeeks + ' wk runway)') : '')) : 'cash not connected';
          const decisionPart = decisions.length ? (', ' + decisions.length + ' item(s) need a decision') : ', nothing above threshold today';
          headline = jobsPart + ', ' + cashPart + decisionPart + '.';
    }
  
    const fiBriefPayload = ({
          ok: true,
          source: 'Reina Daily Brief -- QuickBooks + Jobber via Supabase, live',
          asOf,
          headline,
          decisions,
          weather: briefWeather,
          cash,
          cashRunway,
          pastDueInvoices,
          completedNotInvoiced,
          todaysVisits,
          openQuotes,
          stalledJobs,
          notConnected,
    });
    await fiBriefCacheWrite(fiBriefPayload);
    return res.status(200).json(fiBriefPayload);
}


// ---------- Team & Access (resource=team) ----------
// Real Supabase Auth accounts, backed by the "profiles" table (id, email,
// full_name, role). GET lists the team (any signed-in user). POST invites a
// new account -- admin-only, verified server-side against the requester's
// own profile row, never trusted from the client.

// ---- Sales > Leads pipeline -- resource=leads (GET/POST/PATCH) ----
// Real subsystem added 2026-07-21 per Chris's decision to build a genuine
// pipeline (not an honest-but-thin read of clients.is_lead) -- see
// sql/013_lead_pipeline.sql for the original schema/rationale.
//
// 2026-08-18: a lead is now an OPPORTUNITY -- a potential job -- not a person.
// A ten-year customer asking for a bathroom is as much a lead as a stranger off
// the website, and either can be lost. lead_pipeline.client_id therefore lost
// its UNIQUE constraint (20260818120000_lead_pipeline_opportunity_model.sql), so
// one client can hold several open opportunities at once.
//
// What that changes here: rows are addressed by their own id, never by client_id.
// The two ON CONFLICT (client_id) upserts this code relied on cannot work
// without that unique constraint, so both are gone.
//
// A card on the board is one of two things:
//   * a real lead_pipeline row           -> id is its uuid
//   * an is_lead client with no row yet  -> id is null, stage defaults to 'new'
// The second kind is what all but 4 of the 346 Jobber-flagged lead clients look
// like today. PATCHing one creates its first real row, so the board behaves
// exactly as before while now supporting many opportunities per client.
// 'request' is column one: an enquiry from Jobber nobody has acted on yet.
// 'new' is a lead that did not come from a request (hand-entered, or a client
// Jobber flagged is_lead). See 20260818140000_lead_pipeline_request_stage.sql.
const LEAD_STAGES = ['request', 'new', 'contacted', 'estimate_booked', 'estimate_sent', 'won', 'lost'];

// ---- half-finished forms, of any kind --------------------------------------
//
// Chris, 2026-08-23: "i inavertently clicked away from the screen and lost my
// work, that can't happen... it needs a home to save the incomplete form too.
// and it needs to be easily found when you want to return to it."
//
// Server-side and keyed by owner, not localStorage. A draft he deliberately
// saved is a fact about HIM: it has to be on the laptop and the tablet too,
// and clearing site data must not eat it. (The unsent keystrokes BEFORE he
// presses save are the sanctioned local exception and stay in the browser.)
//
// The payload is the form AS TYPED, never a validated lead. Half a phone
// number and no name at all still has to survive -- that is exactly the state
// he is in when the phone rings again.
const FORM_DRAFT_MAX = 60;

async function handleFormDrafts(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const owner = encodeURIComponent(requester.id);

  // Each screen asks for its own kind: the Leads page shows lead drafts, Jobs
  // shows job drafts. No kind means all of them, which is what a single
  // "everything unfinished" list would want.
  const kind = String((req.query && req.query.kind) || '').trim();
  const kindFilter = kind ? `&kind=eq.${encodeURIComponent(kind)}` : '';

  if (req.method === 'GET') {
    const r = await supabaseRequest(
      `form_drafts?owner_id=eq.${owner}${kindFilter}&select=id,kind,label,payload,created_at,updated_at&order=updated_at.desc&limit=${FORM_DRAFT_MAX}`
    );
    if (!r.ok) {
      const text = await r.text();
      // Until the table is applied this must read as "no drafts", not as a
      // broken Leads view -- the board around it is fine either way.
      if (/relation .* does not exist/i.test(text)) return res.status(200).json({ ok: true, drafts: [], tableReady: false });
      return res.status(500).json({ ok: false, error: text });
    }
    return res.status(200).json({ ok: true, tableReady: true, drafts: await r.json() });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const payload = (b.payload && typeof b.payload === 'object') ? b.payload : null;
    if (!payload) return res.status(400).json({ ok: false, error: 'Nothing to save.' });
    // A draft is small by nature. A megabyte of it is a bug or an abuse, and
    // either way it does not belong in the row.
    if (JSON.stringify(payload).length > 20000) return res.status(413).json({ ok: false, error: 'That draft is too large to save.' });
    const label = String(b.label || '').trim().slice(0, 120) || null;
    const id = String(b.id || '').trim();
    const now = new Date().toISOString();

    if (id) {
      // owner_id in the filter, not just the id: without it, knowing another
      // person's draft id would be enough to overwrite it.
      const r = await supabaseRequest(`form_drafts?id=eq.${encodeURIComponent(id)}&owner_id=eq.${owner}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ label, payload, updated_at: now }),
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: await r.text() });
      const rows = await r.json();
      if (!rows.length) return res.status(404).json({ ok: false, error: 'That draft is gone -- saving it as a new one.' });
      return res.status(200).json({ ok: true, draft: rows[0] });
    }

    const r = await supabaseRequest('form_drafts', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{ owner_id: requester.id, kind: kind || String((b && b.kind) || 'lead'), label, payload }]),
    });
    if (!r.ok) {
      const text = await r.text();
      if (/relation .* does not exist/i.test(text)) {
        return res.status(200).json({ ok: false, error: 'Draft storage is not set up yet -- run the lead_drafts migration.' });
      }
      return res.status(500).json({ ok: false, error: text });
    }
    return res.status(200).json({ ok: true, draft: (await r.json())[0] });
  }

  if (req.method === 'DELETE') {
    const id = String((req.query && req.query.id) || (req.body && req.body.id) || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'Which draft?' });
    const r = await supabaseRequest(`form_drafts?id=eq.${encodeURIComponent(id)}&owner_id=eq.${owner}`, { method: 'DELETE' });
    if (!r.ok) return res.status(500).json({ ok: false, error: await r.text() });
    return res.status(200).json({ ok: true, deleted: id });
  }

  return res.status(405).json({ ok: false, error: 'GET, POST or DELETE only' });
}

async function handleLeads(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });

  if (req.method === 'GET') {
    const pipeRes = await supabaseRequest('lead_pipeline?select=*');
    if (!pipeRes.ok) {
      const text = await pipeRes.text();
      const notSynced = /relation .* does not exist/i.test(text);
      if (notSynced) {
        return res.status(200).json({ ok: false, error: 'Lead pipeline table is not set up yet -- run sql/013_lead_pipeline.sql in Supabase.' });
      }
      return res.status(500).json({ ok: false, error: text });
    }
    const pipeline = await pipeRes.json();

    // Names are looked up for the clients that actually hold an opportunity,
    // NOT for is_lead clients as this used to do. 23 of the 30 open requests
    // come from existing customers rather than leads, and under an is_lead
    // filter every one of those cards would render without a name.
    const clientIds = [...new Set(pipeline.map((p) => p.client_id).filter(Boolean))];
    let clients = [];
    if (clientIds.length) {
      const inList = `(${clientIds.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`;
      const clientsRes = await supabaseRequest(
        `clients?jobber_id=in.${encodeURIComponent(inList)}&select=jobber_id,name,company_name,email,jobber_updated_at`
      );
      if (!clientsRes.ok) return res.status(500).json({ ok: false, error: 'Could not load leads: ' + (await clientsRes.text()) });
      clients = await clientsRes.json();
    }
    const clientById = new Map(clients.map((c) => [c.jobber_id, c]));

    // Jobber's own status for the originating request. Carried through so a
    // card can show that its enquiry is overdue -- 9 of the 30 open requests
    // already were on the day this shipped, and that was invisible while they
    // sat in a separate tab. Read-only: Jobber owns this, HiveLogic mirrors it.
    const requestIds = [...new Set(pipeline.map((p) => p.request_id).filter(Boolean))];
    const requestById = new Map();
    if (requestIds.length) {
      const rList = `(${requestIds.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`;
      const rRes = await supabaseRequest(
        `requests?jobber_id=in.${encodeURIComponent(rList)}&select=jobber_id,request_status,jobber_web_uri`
      );
      // Non-fatal: a board without the overdue chip still works.
      if (rRes.ok) for (const r of await rRes.json()) requestById.set(r.jobber_id, r);
    }

    // One card per opportunity row, plus one for each is_lead client that has
    // no row yet. Grouping by client (the old shape) would silently hide every
    // opportunity after the first, which is the whole point of the change.
    const shape = (p, c) => ({
      id: p.id || null,
      clientId: (p.client_id || c.jobber_id),
      requestId: p.request_id || null,
      requestStatus: (requestById.get(p.request_id) || {}).request_status || null,
      requestOverdue: ((requestById.get(p.request_id) || {}).request_status === 'overdue'),
      requestUrl: (requestById.get(p.request_id) || {}).jobber_web_uri || null,
      // Card headline. Falls back to the client's name so a row created before
      // titles existed, or a hand-entered lead with no job name, still reads.
      title: p.title || c.name || c.company_name || 'Untitled opportunity',
      name: c.name || c.company_name || 'Unnamed lead',
      companyName: c.company_name,
      email: c.email,
      stage: p.stage || 'new',
      estimatedValue: p.estimated_value != null ? Number(p.estimated_value) : null,
      propertyType: p.property_type || null,
      leadSource: p.lead_source || null,
      referredByClientId: p.referred_by_client_id || null,
      division: p.division || null,
      need: p.need || null,
      phone: p.phone || null,
      serviceAddress: p.service_address || null,
      urgency: p.urgency || null,
      lostReason: p.lost_reason || null,
      notes: p.notes || null,
      firstContactedAt: p.first_contacted_at || null,
      lastContactedAt: p.last_contacted_at || null,
      createdAt: p.created_at || c.jobber_updated_at,
      updatedAt: p.updated_at || c.jobber_updated_at
    });

    // The board is the opportunities, nothing else. It used to synthesise a card
    // for every is_lead client with no row -- which is how it ended up showing
    // 346 cards, 80 of them over a year old, all stuck in "New" because nothing
    // had ever been logged against them (Chris's decision 2, 2026-08-17). The
    // backfill in 20260818130000 seeds the rows worth carrying: the open
    // requests, and the leads touched in the last 30 days. Everything else stays
    // in the client list, untouched and findable, just not on the board.
    const leads = pipeline.map((p) => {
      // An opportunity whose client is archived, or no longer flagged is_lead,
      // still belongs on the board -- it is real work someone logged. Fall back
      // to a stub so it renders rather than vanishing.
      const c = clientById.get(p.client_id) || { jobber_id: p.client_id, name: null, company_name: null, email: null };
      return shape(p, c);
    });
    return res.status(200).json({ ok: true, source: 'HiveLogic lead pipeline', totalCount: leads.length, leads });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const first = String(b.firstName || '').trim();
    const last = String(b.lastName || '').trim();
    const company = String(b.companyName || '').trim();
    if (!first && !last && !company) return res.status(400).json({ ok: false, error: 'Need a first/last name or a company name.', _got: { t: typeof req.body, keys: (req.body && typeof req.body === 'object') ? Object.keys(req.body) : null } });
    let clientId = String(b.clientId || '').trim() || null;
    if (!clientId) {
      const row = {
        jobber_id: 'HL-' + Date.now(),
        name: (first || last) ? (first + ' ' + last).trim() : company,
        first_name: first || null,
        last_name: last || null,
        company_name: company || null,
        email: String(b.email || '').trim() || null,
        is_lead: true,
        is_archived: false,
        jobber_updated_at: new Date().toISOString()
      };
      const cRes = await supabaseRequest('clients', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
      if (!cRes.ok) return res.status(500).json({ ok: false, error: 'Could not create client: ' + (await cRes.text()).slice(0, 300) });
      const client = (await cRes.json())[0];
      clientId = client.jobber_id;
    }
    // A lead can be born already closed: "Not a good fit" on the New Lead form
    // takes the call down AND closes it out in one press, and the work we turned
    // away has to be countable. stage was hardcoded 'new' here, so that lead
    // landed in the pipeline looking live and the reason went nowhere.
    // Same validation the PATCH branch uses -- an unknown stage is rejected
    // rather than written.
    const wantStage = String(b.stage || '').trim();
    if (wantStage && LEAD_STAGES.indexOf(wantStage) === -1) {
      return res.status(400).json({ ok: false, error: 'stage must be one of: ' + LEAD_STAGES.join(', ') });
    }
    if (wantStage === 'lost' && !String(b.lostReason || '').trim()) {
      return res.status(400).json({ ok: false, error: 'lostReason is required when moving a lead to Lost.' });
    }
    const nowIso = new Date().toISOString();
    const pipeRow = {
      client_id: clientId,
      request_id: String(b.requestId || '').trim() || null,
      title: String(b.title || '').trim() || null,
      stage: wantStage || 'new',
      lost_reason: String(b.lostReason || '').trim() || null,
      // A lead that arrives at any stage past 'new' was contacted to get there
      // -- that is the call that produced it -- so the clock the SLA note
      // promises starts now rather than staying null forever.
      first_contacted_at: (wantStage && wantStage !== 'new') ? nowIso : null,
      estimated_value: (isFinite(Number(b.estimatedValue)) && Number(b.estimatedValue) > 0) ? Number(b.estimatedValue) : null,
      lead_source: String(b.leadSource || '').trim() || null,
      referred_by_client_id: b.referredByClientId ? String(b.referredByClientId).trim() : null,
      division: String(b.division || '').trim() || null,
      need: String(b.need || '').trim() || null,
      phone: String(b.phone || '').trim() || null,
      service_address: String(b.serviceAddress || '').trim() || null,
      urgency: String(b.urgency || '').trim() || null,
      // The form has posted this since it was built and there was nowhere to
      // put it, so every Residential/Commercial choice anyone ever made was
      // dropped. Capped rather than constrained: a lead is taken down while
      // somebody is on the phone, and a rejected value mid-call costs a lead.
      property_type: String(b.propertyType || '').trim().slice(0, 60) || null,
      notes: String(b.notes || '').trim() || null,
      updated_at: new Date().toISOString()
    };
    // Plain insert, not an upsert. Under the opportunity model a second lead
    // for the same client is a legitimate second job, not a duplicate to merge
    // into the first -- which is exactly what ON CONFLICT (client_id) used to do.
    const pRes = await supabaseRequest('lead_pipeline', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(pipeRow)
    });
    if (!pRes.ok) {
      const text = await pRes.text();
      const notSynced = /relation .* does not exist/i.test(text);
      return res.status(notSynced ? 200 : 500).json({
        ok: false,
        error: notSynced ? 'Lead saved as a client, but the lead pipeline table is not set up yet -- run sql/013_lead_pipeline.sql in Supabase.' : text
      });
    }
    const pipeline = (await pRes.json())[0];
    return res.status(200).json({
      ok: true, resource: 'leads', clientId, pipeline,
      note: 'Saved in HiveLogic. Not pushed to Jobber yet -- Jobber write-back is a later phase.'
    });
  }

  if (req.method === 'PATCH') {
    const b = req.body || {};
    const clientId = String(b.clientId || '').trim();
    if (!clientId) return res.status(400).json({ ok: false, error: 'clientId is required.' });
    if (b.stage && LEAD_STAGES.indexOf(b.stage) === -1) {
      return res.status(400).json({ ok: false, error: 'stage must be one of: ' + LEAD_STAGES.join(', ') });
    }
    if (b.stage === 'lost' && !String(b.lostReason || '').trim()) {
      return res.status(400).json({ ok: false, error: 'lostReason is required when moving a lead to Lost.' });
    }
    // leadId addresses one opportunity. It is absent only for a card that has
    // no lead_pipeline row yet (an is_lead client the team has never touched) --
    // that case inserts the client's first row below. Looking the row up by
    // client_id instead would be ambiguous the moment a client has two.
    const leadId = String(b.leadId || '').trim();
    let existing = null;
    if (leadId) {
      const existingRes = await supabaseRequest(`lead_pipeline?id=eq.${encodeURIComponent(leadId)}&select=id,client_id,stage,first_contacted_at`);
      const existingRows = existingRes.ok ? await existingRes.json() : [];
      existing = existingRows[0] || null;
      if (!existing) return res.status(404).json({ ok: false, error: 'That lead no longer exists -- refresh the board.' });
      if (existing.client_id !== clientId) {
        return res.status(400).json({ ok: false, error: 'That lead belongs to a different client.' });
      }
    }
    const now = new Date().toISOString();
    const patch = { updated_at: now, last_contacted_at: now };
    if (b.stage) patch.stage = b.stage;
    if (b.estimatedValue !== undefined) patch.estimated_value = (isFinite(Number(b.estimatedValue)) && Number(b.estimatedValue) > 0) ? Number(b.estimatedValue) : null;
    if (b.leadSource !== undefined) patch.lead_source = String(b.leadSource || '').trim() || null;
    if (b.referredByClientId !== undefined) patch.referred_by_client_id = b.referredByClientId ? String(b.referredByClientId).trim() : null;
    if (b.division !== undefined) patch.division = String(b.division || '').trim() || null;
    if (b.need !== undefined) patch.need = String(b.need || '').trim() || null;
    if (b.notes !== undefined) patch.notes = String(b.notes || '').trim() || null;
    if (b.propertyType !== undefined) patch.property_type = String(b.propertyType || '').trim().slice(0, 60) || null;
    if (b.lostReason !== undefined) patch.lost_reason = String(b.lostReason || '').trim() || null;
    // The job this lead became, written when a lead is converted straight to
    // work. Sits beside estimate_id: same idea, the other exit from the
    // pipeline. Validated against the jobs table rather than trusted, because a
    // dangling ref here is a lead that looks converted and points at nothing.
    if (b.jobRef !== undefined) {
      const jobRef = String(b.jobRef || '').trim();
      if (!jobRef) patch.job_ref = null;
      else {
        const jr = await supabaseRequest(`jobs?jobber_id=eq.${encodeURIComponent(jobRef)}&select=jobber_id&limit=1`);
        const jrows = jr.ok ? await jr.json() : [];
        if (!jrows.length) return res.status(404).json({ ok: false, error: 'That job does not exist.' });
        patch.job_ref = jobRef;
      }
    }
    if (!existing || (existing.stage === 'new' && patch.stage && patch.stage !== 'new') || (!existing.first_contacted_at && patch.stage && patch.stage !== 'new')) {
      patch.first_contacted_at = now;
    }
    // Update the one row when we have its id; otherwise create this client's
    // first opportunity. Previously both branches were a single upsert keyed on
    // the client_id unique constraint, which no longer exists.
    const r = leadId
      ? await supabaseRequest(`lead_pipeline?id=eq.${encodeURIComponent(leadId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch)
      })
      : await supabaseRequest('lead_pipeline', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(Object.assign({ client_id: clientId, title: String(b.title || '').trim() || null }, patch))
      });
    if (!r.ok) {
      const text = await r.text();
      const notSynced = /relation .* does not exist/i.test(text);
      return res.status(notSynced ? 200 : 500).json({
        ok: false,
        error: notSynced ? 'Lead pipeline table is not set up yet -- run sql/013_lead_pipeline.sql in Supabase.' : text
      });
    }
    const updated = (await r.json())[0];
    return res.status(200).json({ ok: true, resource: 'leads', pipeline: updated });
  }

  if (req.method === 'DELETE') {
    // lead_pipeline is entirely HiveLogic-owned (either created here or
    // one-time-backfilled from Jobber's requests table -- see the POST/GET
    // comments above), so unlike invoices/timesheets there is no live Jobber
    // sync to collide with and no HL- id-prefix guard needed. The client and
    // Jobber's own request record are untouched either way -- this only
    // removes the opportunity row itself.
    const leadId = String((req.query && req.query.id) || '').trim();
    if (!leadId) return res.status(400).json({ ok: false, error: 'Which lead? No id given.' });
    const r = await supabaseRequest(`lead_pipeline?id=eq.${encodeURIComponent(leadId)}`, { method: 'DELETE' });
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not delete this lead: ' + (await r.text()).slice(0, 300) });
    return res.status(200).json({ ok: true, resource: 'leads' });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
}

async function getRequestingProfile(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  let token = authHeader.replace(/^Bearer\s+/i, '').trim();
  // Fallback for navigator.sendBeacon() calls (e.g. the browser-close
  // auto-clockout safety net) -- sendBeacon can't set custom headers, so
  // that one caller sends its token in the JSON body instead.
  if (!token && req.body && req.body.access_token) token = String(req.body.access_token).trim();
  if (!token) return null;
  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user || !user.id) return null;
  const profRes = await supabaseRequest(`profiles?id=eq.${user.id}&select=id,email,full_name,role,monitoring_enabled,page_build,page_build_seen_at,settings`);
  if (!profRes.ok) return { id: user.id, email: user.email, full_name: null, role: null, monitoring_enabled: true };
  const rows = await profRes.json();
  return (rows && rows[0]) || { id: user.id, email: user.email, full_name: null, role: null, monitoring_enabled: true };
}

function genTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 12; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

// Dispatch tab polish: persistent freeze-window toggle (item 3 of 4 on
// "Dispatch tab polish remaining"). Same dispatch-capable role check
// api/schedule/move-visit.js already trusts for actually moving visits --
// mirrored here (not imported) since this file's own getRequestingProfile
// doesn't carry permissionRoles.
// 2026-08-10: Stage 2 of the permission redesign -- these 9 replace the old
// 11-value taxonomy (owner/partner/office_manager/systems_pm collapsed into
// "owner", the rest renamed/retired -- see sql/066_permission_roles_v2.sql).
// Only owner/project_manager/dispatch can move a visit or touch dispatch
// settings; office_ar/purchasing/admin_remote/field_lead/field_tech/sales
// cannot manage anyone's schedule, per jomell + Chris's rules.
const DISPATCH_ALLOWED_ROLES = ['owner', 'project_manager', 'dispatch'];
async function getDispatchPermissionRoles(profile) {
  if (!profile || !profile.email) return [];
  try {
    const userRow = await supabaseRequest(`users?email=eq.${encodeURIComponent(profile.email)}&select=jobber_id&limit=1`);
    const userRows = userRow.ok ? await userRow.json() : [];
    const jobberId = userRows && userRows[0] && userRows[0].jobber_id;
    if (!jobberId) return [];
    const roleRes = await supabaseRequest(`employee_roles?jobber_id=eq.${encodeURIComponent(jobberId)}&select=permission_roles,permission_role`);
    const roleRows = roleRes.ok ? await roleRes.json() : [];
    const roleRow = roleRows && roleRows[0];
    return (roleRow && roleRow.permission_roles) || (roleRow && roleRow.permission_role ? [roleRow.permission_role] : []);
  } catch (e) {
    return [];
  }
}
// ---------- PTO Tracking (2026-08-11) ----------
// Real backend for what were previously two disconnected, fully-mock pages
// (Team > PTO Tracking's approval queue, and the Employee Portal's request
// form) -- neither had ANY backend or database concept of PTO before this,
// and the approve/decline buttons fabricated success toasts ("Day board
// updated, Steve notified") with zero real effect. Both pages now read/
// write the same real pto_requests/pto_allowances tables (sql/069_pto_tracking.sql).
// Deliberately a simple yearly-allowance model, not real accrual-from-
// payroll math -- see that migration's header comment for why. Approval is
// restricted to the "owner" permission role, matching the existing
// permissions-matrix note ("Payroll & PTO approval: Owner").
// Deliberately does NOT claim to notify anyone or update a "Day board" --
// neither a notification pipeline nor a Day board write path was built
// here; the response only ever describes what actually happened (the
// request's status changed), not fabricated side effects.
async function resolveEmployeeJobberId(profile) {
  if (!profile || !profile.email) return null;
  try {
    const r = await supabaseRequest(`users?email=eq.${encodeURIComponent(profile.email)}&select=jobber_id,name&limit=1`);
    const rows = r.ok ? await r.json() : [];
    return (rows && rows[0]) || null;
  } catch (e) { return null; }
}
async function isPtoApprover(requester) {
  if (!requester) return false;
  if (requester.role === 'admin' || requester.role === 'superadmin') return true;
  const roles = await getDispatchPermissionRoles(requester);
  return roles.includes('owner');
}
function ptoDayCount(startDate, endDate) {
  // Inclusive calendar-day count -- no weekend/holiday calendar exists
  // anywhere in this app to do better, and the simple yearly-allowance
  // model doesn't need one.
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}
function mapPtoRequest(r) {
  return {
    id: r.id,
    employeeJobberId: r.employee_jobber_id,
    employeeName: r.employee_name,
    startDate: r.start_date,
    endDate: r.end_date,
    requestType: r.request_type,
    status: r.status,
    note: r.note,
    requestedAt: r.requested_at,
    decidedByEmail: r.decided_by_email,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    days: ptoDayCount(r.start_date, r.end_date),
  };
}
async function handlePtoRequests(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const approver = await isPtoApprover(requester);

  if (req.method === 'GET') {
    if (req.query.scope === 'all') {
      if (!approver) return res.status(403).json({ ok: false, error: 'Only an owner can view every PTO request.' });
      const rows = await fiFetchAllRows('pto_requests', '?select=*&order=requested_at.desc');
      return res.status(200).json({ ok: true, resource: 'pto_requests', requests: rows.map(mapPtoRequest), canApprove: true });
    }
    const employee = await resolveEmployeeJobberId(requester);
    if (!employee) return res.status(200).json({ ok: true, resource: 'pto_requests', requests: [], canApprove: approver, note: 'No matching employee record found for your account yet -- ask an admin to check your email matches Jobber.' });
    const rows = await fiFetchAllRows('pto_requests', '?select=*&employee_jobber_id=eq.' + encodeURIComponent(employee.jobber_id) + '&order=requested_at.desc');
    return res.status(200).json({ ok: true, resource: 'pto_requests', requests: rows.map(mapPtoRequest), canApprove: approver });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const startDate = String(body.startDate || '').trim();
    const endDate = String(body.endDate || '').trim();
    const requestType = ['vacation', 'personal', 'sick'].includes(body.requestType) ? body.requestType : 'vacation';
    const note = body.note != null ? String(body.note).trim() || null : null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ ok: false, error: 'startDate and endDate are required, format YYYY-MM-DD.' });
    }
    if (endDate < startDate) {
      return res.status(400).json({ ok: false, error: 'endDate cannot be before startDate.' });
    }
    const employee = await resolveEmployeeJobberId(requester);
    if (!employee) {
      return res.status(400).json({ ok: false, error: 'Could not match your login to an employee record -- ask an admin to check your email matches Jobber.' });
    }
    const insertRes = await supabaseRequest('pto_requests', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{
        employee_jobber_id: employee.jobber_id,
        employee_name: employee.name || requester.full_name || requester.email,
        start_date: startDate,
        end_date: endDate,
        request_type: requestType,
        note,
        requested_by_email: requester.email,
      }]),
    });
    if (!insertRes.ok) return res.status(500).json({ ok: false, error: await insertRes.text() });
    const rows = await insertRes.json();
    return res.status(200).json({ ok: true, request: mapPtoRequest(rows[0]) });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
}
async function handlePtoDecide(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (!(await isPtoApprover(requester))) return res.status(403).json({ ok: false, error: 'Only an owner can approve or decline PTO requests.' });

  const body = req.body || {};
  const id = String(body.id || '').trim();
  const decision = body.decision === 'approved' || body.decision === 'declined' ? body.decision : null;
  const decisionNote = body.decisionNote != null ? String(body.decisionNote).trim() || null : null;
  if (!id || !decision) return res.status(400).json({ ok: false, error: 'id and decision (approved|declined) are required.' });

  const patchRes = await supabaseRequest(`pto_requests?id=eq.${encodeURIComponent(id)}&status=eq.pending`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: decision, decided_by_email: requester.email, decided_at: new Date().toISOString(), decision_note: decisionNote }),
  });
  if (!patchRes.ok) return res.status(500).json({ ok: false, error: await patchRes.text() });
  const rows = await patchRes.json();
  if (!rows.length) return res.status(409).json({ ok: false, error: 'That request was already decided (or does not exist).' });
  return res.status(200).json({ ok: true, request: mapPtoRequest(rows[0]) });
}
// Accrual fraction (2026-08-11, Phase 1 coverage/accrual pass): informational
// only -- does NOT cap what can be requested or approved (approval still
// checks the full yearly allowance, same as before). Purely allowanceDays/12
// times months elapsed, so it's never a fabricated number, just a different
// slice of the same allowance the owner already set.
function ptoAccrualFraction(year) {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  if (year < currentYear) return 1;
  if (year > currentYear) return 0;
  return (now.getUTCMonth() + 1) / 12;
}
// Heuristic only -- flags an employee sitting on most of a still-largely-
// unaccrued... no, largely-UNUSED allowance more than halfway through the
// year. Threshold is a judgment call (half the year elapsed, 2/3+ still
// remaining), easy to retune later, not tied to any policy document.
function ptoBurnoutFlag(allowanceDays, remainingDays, fraction) {
  if (allowanceDays <= 0 || remainingDays <= 0) return false;
  return fraction >= 0.5 && remainingDays / allowanceDays >= 0.66;
}
async function handlePtoBalances(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const year = Number(req.query.year) || new Date().getFullYear();
  const approver = await isPtoApprover(requester);
  const fraction = ptoAccrualFraction(year);

  const allowanceRows = await fiFetchAllRows('pto_allowances', '?select=*&year=eq.' + year);
  const approvedRows = await fiFetchAllRows(
    'pto_requests',
    '?select=employee_jobber_id,employee_name,start_date,end_date&status=eq.approved&start_date=gte.' + year + '-01-01&start_date=lte.' + year + '-12-31'
  );
  const pendingRows = await fiFetchAllRows(
    'pto_requests',
    '?select=employee_jobber_id,employee_name,start_date,end_date&status=eq.pending&start_date=gte.' + year + '-01-01&start_date=lte.' + year + '-12-31'
  );
  const usedByEmployee = {};
  const nameByEmployee = {};
  for (const r of approvedRows) {
    usedByEmployee[r.employee_jobber_id] = (usedByEmployee[r.employee_jobber_id] || 0) + ptoDayCount(r.start_date, r.end_date);
    nameByEmployee[r.employee_jobber_id] = r.employee_name;
  }
  const pendingByEmployee = {};
  for (const r of pendingRows) {
    pendingByEmployee[r.employee_jobber_id] = (pendingByEmployee[r.employee_jobber_id] || 0) + ptoDayCount(r.start_date, r.end_date);
    nameByEmployee[r.employee_jobber_id] = nameByEmployee[r.employee_jobber_id] || r.employee_name;
  }
  const todayStr = new Date().toISOString().slice(0, 10);
  const upcomingByEmployee = {};
  for (const r of approvedRows.slice().sort((a, b) => (a.start_date < b.start_date ? -1 : 1))) {
    if (r.end_date < todayStr) continue;
    if (!upcomingByEmployee[r.employee_jobber_id]) upcomingByEmployee[r.employee_jobber_id] = r;
  }
  const allowanceByEmployee = {};
  for (const a of allowanceRows) allowanceByEmployee[a.employee_jobber_id] = Number(a.allowance_days) || 0;

  if (approver && req.query.scope === 'all') {
    // Base the list on every active employee (same query handleEmployeeRoster
    // uses), not just whoever already has an allowance or a request -- a
    // brand-new employee with neither would otherwise never appear, and an
    // owner could never proactively set their allowance before their first
    // request.
    const usersRes = await supabaseRequest('users?status=neq.DEACTIVATED&email=neq.devteam@zenkoders.com&select=jobber_id,name&order=name.asc');
    const activeUsers = usersRes.ok ? await usersRes.json() : [];
    for (const u of activeUsers) nameByEmployee[u.jobber_id] = nameByEmployee[u.jobber_id] || u.name;
    const employeeIds = Array.from(new Set([...activeUsers.map((u) => u.jobber_id), ...Object.keys(allowanceByEmployee), ...Object.keys(usedByEmployee)]));
    const balances = employeeIds.map((id) => {
      const allowanceDays = allowanceByEmployee[id] || 0;
      const usedDays = usedByEmployee[id] || 0;
      const remainingDays = allowanceDays - usedDays;
      const upcoming = upcomingByEmployee[id];
      return {
        employeeJobberId: id,
        employeeName: nameByEmployee[id] || null,
        allowanceDays,
        accruedDays: Math.round(allowanceDays * fraction * 100) / 100,
        usedDays,
        remainingDays,
        pendingDays: pendingByEmployee[id] || 0,
        burnoutFlag: ptoBurnoutFlag(allowanceDays, remainingDays, fraction),
        upcomingApproved: upcoming ? { startDate: upcoming.start_date, endDate: upcoming.end_date } : null,
      };
    }).sort((a, b) => (a.employeeName || '').localeCompare(b.employeeName || ''));
    return res.status(200).json({ ok: true, resource: 'pto_balances', year, balances });
  }

  const employee = await resolveEmployeeJobberId(requester);
  if (!employee) return res.status(200).json({ ok: true, resource: 'pto_balances', year, allowanceDays: 0, accruedDays: 0, usedDays: 0, remainingDays: 0, note: 'No matching employee record found for your account yet.' });
  const allowanceDays = allowanceByEmployee[employee.jobber_id] || 0;
  const usedDays = usedByEmployee[employee.jobber_id] || 0;
  return res.status(200).json({ ok: true, resource: 'pto_balances', year, allowanceDays, accruedDays: Math.round(allowanceDays * fraction * 100) / 100, usedDays, remainingDays: allowanceDays - usedDays });
}
// Coverage map (Phase 1): a fixed 14-day (today through +13) grid of every
// active employee's PTO status. Deliberately does NOT flag "thin coverage" --
// that needs a real minimum-staffing rule (Phase 2), which doesn't exist yet.
async function handlePtoCoverage(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (!(await isPtoApprover(requester))) return res.status(403).json({ ok: false, error: 'Only an owner can view the coverage map.' });

  const now = new Date();
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i));
    days.push(d.toISOString().slice(0, 10));
  }
  const rangeStart = days[0];
  const rangeEnd = days[days.length - 1];

  const usersRes = await supabaseRequest('users?status=neq.DEACTIVATED&email=neq.devteam@zenkoders.com&select=jobber_id,name&order=name.asc');
  const activeUsers = usersRes.ok ? await usersRes.json() : [];

  const overlapping = await fiFetchAllRows(
    'pto_requests',
    `?select=employee_jobber_id,start_date,end_date,status&status=in.(approved,pending)&start_date=lte.${rangeEnd}&end_date=gte.${rangeStart}`
  );

  const employees = activeUsers.map((u) => {
    const dayStatuses = days.map((day) => {
      let status = 'working';
      for (const r of overlapping) {
        if (r.employee_jobber_id !== u.jobber_id) continue;
        if (day >= r.start_date && day <= r.end_date) {
          if (r.status === 'approved') { status = 'pto'; break; }
          if (r.status === 'pending' && status !== 'pto') status = 'pending';
        }
      }
      return status;
    });
    return { employeeJobberId: u.jobber_id, employeeName: u.name, days: dayStatuses };
  });

  return res.status(200).json({ ok: true, resource: 'pto_coverage', days, employees });
}
async function handlePtoAllowanceSet(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (!(await isPtoApprover(requester))) return res.status(403).json({ ok: false, error: 'Only an owner can set PTO allowances.' });

  const body = req.body || {};
  const employeeJobberId = String(body.employeeJobberId || '').trim();
  const year = Number(body.year) || new Date().getFullYear();
  const allowanceDays = Number(body.allowanceDays);
  if (!employeeJobberId) return res.status(400).json({ ok: false, error: 'employeeJobberId is required.' });
  if (!Number.isFinite(allowanceDays) || allowanceDays < 0) return res.status(400).json({ ok: false, error: 'allowanceDays must be a non-negative number.' });

  const upsertRes = await supabaseRequest('pto_allowances?on_conflict=employee_jobber_id,year', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ employee_jobber_id: employeeJobberId, year, allowance_days: allowanceDays, updated_at: new Date().toISOString(), updated_by_email: requester.email }]),
  });
  if (!upsertRes.ok) return res.status(500).json({ ok: false, error: await upsertRes.text() });
  const rows = await upsertRes.json();
  return res.status(200).json({ ok: true, allowance: rows[0] });
}

async function canManageDispatchSettings(requester) {
  if (!requester) return false;
  if (requester.role === 'admin' || requester.role === 'superadmin') return true;
  const roles = await getDispatchPermissionRoles(requester);
  return roles.some((r) => DISPATCH_ALLOWED_ROLES.indexOf(r) !== -1);
}
async function handleDispatchSettings(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in.' });

  if (req.method === 'POST') {
    const allowed = await canManageDispatchSettings(requester);
    if (!allowed) return res.status(403).json({ ok: false, error: 'Your account is not set up for schedule changes -- ask a superadmin to add Owner, Project Manager, or Dispatch to your Crew Roster roles.' });
    const { enabled, minutes } = req.body || {};
    const patch = {};
    if (enabled !== undefined) patch.dispatch_freeze_window_enabled = !!enabled;
    if (minutes !== undefined) {
      const n = Number(minutes);
      if (!Number.isFinite(n) || n < 0 || n > 240) return res.status(400).json({ ok: false, error: 'minutes must be between 0 and 240.' });
      patch.dispatch_freeze_window_minutes = Math.round(n);
    }
    if (Object.keys(patch).length) {
      const existingRes = await supabaseRequest('workforce_settings?select=id&limit=1');
      const existingRows = existingRes.ok ? await existingRes.json() : [];
      if (existingRows && existingRows[0]) {
        await supabaseRequest(`workforce_settings?id=eq.${existingRows[0].id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      } else {
        await supabaseRequest('workforce_settings', { method: 'POST', body: JSON.stringify(patch) });
      }
    }
  }

  const settingsRes = await supabaseRequest('workforce_settings?select=dispatch_freeze_window_enabled,dispatch_freeze_window_minutes&limit=1');
  const settingsRows = settingsRes.ok ? await settingsRes.json() : [];
  const row = (settingsRows && settingsRows[0]) || {};
  return res.status(200).json({
    ok: true,
    enabled: row.dispatch_freeze_window_enabled !== false,
    minutes: Number.isFinite(row.dispatch_freeze_window_minutes) ? row.dispatch_freeze_window_minutes : 60,
  });
}

async function handleTeam(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) {
    return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  }

  if (req.method === 'GET') {
    const r = await supabaseRequest('profiles?select=id,email,full_name,role&order=full_name.asc');
    if (!r.ok) {
      const text = await r.text();
      return res.status(500).json({ ok: false, error: text });
    }
    const rows = await r.json();
    return res.status(200).json({ ok: true, source: 'Supabase Auth', team: rows });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    // 2026-08-10: account-tier redesign (jomell + Chris's plan) -- superadmin/
    // admin/crew replaces plain admin/crew on the SAME profiles.role column.
    // Only superadmin can add, remove, or re-role a team member; admin's only
    // power over another account is resetting a crew member's password; crew
    // can only change their own password (done client-side via Supabase Auth,
    // never through this endpoint). action defaults to 'invite' so any old
    // caller that never sent `action` keeps working unchanged.
    const action = body.action || 'invite';

    if (action === 'invite') {
      if (requester.role !== 'superadmin') {
        return res.status(403).json({ ok: false, error: 'Only a superadmin can invite new team members.' });
      }
      const email = (body.email || '').trim();
      const full_name = (body.full_name || '').trim();
      // superadmin is never assignable at invite time -- promoting someone
      // that far is a separate, deliberate action (action=change_role) once
      // they already have an account, not a dropdown on the invite form.
      const role = body.role === 'admin' ? 'admin' : 'crew';
      if (!email || !full_name) {
        return res.status(400).json({ ok: false, error: 'email and full_name are required.' });
      }
      const tempPassword = genTempPassword();

      const createRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password: tempPassword, email_confirm: true, user_metadata: { full_name, role } }),
      });
      const createBody = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        return res.status(400).json({
          ok: false,
          error: createBody.msg || createBody.error_description || createBody.error || 'Could not create the account -- that email may already be registered.',
        });
      }
      const newUserId = createBody.id;

      // Monitoring permissions are set HERE, as the account is created, rather
      // than being something to remember afterwards -- Chris, 2026-08-17: "this
      // also needs to be set in permissions as you setup the user for the
      // software." Monitored by default; can be turned off for this person at
      // invite time or later in Monitor Settings. Off means genuinely off --
      // no prompt, no recording, and no idle timeout, since nothing is
      // watching the machine to base one on.
      const monitoringEnabled = body.monitoringEnabled !== false;

      const profRes = await supabaseRequest('profiles', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          id: newUserId, email, full_name, role,
          monitoring_enabled: monitoringEnabled,
        }),
      });
      if (!profRes.ok) {
        const text = await profRes.text();
        return res.status(500).json({ ok: false, error: `Account created in auth, but the profile record failed: ${text}` });
      }

      // Eagerly provision a HiveConnect account for the new hire too, so they
      // show up as a contact right away instead of only after their first
      // personal visit to HiveConnect. Best-effort: the HiveLogic invite above
      // has already fully succeeded, so a HiveConnect hiccup here must not fail
      // the invite or block the response -- if this doesn't succeed, HiveConnect
      // will provision on the new hire's first real login instead (same
      // idempotency guard ensureMappedAndMint always used).
      let hiveconnectProvisioned = false;
      try {
        await provisionHiveConnectAccount(newUserId, email);
        hiveconnectProvisioned = true;
      } catch (e) {
        console.error('HiveConnect eager provisioning failed during team invite (non-fatal):', e.message);
      }

      // Best-effort welcome email (2026-08-15, jomell: invites were never
      // actually emailed to the new hire -- only shown once to the inviting
      // superadmin to relay manually). Same non-blocking pattern as the
      // HiveConnect provisioning above: the account is already fully created
      // and usable regardless of whether this send succeeds, so a Resend
      // hiccup (or RESEND_API_KEY simply not being set) must never fail the
      // invite itself -- the temp password is still returned below either way.
      let emailSent = false;
      let emailError = null;
      if (isEmailConfigured()) {
        const sendResult = await sendEmail({
          to: email,
          subject: 'Your HiveLogic account is ready',
          html: `<p>Hi ${full_name},</p><p>You've been added to HiveLogic. Sign in with:</p>` +
            `<p><b>Email:</b> ${email}<br><b>Temporary password:</b> ${tempPassword}</p>` +
            `<p>You'll be asked to change this password after your first sign-in.</p>`,
          text: `Hi ${full_name},\n\nYou've been added to HiveLogic. Sign in with:\nEmail: ${email}\nTemporary password: ${tempPassword}\n\nYou'll be asked to change this password after your first sign-in.`,
        });
        emailSent = sendResult.ok;
        if (!sendResult.ok) emailError = sendResult.error;
      }

      return res.status(200).json({
        ok: true,
        created: { id: newUserId, email, full_name, role },
        tempPassword,
        hiveconnectProvisioned,
        emailSent,
        note: emailSent
          ? `A welcome email with this temporary password was just sent to ${email}. It's also shown once, right here, as a backup.`
          : (isEmailConfigured()
            ? `This temporary password is shown once, right here -- the welcome email to ${email} could not be sent (${emailError || 'unknown error'}), so share it with them directly.`
            : 'This temporary password is shown once, right here -- email sending is not configured for this deployment, so share it with them directly (text, in person, etc.), and have them change it after they first log in.'),
      });
    }

    if (action === 'delete') {
      if (requester.role !== 'superadmin') {
        return res.status(403).json({ ok: false, error: 'Only a superadmin can remove a team member.' });
      }
      const targetId = String(body.userId || '').trim();
      if (!targetId) return res.status(400).json({ ok: false, error: 'userId is required.' });
      if (targetId === requester.id) {
        return res.status(400).json({ ok: false, error: 'You cannot remove your own account -- have another superadmin do it.' });
      }
      const delRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(targetId)}`, {
        method: 'DELETE',
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        },
      });
      if (!delRes.ok) {
        const text = await delRes.text();
        return res.status(400).json({ ok: false, error: 'Could not remove the account: ' + text });
      }
      // Auth user is gone; clean up the profile row too (best-effort -- the
      // account is already removed either way, this just prevents an orphan
      // row from lingering in Team & Access).
      await supabaseRequest(`profiles?id=eq.${encodeURIComponent(targetId)}`, { method: 'DELETE' }).catch(() => {});
      return res.status(200).json({ ok: true, deleted: targetId });
    }

    if (action === 'change_role') {
      if (requester.role !== 'superadmin') {
        return res.status(403).json({ ok: false, error: "Only a superadmin can change a team member's role." });
      }
      const targetId = String(body.userId || '').trim();
      const newRole = String(body.role || '').trim();
      if (!targetId) return res.status(400).json({ ok: false, error: 'userId is required.' });
      if (!['superadmin', 'admin', 'crew'].includes(newRole)) {
        return res.status(400).json({ ok: false, error: 'role must be superadmin, admin, or crew.' });
      }
      if (targetId === requester.id) {
        return res.status(400).json({ ok: false, error: 'You cannot change your own role -- have another superadmin do it.' });
      }
      const upRes = await supabaseRequest(`profiles?id=eq.${encodeURIComponent(targetId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ role: newRole }),
      });
      if (!upRes.ok) {
        const text = await upRes.text();
        return res.status(500).json({ ok: false, error: text });
      }
      const updatedRows = await upRes.json();
      if (!updatedRows[0]) return res.status(404).json({ ok: false, error: 'No team member found with that id.' });
      return res.status(200).json({ ok: true, updated: updatedRows[0] });
    }

    if (action === 'reset_password') {
      const targetId = String(body.userId || '').trim();
      if (!targetId) return res.status(400).json({ ok: false, error: 'userId is required.' });
      const targetRes = await supabaseRequest(`profiles?id=eq.${encodeURIComponent(targetId)}&select=id,role,email,full_name`);
      const targetRows = targetRes.ok ? await targetRes.json() : [];
      const target = targetRows[0];
      if (!target) return res.status(404).json({ ok: false, error: 'No team member found with that id.' });
      // superadmin can reset anyone's password; admin can only reset a crew
      // member's -- never another admin's or a superadmin's.
      const canReset = requester.role === 'superadmin' || (requester.role === 'admin' && target.role === 'crew');
      if (!canReset) {
        return res.status(403).json({
          ok: false,
          error: requester.role === 'admin'
            ? 'Admins can only reset a password for crew-level accounts.'
            : "Only a superadmin or admin can reset someone else's password.",
        });
      }
      const tempPassword = genTempPassword();
      const pwRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(targetId)}`, {
        method: 'PUT',
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password: tempPassword }),
      });
      if (!pwRes.ok) {
        const text = await pwRes.text();
        return res.status(400).json({ ok: false, error: 'Could not reset the password: ' + text });
      }
      return res.status(200).json({
        ok: true,
        userId: targetId,
        tempPassword,
        note: 'This temporary password is shown once, right here. Share it with them directly and have them change it after logging in.',
      });
    }

    return res.status(400).json({ ok: false, error: `Unknown action "${action}".` });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
}

// ---------- Employee schedule roster (resource=employee_roster) ----------
// 2026-07-24: replaces the old hardcoded DTECHS/DOFF/DSUBS column arrays in
// public/index.html's Job Schedule board. Those arrays were a static ~14-person
// list (frozen at whatever it was when the demo template was built -- at least
// 2 of the 14 names matched no real employee at all) that never reflected who
// was actually active in Jobber, and mixed office/owner accounts in with field
// techs. This resource pulls the REAL active roster (users.status='ACTIVATED')
// and joins each person to an admin-assigned "lens" (crew/office/sub/hidden)
// stored in employee_roles, so Chris can control who shows on which calendar
// without a code deploy. Anyone not yet assigned comes back lens='unassigned'
// and the frontend excludes them from every board until an admin picks one.
const VALID_LENSES = ['crew', 'office', 'sub', 'hidden', 'unassigned'];
const VALID_PERMISSION_ROLES = ['owner', 'project_manager', 'dispatch', 'office_ar', 'purchasing', 'admin_remote', 'field_lead', 'field_tech', 'sales'];

async function handleEmployeeRoster(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) {
    return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  }

  if (req.method === 'GET') {
    const usersRes = await supabaseRequest('users?status=neq.DEACTIVATED&email=neq.devteam@zenkoders.com&select=jobber_id,name,email,assigned_vehicle_name&order=name.asc');
    if (!usersRes.ok) {
      const text = await usersRes.text();
      return res.status(500).json({ ok: false, error: text });
    }
    const activeUsers = await usersRes.json();

    const rolesRes = await supabaseRequest('employee_roles?select=jobber_id,lens,division,crew_label,color,permission_role,permission_roles,is_lead,updated_at');
    const roleRows = rolesRes.ok ? await rolesRes.json() : [];
    const rolesById = Object.fromEntries(roleRows.map((r) => [r.jobber_id, r]));

    const roster = activeUsers.map((u) => {
      const role = rolesById[u.jobber_id] || null;
      return {
        jobberId: u.jobber_id,
        name: u.name,
        email: u.email,
        hasVehicle: !!u.assigned_vehicle_name,
        vehicleName: u.assigned_vehicle_name || null,
        lens: (role && role.lens) || 'unassigned',
        division: (role && role.division) || null,
        crewLabel: (role && role.crew_label) || null,
        color: (role && role.color) || null,
        permissionRole: (role && role.permission_role) || null,
        permissionRoles: (role && role.permission_roles) || [],
        // Crew lead: set here in user setup, NOT per job. The schedule board uses
        // it to decide whose row a multi-person job appears on.
        isLead: !!(role && role.is_lead),
      };
    });

    const counts = roster.reduce((acc, p) => { acc[p.lens] = (acc[p.lens] || 0) + 1; return acc; }, {});

    return res.status(200).json({
      ok: true,
      resource: 'employee_roster',
      isAdmin: requester.role === 'admin' || requester.role === 'superadmin',
      roster,
      counts,
      coverageNote: activeUsers.length + ' employees synced from Jobber (excludes deactivated accounts). ' + (counts.unassigned || 0) + ' still need a calendar lens assigned before they show on any schedule board.',
    });
  }

  if (req.method === 'POST') {
    if (requester.role !== 'admin' && requester.role !== 'superadmin') {
      return res.status(403).json({ ok: false, error: 'Only an admin can change schedule roles.' });
    }
    const body = req.body || {};
    const jobberId = (body.jobberId || '').trim();
    const lens = (body.lens || '').trim();
    if (!jobberId) {
      return res.status(400).json({ ok: false, error: 'jobberId is required.' });
    }
    if (!VALID_LENSES.includes(lens)) {
      return res.status(400).json({ ok: false, error: 'lens must be one of: ' + VALID_LENSES.join(', ') });
    }
    const division = body.division != null ? String(body.division).trim() || null : null;
    const crewLabel = body.crewLabel != null ? String(body.crewLabel).trim() || null : null;
    const color = body.color != null ? String(body.color).trim() || null : null;
    // permissionRoles (array) is the source of truth going forward -- a person
    // can hold more than one job-function role (e.g. Owner who also does Sales).
    // Falls back to the legacy single permissionRole field so any not-yet-
    // refreshed client still works.
    // A caller that sends no roles at all is not clearing them -- it is editing
    // something else on the row (e.g. the crew-lead toggle). Since this upsert
    // replaces the whole row, carry the stored roles forward instead of wiping
    // them, and skip validation for values we are not being asked to change.
    // This matters in practice: live rows hold roles like 'field_crew' and
    // 'subcontractor' that are not in VALID_PERMISSION_ROLES, so re-submitting
    // them would 400 on exactly the field crew the lead toggle is meant for.
    const rolesOmitted = !Array.isArray(body.permissionRoles)
      && !(body.permissionRole != null && String(body.permissionRole).trim());
    let permissionRolesArr;
    if (rolesOmitted) {
      const priorRolesRes = await supabaseRequest(`employee_roles?jobber_id=eq.${encodeURIComponent(jobberId)}&select=permission_roles,permission_role&limit=1`);
      const priorRoles = (priorRolesRes.ok ? await priorRolesRes.json() : [])[0] || {};
      permissionRolesArr = priorRoles.permission_roles || (priorRoles.permission_role ? [priorRoles.permission_role] : []);
    } else {
      if (Array.isArray(body.permissionRoles)) {
        permissionRolesArr = body.permissionRoles.map((r) => String(r).trim()).filter(Boolean);
      } else {
        permissionRolesArr = [String(body.permissionRole).trim()];
      }
      const invalidRoles = permissionRolesArr.filter((r) => !VALID_PERMISSION_ROLES.includes(r));
      if (invalidRoles.length) {
        return res.status(400).json({ ok: false, error: 'permissionRoles must each be one of: ' + VALID_PERMISSION_ROLES.join(', ') + ' (invalid: ' + invalidRoles.join(', ') + ')' });
      }
    }
    // De-dupe, keep first-picked order.
    permissionRolesArr = permissionRolesArr.filter((r, i) => permissionRolesArr.indexOf(r) === i);
    const permissionRole = permissionRolesArr[0] || null; // legacy single-value column, kept in sync

    // Crew lead. This upsert replaces the whole row, so a client that predates the
    // field (or a caller only changing the lens) must not silently clear it —
    // when isLead is absent we carry the stored value forward.
    let isLead;
    if (typeof body.isLead === 'boolean') {
      isLead = body.isLead;
    } else {
      const priorRes = await supabaseRequest(`employee_roles?jobber_id=eq.${encodeURIComponent(jobberId)}&select=is_lead&limit=1`);
      const prior = priorRes.ok ? await priorRes.json() : [];
      isLead = !!(prior[0] && prior[0].is_lead);
    }

    const upsertRes = await supabaseRequest('employee_roles', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        jobber_id: jobberId,
        lens,
        division,
        crew_label: crewLabel,
        color,
        permission_role: permissionRole,
        permission_roles: permissionRolesArr,
        is_lead: isLead,
        updated_by: requester.email || requester.id,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!upsertRes.ok) {
      const text = await upsertRes.text();
      return res.status(500).json({ ok: false, error: text });
    }
    return res.status(200).json({ ok: true, jobberId, lens, division, crewLabel, color, permissionRole, permissionRoles: permissionRolesArr, isLead });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
}

// ---------- Subcontractor directory (resource=subcontractors) ----------
// 2026-07-24: Vendors & Subs page was a permanent blank stub. Real company
// directory -- separate from employee_roles (which only tracks people who
// also happen to be a Jobber team member, for schedule-board matching).
// A subcontractor here does not need a Jobber id at all; jobber_id is only
// set when a sub is also matched to visits on the schedule board (see
// Pro Custom Home Builders / Albarn Flood).
async function handleSubcontractors(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) {
    return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  }

  if (req.method === 'GET') {
    const subsRes = await supabaseRequest('subcontractors?select=id,name,trade,contact_name,phone,email,notes,status,jobber_id,updated_at,track_1099,w9_on_file&order=name.asc');
    if (!subsRes.ok) {
      const text = await subsRes.text();
      return res.status(500).json({ ok: false, error: text });
    }
    const rows = await subsRes.json();
    const subs = rows.map((s) => ({
      id: s.id,
      name: s.name,
      trade: s.trade,
      contactName: s.contact_name,
      phone: s.phone,
      email: s.email,
      notes: s.notes,
      status: s.status,
      jobberId: s.jobber_id,
      track1099: !!s.track_1099,
      w9OnFile: !!s.w9_on_file,
    }));
    return res.status(200).json({ ok: true, resource: 'subcontractors', isAdmin: requester.role === 'admin' || requester.role === 'superadmin', subs });
  }

  if (req.method === 'POST') {
    if (requester.role !== 'admin' && requester.role !== 'superadmin') {
      return res.status(403).json({ ok: false, error: 'Only an admin can manage subcontractors.' });
    }
    const body = req.body || {};
    const id = String(body.id || '').trim();

    if (id) {
      const fields = {};
      if (body.name != null) {
        const name = String(body.name).trim();
        if (!name) return res.status(400).json({ ok: false, error: 'name cannot be empty.' });
        fields.name = name;
      }
      if (body.trade != null) fields.trade = String(body.trade).trim() || null;
      if (body.contactName != null) fields.contact_name = String(body.contactName).trim() || null;
      if (body.phone != null) fields.phone = String(body.phone).trim() || null;
      if (body.email != null) fields.email = String(body.email).trim() || null;
      if (body.notes != null) fields.notes = String(body.notes).trim() || null;
      if (body.status != null) {
        const status = String(body.status).trim();
        if (!['active', 'inactive'].includes(status)) {
          return res.status(400).json({ ok: false, error: "status must be 'active' or 'inactive'." });
        }
        fields.status = status;
      }
      fields.updated_by = requester.email || requester.id;
      fields.updated_at = new Date().toISOString();

      const updRes = await supabaseRequest(`subcontractors?id=eq.${id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(fields),
      });
      if (!updRes.ok) {
        const text = await updRes.text();
        return res.status(500).json({ ok: false, error: text });
      }
      const updated = await updRes.json();
      if (!updated || !updated[0]) {
        return res.status(404).json({ ok: false, error: 'Subcontractor not found.' });
      }
      return res.status(200).json({ ok: true, sub: updated[0] });
    }

    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Company name is required.' });
    const row = {
      name,
      trade: String(body.trade || '').trim() || null,
      contact_name: String(body.contactName || '').trim() || null,
      phone: String(body.phone || '').trim() || null,
      email: String(body.email || '').trim() || null,
      notes: String(body.notes || '').trim() || null,
      status: 'active',
      created_by: requester.email || requester.id,
      updated_by: requester.email || requester.id,
    };
    const insRes = await supabaseRequest('subcontractors', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    if (!insRes.ok) {
      const text = await insRes.text();
      return res.status(500).json({ ok: false, error: text });
    }
    const created = (await insRes.json())[0];
    return res.status(200).json({ ok: true, sub: created });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
}

// ---------- Who am I, permission-wise? (resource=my_role) ----------
// 2026-07-24: profiles.role stays the coarse login-level admin/crew flag used
// throughout this file. permission_role (on employee_roles) is the new,
// finer-grained job-function role -- looked up via users.email since profiles
// and employee_roles don't share a key directly. Frontend uses this at
// bootstrap to decide nav visibility + default landing page.
async function handleMyRole(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) {
    return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  let permissionRole = null, permissionRoles = [], lens = null, crewLabel = null;
  if (requester.email) {
    const usersRes = await supabaseRequest('users?email=eq.' + encodeURIComponent(requester.email) + '&select=jobber_id&limit=1');
    if (usersRes.ok) {
      const urows = await usersRes.json();
      const jobberId = urows && urows[0] && urows[0].jobber_id;
      if (jobberId) {
        const roleRes = await supabaseRequest('employee_roles?jobber_id=eq.' + encodeURIComponent(jobberId) + '&select=lens,crew_label,permission_role,permission_roles&limit=1');
        if (roleRes.ok) {
          const rrows = await roleRes.json();
          const row = rrows && rrows[0];
          if (row) {
            permissionRole = row.permission_role || null;
            permissionRoles = row.permission_roles || (permissionRole ? [permissionRole] : []);
            lens = row.lens || null;
            crewLabel = row.crew_label || null;
          }
        }
      }
    }
  }

  return res.status(200).json({
    ok: true,
    resource: 'my_role',
    accessLevel: requester.role || null,
    permissionRole,
    permissionRoles,
    lens,
    crewLabel,
  });
}

// --- Manager's tab: live read-only views of two Google Sheets the team
// already runs day-to-day (GH Project Updates, Materials Purchased
// Mastersheet). Both are shared "Anyone with the link can view" (confirmed
// by fetching their CSV export directly), so we read Google's public CSV
// export endpoint server-side -- no OAuth/service-account credentials
// needed, and nothing is duplicated into Supabase. If Chris ever tightens
// sharing on either sheet, these fail closed with an honest error instead
// of silently serving stale/fake data.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* no-op, \n below ends the row */ }
      else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

async function fetchGoogleSheetAsRows(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid || 0}`;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) {
    throw new Error(`Could not reach the Google Sheet (HTTP ${r.status}). It may no longer be shared as "Anyone with the link can view."`);
  }
  const text = await r.text();
  if (/^<!doctype html/i.test(text.trim()) || /accounts\.google\.com/i.test(text.slice(0, 500))) {
    throw new Error('The Google Sheet returned a sign-in page instead of data -- its sharing setting may have changed to private.');
  }
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], data: [] };
  const headers = rows[0].map((h) => (h || '').trim());
  const data = rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h || `col${i}`] = (r[i] || '').trim(); });
    return obj;
  });
  return { headers, data };
}

// Small header/number helpers for the two Google-Sheet-backed manager reports
// below, so their capped-row payloads can still carry the SAME aggregate
// totals the frontend used to compute itself over the full, uncapped row set.
function sheetHeaderMatch(headers, re) { return headers.find((h) => re.test(h || '')); }
function sheetNumberFrom(v) { const n = parseFloat(String(v || '').replace(/[^0-9.-]/g, '')); return isNaN(n) ? 0 : n; }

// Both sheets below are append-only logs that only ever grow, but were being
// re-fetched and shipped to the browser IN FULL on every load and every
// Refresh click -- and since the frontend then sliced to the FIRST 250 rows
// for display, it was actually showing the OLDEST 250 rows forever, not the
// most recent ones, and that view got staler as the sheet grew. Found during
// the 8/17 Dev To-Do triage ("mpmx renders 69,138 unpaginated characters").
//
// Fix: cap the transported rows to the most recent SHEET_ROW_CAP, but compute
// the summary stats server-side over the FULL sheet first, so capping the
// transport never quietly changes what "Total Spend" or "Total Updates"
// reports -- those numbers must stay real regardless of how much of the
// underlying log the table itself renders.
const SHEET_ROW_CAP = 250;

async function handleManagerGhUpdates(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  try {
    const { headers, data } = await fetchGoogleSheetAsRows('1JhS77MxbgBrAbpdp3x76av6-UMPYuTZHbZSXV5TjD-g', 0);
    const statusCol = sheetHeaderMatch(headers, /status/i);
    let statusCounts = null;
    if (statusCol) {
      statusCounts = {};
      data.forEach((row) => { const val = (row[statusCol] || '').trim() || '(blank)'; statusCounts[val] = (statusCounts[val] || 0) + 1; });
    }
    const rows = data.length > SHEET_ROW_CAP ? data.slice(-SHEET_ROW_CAP) : data;
    return res.status(200).json({
      ok: true,
      resource: 'manager_gh_updates',
      source: 'GH Project Updates (Google Sheet)',
      headers,
      rows,
      totalRows: data.length,
      statusCounts,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
}

async function handleManagerMaterialsPnl(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  try {
    const { headers, data } = await fetchGoogleSheetAsRows('1nCibSjWuwFW9powGwAaD3cGEEVHFCFv-beXNEnCMxBM', 0);
    const totalCol = sheetHeaderMatch(headers, /order\s*item\s*total/i) || sheetHeaderMatch(headers, /order\s*total/i) || sheetHeaderMatch(headers, /total/i);
    const jobCol = sheetHeaderMatch(headers, /job\s*number/i);
    const totalSpend = totalCol ? data.reduce((acc, row) => acc + sheetNumberFrom(row[totalCol]), 0) : null;
    const jobsCovered = jobCol ? new Set(data.map((row) => (row[jobCol] || '').trim()).filter(Boolean)).size : null;
    const rows = data.length > SHEET_ROW_CAP ? data.slice(-SHEET_ROW_CAP) : data;
    return res.status(200).json({
      ok: true,
      resource: 'manager_materials_pnl',
      source: 'Materials Purchased Mastersheet (Google Sheet)',
      headers,
      rows,
      totalRows: data.length,
      totalSpend,
      jobsCovered,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
}

// One-click admin catch-up: provisions a HiveConnect account for every
// HiveLogic profile that doesn't have one yet. Needed because the eager
// provisioning wired into handleTeam above only covers invites going
// forward -- anyone added before that fix (or anyone whose HiveConnect
// account never got created for any other reason) is caught up here
// instead. Safe to run any number of times: provisionHiveConnectAccount
// is idempotent per user, and this skips anyone who already has a mapping.
async function handleHiveConnectBackfill(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) {
    return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }
  if (requester.role !== 'admin' && requester.role !== 'superadmin') {
    return res.status(403).json({ ok: false, error: 'Only an admin can run the HiveConnect backfill.' });
  }

  const r = await supabaseRequest('profiles?select=id,email,full_name,role&order=full_name.asc');
  if (!r.ok) {
    const text = await r.text();
    return res.status(500).json({ ok: false, error: text });
  }
  const profiles = await r.json();

  const results = { total: profiles.length, alreadyMapped: 0, provisioned: 0, failed: [] };
  for (const p of profiles) {
    if (!p.email) {
      results.failed.push({ id: p.id, email: p.email, error: 'Profile has no email on file.' });
      continue;
    }
    try {
      const mapping = await getMapping(p.id);
      if (mapping) {
        results.alreadyMapped++;
        continue;
      }
      await provisionHiveConnectAccount(p.id, p.email);
      results.provisioned++;
    } catch (e) {
      results.failed.push({ id: p.id, email: p.email, error: e.message });
    }
  }

  return res.status(200).json({ ok: true, results });
}


// ---------- Email (Microsoft 365 / Graph) -- resource=mail, mailconnect, mailcallback, mailstatus ----------
// Real inbox read/send against Chris's actual @ghgrp.net mailbox via the
// Microsoft identity platform (OAuth2 authorization-code flow) + Microsoft
// Graph API. Tokens are stored the same way Jobber's are -- one row in the
// "integrations" table, keyed by "key" -- never exposed to the browser.

const MS_SCOPES = 'offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send';
function msTokenUrl() { return `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`; }
function msAuthorizeUrl() { return `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/authorize`; }
function msRedirectUri() { return process.env.MS_REDIRECT_URI || 'https://hivelogic-live.vercel.app/api/track1?resource=mailcallback'; }

async function getStoredMicrosoftTokens() {
  const res = await supabaseRequest('integrations?key=eq.microsoft&select=*');
  if (!res.ok) throw new Error(`Failed to read stored Microsoft tokens: ${await res.text()}`);
  const rows = await res.json();
  if (!rows.length) throw new Error('Microsoft 365 is not connected yet.');
  const row = rows[0];
  if (row) { row.access_token = _decSecret(row.access_token); row.refresh_token = _decSecret(row.refresh_token); }
  return row;
}

async function saveMicrosoftTokens(tokens) {
  const expiresInSeconds = Number.isFinite(tokens.expires_in) ? tokens.expires_in : 3600;
  const res = await supabaseRequest('integrations?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      key: 'microsoft',
      access_token: _encSecret(tokens.access_token),
      refresh_token: _encSecret(tokens.refresh_token),
      expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`Failed to store Microsoft tokens: ${await res.text()}`);
}

async function refreshMicrosoftAccessToken(refreshToken) {
  const tokenRes = await fetch(msTokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      scope: MS_SCOPES,
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok || !tokens.access_token) {
    throw new Error(`Microsoft token refresh failed: ${JSON.stringify(tokens)}`);
  }
  return tokens;
}

// Microsoft access tokens last roughly 60-90 minutes and refresh tokens
// rotate on use, so every refresh must overwrite the stored refresh_token too.
async function getValidMicrosoftAccessToken() {
  const stored = await getStoredMicrosoftTokens();
  const expiresAt = stored.expires_at ? new Date(stored.expires_at).getTime() : 0;
  const isExpiringSoon = !expiresAt || expiresAt - Date.now() < 2 * 60 * 1000;
  if (!isExpiringSoon) return stored.access_token;
  const refreshed = await refreshMicrosoftAccessToken(stored.refresh_token);
  await saveMicrosoftTokens(refreshed);
  return refreshed.access_token;
}

function handleMailConnect(req, res) {
  const clientId = process.env.MS_CLIENT_ID;
  if (!clientId || !process.env.MS_TENANT_ID) {
    return res.status(500).send('<h2>MS_CLIENT_ID / MS_TENANT_ID is not set for this deployment.</h2>');
  }
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: msRedirectUri(),
    response_mode: 'query',
    scope: MS_SCOPES,
    state: 'hivelogic-live',
  });
  res.redirect(`${msAuthorizeUrl()}?${params.toString()}`);
}

async function handleMailCallback(req, res) {
  const { code, error, error_description } = req.query;
  if (error) {
    return res.redirect(`/?mail_error=${encodeURIComponent(error_description || error)}`);
  }
  if (!code) {
    return res.status(400).send('Missing authorization code from Microsoft.');
  }
  try {
    const tokenRes = await fetch(msTokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: process.env.MS_CLIENT_ID,
        client_secret: process.env.MS_CLIENT_SECRET,
        redirect_uri: msRedirectUri(),
        scope: MS_SCOPES,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      console.error('Microsoft token exchange failed:', tokens);
      return res.redirect('/?mail_error=token_exchange_failed');
    }
    await saveMicrosoftTokens(tokens);
    return res.redirect('/?mail_connected=1');
  } catch (e) {
    console.error('Microsoft callback error:', e);
    return res.redirect('/?mail_error=' + encodeURIComponent(e.message));
  }
}

async function handleMailStatus(req, res) {
  try {
    const stored = await getStoredMicrosoftTokens();
    return res.status(200).json({ ok: true, connected: true, connectedAt: stored.updated_at || null });
  } catch (e) {
    return res.status(200).json({ ok: true, connected: false });
  }
}

async function handleMail(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) {
    return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  }
  if (requester.role !== 'admin' && requester.role !== 'superadmin') {
    return res.status(403).json({ ok: false, error: 'Only an admin can view or send mail right now.' });
  }

  let accessToken;
  try {
    accessToken = await getValidMicrosoftAccessToken();
  } catch (e) {
    return res.status(200).json({ ok: false, notConnected: true, error: 'Microsoft 365 is not connected yet.' });
  }

  if (req.method === 'GET') {
    const top = Math.min(Number(req.query.limit) || 25, 100);
    const gRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=${top}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,isRead`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await gRes.json();
    if (!gRes.ok) {
      return res.status(500).json({ ok: false, error: (data.error && data.error.message) || 'Could not load the inbox.' });
    }
    return res.status(200).json({ ok: true, source: 'Microsoft Graph -- real inbox', messages: data.value || [] });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const to = (body.to || '').trim();
    const subject = (body.subject || '').trim();
    const content = body.body || '';
    if (!to || !subject || !content) {
      return res.status(400).json({ ok: false, error: 'to, subject, and body are all required.' });
    }
    const gRes = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'Text', content },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: true,
      }),
    });
    if (gRes.status !== 202) {
      const errText = await gRes.text();
      return res.status(500).json({ ok: false, error: errText || 'Could not send the message.' });
    }
    return res.status(200).json({ ok: true, sent: { to, subject } });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
}


// ---------- Workforce (Employee Daily Workspace) -- resource=workforce_status, workforce_clock, workforce_summary, workforce_team ----------
// Bug fix (2026-08-13, jomell: submitted an EOD report but it showed as
// "not submitted" on the admin Remote & Production board): this used to be
// new Date().toISOString().slice(0,10) -- the UTC calendar day. Greenwich
// Handyman runs on America/New_York, which is 4-5 hours behind UTC, so any
// clock-out or EOD report submitted in the evening (exactly when "end of
// day" reports get submitted) lands on the FOLLOWING UTC date -- e.g.
// 8:30pm ET on the 13th is already 12:30am UTC on the 14th. The write and
// the admin dashboard's "today" read can then disagree about which
// calendar day it belongs to. todayRangeET() (below, already used by the
// real Today's Schedule feature) computes the correct America/New_York
// calendar day; reusing its date here instead of a second, UTC-only
// implementation keeps every workforce day-boundary check (clock in/out,
// EOD, the admin team roster, the production tracker) agreeing with each
// other and with the business's actual clock.
function todayStr() {
  return todayRangeET().dateStr;
}

const WF_STATUS_LABELS = {
  available: 'Available',
  meeting: 'In a Meeting',
  unavailable: 'Unavailable',
  bathroom: 'Bathroom Break',
  lunch: 'Lunch Break',
  help: 'Needs Help',
};

async function handleWorkforceSetStatus(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const status = (req.body && req.body.status) || '';
  const emoji = (req.body && req.body.emoji) || '';
  if (!WF_STATUS_LABELS[status]) return res.status(400).json({ ok: false, error: 'Unknown status.' });
  const openRes = await supabaseRequest(`workforce_time_sessions?employee_id=eq.${requester.id}&status=eq.active&order=clock_in.desc&limit=1`);
  if (!openRes.ok) return res.status(200).json({ ok: false, error: 'Workforce tables are not set up yet in Supabase.' });
  const open = await openRes.json();
  if (!open || !open[0]) return res.status(400).json({ ok: false, error: 'Clock in first to set a status.' });
  const updRes = await supabaseRequest(`workforce_time_sessions?id=eq.${open[0].id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status_flag: status, status_emoji: emoji, status_updated_at: new Date().toISOString() }),
  });
  if (!updRes.ok) return res.status(500).json({ ok: false, error: 'Could not update status: ' + (await updRes.text()) });
  const rows = await updRes.json();
  return res.status(200).json({ ok: true, session: rows[0] });
}

async function handleWorkforceTeamStatus(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const sessRes = await supabaseRequest('workforce_time_sessions?status=eq.active&order=clock_in.desc');
  if (!sessRes.ok) return res.status(200).json({ ok: true, team: [], tablesReady: false });
  const sessions = await sessRes.json();
  if (!sessions.length) return res.status(200).json({ ok: true, team: [], tablesReady: true });
  const ids = [...new Set(sessions.map(s => s.employee_id))];
  const profRes = await supabaseRequest(`profiles?select=id,full_name,email&id=in.(${ids.join(',')})`);
  const profiles = profRes.ok ? await profRes.json() : [];
  const team = sessions.map(s => {
    const p = profiles.find(pr => pr.id === s.employee_id);
    return {
      id: s.employee_id,
      full_name: (p && p.full_name) || (p && p.email) || 'Unknown',
      status: s.status_flag || 'available',
      statusLabel: WF_STATUS_LABELS[s.status_flag] || 'Available',
      emoji: s.status_emoji || '✅',
      statusUpdatedAt: s.status_updated_at || s.clock_in,
      onBreak: !!s.on_break,
    };
  });
  return res.status(200).json({ ok: true, team, tablesReady: true });
}

// ---------- Watching: real "unscheduled work" (crew open) ----------
// Jobber's own 'unscheduled' job_status -- the honest analog available today
// for crew open / unassigned work. No crew/technician assignment data is
// synced from Jobber yet (visits have no assigned-user field), so this shows
// jobs that need a start date, not which named crew has an open slot.
// PC Bridge heartbeat status (2026-08-01): reads bridge_heartbeats (written
// every 60s by the Task Scheduler job on Chris's PC via the bridge-heartbeat
// edge function, shipped 7/31). online = last ping under 2 minutes old; gaps
// >2min in the past 24h are counted so drops stay visible after the fact.
// Distinguishes PC-down (pings stop) from Claude-link-down (pings continue).
async function handleWatchingBridgeStatus(res) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = await fiFetchAllRows('bridge_heartbeats', '?select=pinged_at&pinged_at=gte.' + since + '&order=pinged_at.asc');
  // The legacy ps1 heartbeat was retired 7/31 (security sweep). The HiveLogic
  // Monitor desktop agent already phones home every 60s over its own
  // authenticated channel - use its last_seen_at as an equally valid
  // PC-online signal. Freshest of the two wins.
  let agentLast = null;
  try {
    const agents = await fiFetchAllRows('monitor_agents', '?status=eq.active&select=last_seen_at&order=last_seen_at.desc.nullslast&limit=1');
    if (agents.length && agents[0].last_seen_at) agentLast = agents[0].last_seen_at;
  } catch (e) { /* monitor tables optional */ }
  let last = rows.length ? rows[rows.length - 1].pinged_at : null;
  if (agentLast && (!last || new Date(agentLast) > new Date(last))) last = agentLast;
  let gaps = 0;
  for (let i = 1; i < rows.length; i++) {
    if (new Date(rows[i].pinged_at).getTime() - new Date(rows[i - 1].pinged_at).getTime() > 2 * 60 * 1000) gaps++;
  }
  const ageSeconds = last ? Math.round((Date.now() - new Date(last).getTime()) / 1000) : null;
  return res.status(200).json({
    ok: true,
    asOf: new Date().toISOString(),
    lastPing: last,
    ageSeconds: ageSeconds,
    online: ageSeconds !== null && ageSeconds < 120,
    gaps24h: gaps,
    pings24h: rows.length,
    note: 'PC-online signal: freshest of bridge_heartbeats and the Monitor agent heartbeat (60s cadence). online = under 2 minutes old.',
  });
}

async function handleWatchingUnscheduled(res) {
  // Widened 2026-08-18 (Chris's call) from job_status='unscheduled' to "has no
  // start date". The status is a strict SUBSET of the real answer: of the 83
  // open jobs, 7 carried that status but 16 had no date -- the other 9 were
  // 'action_required' (7) and HiveLogic-native 'active' jobs created without a
  // date (2). Those 9 were on nobody's calendar and in nobody's count, which is
  // exactly the work this panel exists to surface.
  //
  // completed_at is excluded defensively -- no such row exists today, but a
  // finished job is not work waiting to be booked.
  const jobs = await fiFetchAllRows('jobs', "?job_status=neq.archived&start_at=is.null&completed_at=is.null&select=jobber_id,job_number,title,total,client_id,job_status,jobber_web_uri,jobber_created_at&order=jobber_created_at.asc");
  const clientIds = [...new Set(jobs.map(function(j){ return j.client_id; }).filter(Boolean))];
  var clientsById = {};
  if (clientIds.length) {
    const rows = await supabaseRequest('clients?jobber_id=in.(' + clientIds.join(',') + ')&select=jobber_id,name');
    const list = rows.ok ? await rows.json() : [];
    clientsById = Object.fromEntries(list.map(function(c){ return [c.jobber_id, c.name]; }));
  }
  const items = jobs.map(function(j){
    return {
      jobNumber: j.job_number,
      title: j.title,
      clientName: clientsById[j.client_id] || null,
      total: fiRound2(j.total),
      waitingDays: fiDaysAgo(j.jobber_created_at),
      // Carried through so a caller can see this is a mix of statuses, not
      // only Jobber's 'unscheduled' one.
      status: j.job_status,
      url: j.jobber_web_uri,
    };
  });
  return res.status(200).json({
    ok: true,
    source: 'Jobber via Supabase -- live',
    asOf: new Date().toISOString(),
    count: items.length,
    jobs: items,
    byStatus: items.reduce(function (acc, j) { const k = j.status || 'unknown'; acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
    note: "Open jobs with no start date -- work waiting to be booked. This is a mix of job statuses, not only Jobber's 'unscheduled' one (see byStatus). Crew assignment isn't synced, so this is jobs needing a date, not a specific crew's open slot.",
  });
}

// ---------- Watching: real job-margin-fade detection ----------
// Cross-references Jobber's job contract totals (jobs.total) with QBO's
// Customer:Job actual-cost totals (job_costing_summary) to flag active jobs
// where costs-to-date look like they're eating the margin. Coverage caveat,
// stated honestly rather than hidden: QBO's Customer:Job coding is not used
// on every expense line -- only jobs that show up in job_costing_summary's
// list have any tracked actual cost here. A job with real overruns that were
// never coded to it in QuickBooks will not appear -- not because it's fine,
// but because there is no data yet.
// Perf fix (2026-07-31): the QBO job-costing scan behind this used to run
// LIVE on every cold serverless start -- 10-15s of QuickBooks pagination
// that froze the Command Center's "Jobs Needing Attention" tile. The scan
// result is now persisted in Supabase (sql/042_qbo_report_cache.sql) via
// getFinancialsDurable(): cached costing serves instantly; when it's older
// than 15 min the handler responds with the cached numbers FIRST (age
// honestly labeled in costDataAsOf/coverageNote) and re-scans QuickBooks
// AFTER the response is sent. Jobber-side data (contract totals, job list)
// is still fetched live on every call -- only the slow QBO scan is cached.
// Shared by computeWatchingMarginFade() (flags only the jobs crossing the
// fade threshold) and computeJobsMarginList() (the Jobs page's Margin list
// tab -- every active job, not just the flagged ones). One join, two views.
async function computeJobCostJoin() {
  if (!(await qboConnected())) {
    return { ok: false, error: 'QuickBooks is not connected yet. Visit /api/qbo to authorize.' };
  }
  const [costingRes, jobs] = await Promise.all([
    getFinancialsDurable('job_costing_summary'),
    fiFetchAllRows('jobs', '?completed_at=is.null&total=gt.0&select=jobber_id,job_number,title,total,job_status,jobber_web_uri'),
  ]);
  const costing = costingRes.data || {};
  if (costing.error) return { ok: false, error: costing.error };

  const costByJobNumber = {};
  for (const j of costing.jobs) costByJobNumber[String(j.jobNumber)] = j;

  return { ok: true, costingRes, costing, costByJobNumber, jobs };
}

let marginFadeCacheT = 0; let marginFadeCachePromise = null;
async function computeWatchingMarginFade() {
  const join = await computeJobCostJoin();
  if (!join.ok) return { status: 200, body: { ok: false, error: join.error } };
  const { costingRes, costing, costByJobNumber, jobs } = join;

  const FADE_THRESHOLD = 0.7;
  const flagged = [];
  let jobsWithCostData = 0;
  for (const j of jobs) {
    const costed = costByJobNumber[String(j.job_number)];
    if (!costed) continue;
    jobsWithCostData++;
    const ratio = costed.actualCost / fiNum(j.total);
    if (ratio >= FADE_THRESHOLD) {
      flagged.push({
        jobNumber: j.job_number,
        title: j.title,
        contractTotal: fiRound2(j.total),
        actualCostSoFar: fiRound2(costed.actualCost),
        marginUsedPct: fiRound2(ratio * 100),
        lineCount: costed.lineCount,
        url: j.jobber_web_uri,
      });
    }
  }
  flagged.sort(function(a,b){ return b.marginUsedPct - a.marginUsedPct; });

  const costAgeMin = Math.max(0, Math.round((Date.now() - new Date(costingRes.cachedAt).getTime()) / 60000));
  return { refreshCosting: costingRes.refresh || null, status: 200, body: {
    ok: true,
    source: 'Jobber (contract total, live) + QuickBooks Customer:Job (actual cost' + (costingRes.stale || costAgeMin > 0 ? ', cached ' + costAgeMin + ' min ago' : ', live') + ')',
    asOf: new Date().toISOString(),
    costDataAsOf: costingRes.cachedAt,
    fadeThresholdPct: FADE_THRESHOLD * 100,
    activeJobsScanned: jobs.length,
    activeJobsWithCostData: jobsWithCostData,
    flagged: flagged,
    coverageNote: 'Only jobs QuickBooks has real Customer:Job-coded expense lines for show up here (' + costing.jobs.length + ' jobs total, ' + costing.matchedLines + ' coded lines, $' + Math.round(costing.unmatchedAmount).toLocaleString() + ' in other spend not coded to a job). A job not listed here isn\'t confirmed healthy -- it may just not have cost data yet.' + (costingRes.stale ? ' QuickBooks cost figures are from ' + costAgeMin + ' min ago and are being refreshed in the background right now.' : '')
  } };
}
async function handleWatchingMarginFade(res) {
  if (!marginFadeCachePromise || (Date.now() - marginFadeCacheT) >= 50 * 1000) {
    marginFadeCacheT = Date.now();
    marginFadeCachePromise = computeWatchingMarginFade().catch(function(e){
      marginFadeCachePromise = null;
      throw e;
    });
  }
  const result = await marginFadeCachePromise;
  res.status(result.status).json(result.body);
  // Stale-while-revalidate: the response above is already on its way to the
  // browser; re-scanning QuickBooks now (before the handler returns, so
  // Vercel keeps the invocation alive -- track1 has maxDuration 120s) makes
  // the NEXT request serve fresh numbers instantly. Errors here are
  // non-fatal by design: the user already got a complete, honest response.
  if (result.refreshCosting) {
    const doRefresh = result.refreshCosting;
    result.refreshCosting = null; // one refresh per memoized result, not per request
    try { await doRefresh(); } catch (e) {}
  }
}

// ---------- Jobs page "Margin list" tab (2026-08-15, jomell: this tab was
// entirely static illustrative demo copy -- fake job names, fake margins,
// and a "live from job costs" claim that wasn't true -- sitting right next
// to the real, Jobber-synced Production board). Same real Jobber-contract-
// total + QuickBooks Customer:Job-actual-cost join as the margin-fade
// watcher above, but returns EVERY active job (not just the ones crossing
// the fade tripwire), and is honest about which jobs have no QBO cost
// coding yet rather than silently omitting them. ----------
let jobsMarginListCacheT = 0; let jobsMarginListCachePromise = null;
export async function computeJobsMarginList() {
  const join = await computeJobCostJoin();
  if (!join.ok) return { status: 200, body: { ok: false, error: join.error } };
  const { costingRes, costing, costByJobNumber, jobs } = join;

  const rows = jobs.map(function(j) {
    const costed = costByJobNumber[String(j.job_number)];
    const contractTotal = fiRound2(j.total);
    if (!costed) {
      return {
        jobNumber: j.job_number, title: j.title, contractTotal,
        hasCostData: false, actualCostSoFar: null, marginPct: null, percentOfContractSpent: null,
        url: j.jobber_web_uri, jobberId: j.jobber_id,
      };
    }
    const ratio = costed.actualCost / fiNum(j.total);
    return {
      jobNumber: j.job_number, title: j.title, contractTotal,
      hasCostData: true,
      actualCostSoFar: fiRound2(costed.actualCost),
      marginPct: fiRound2((1 - ratio) * 100),
      percentOfContractSpent: fiRound2(ratio * 100),
      url: j.jobber_web_uri, jobberId: j.jobber_id,
    };
  });
  // Worst margin first (most actionable) -- jobs with no cost data yet
  // (nothing to act on) sort to the bottom rather than being hidden.
  rows.sort(function(a, b) {
    if (a.hasCostData && b.hasCostData) return a.marginPct - b.marginPct;
    if (a.hasCostData !== b.hasCostData) return a.hasCostData ? -1 : 1;
    return 0;
  });

  const jobsWithCostData = rows.filter(function(r){ return r.hasCostData; }).length;
  const costAgeMin = Math.max(0, Math.round((Date.now() - new Date(costingRes.cachedAt).getTime()) / 60000));
  return { refreshCosting: costingRes.refresh || null, status: 200, body: {
    ok: true,
    source: 'Jobber (contract total, live) + QuickBooks Customer:Job (actual cost' + (costingRes.stale || costAgeMin > 0 ? ', cached ' + costAgeMin + ' min ago' : ', live') + ')',
    asOf: new Date().toISOString(),
    costDataAsOf: costingRes.cachedAt,
    activeJobsScanned: jobs.length,
    activeJobsWithCostData: jobsWithCostData,
    jobs: rows,
    coverageNote: 'Only jobs QuickBooks has real Customer:Job-coded expense lines for show a margin number (' + jobsWithCostData + ' of ' + jobs.length + ' active jobs today). The rest show "no cost data yet" rather than a fabricated margin.' + (costingRes.stale ? ' QuickBooks cost figures are from ' + costAgeMin + ' min ago and are being refreshed in the background right now.' : '')
  } };
}
async function handleJobsMarginList(res) {
  if (!jobsMarginListCachePromise || (Date.now() - jobsMarginListCacheT) >= 50 * 1000) {
    jobsMarginListCacheT = Date.now();
    jobsMarginListCachePromise = computeJobsMarginList().catch(function(e){
      jobsMarginListCachePromise = null;
      throw e;
    });
  }
  const result = await jobsMarginListCachePromise;
  res.status(result.status).json(result.body);
  if (result.refreshCosting) {
    const doRefresh = result.refreshCosting;
    result.refreshCosting = null;
    try { await doRefresh(); } catch (e) {}
  }
}

// Real "Today's Schedule" for the Command Center, built from Jobber visits
// already synced into Supabase (table `visits`, ~4.4k rows). Uses the
// business's real calendar day in America/New_York (Greenwich Handyman's
// timezone). Honest coverage note: Jobber's Visit object exposes
// assignedUsers (crew/technician), but that field is not queried by the
// current sync, so visits below are real time/client/job data -- NOT
// grouped by crew. Do not fabricate crew names to fill that gap.
function todayRangeET() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', timeZoneName: 'shortOffset'
  }).formatToParts(now);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const y = get('year'), mo = get('month'), d = get('day');
  const offsetPart = get('timeZoneName') || 'GMT-5';
  const m = offsetPart.match(/GMT([+-]\d+)/);
  const offsetHours = m ? parseInt(m[1], 10) : -5;
  const offsetStr = (offsetHours <= 0 ? '-' : '+') + String(Math.abs(offsetHours)).padStart(2, '0') + ':00';
  return {
    dateStr: `${y}-${mo}-${d}`,
    startISO: `${y}-${mo}-${d}T00:00:00${offsetStr}`,
    endISO: `${y}-${mo}-${d}T23:59:59${offsetStr}`,
    nowMs: now.getTime(),
  };
}


function rangeParamsET(req) {
  const { dateStr: todayStr } = todayRangeET();
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset'
  }).formatToParts(now);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const offsetPart = get('timeZoneName') || 'GMT-5';
  const m = offsetPart.match(/GMT([+-]\d+)/);
  const offsetHours = m ? parseInt(m[1], 10) : -5;
  const offsetStr = (offsetHours <= 0 ? '-' : '+') + String(Math.abs(offsetHours)).padStart(2, '0') + ':00';
  const isValidDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const startDateStr = isValidDate(req.query.start) ? req.query.start : todayStr;
  const endDateStr = isValidDate(req.query.end) ? req.query.end : startDateStr;
  return {
    startDateStr,
    endDateStr,
    startISO: `${startDateStr}T00:00:00${offsetStr}`,
    endISO: `${endDateStr}T23:59:59${offsetStr}`,
  };
}

async function handleTodaySchedule(res) {
  const { dateStr, startISO, endISO, nowMs } = todayRangeET();
  const visits = await fiFetchAllRows(
    'visits',
    '?select=jobber_id,title,start_at,end_at,completed_at,is_all_day,client_id,job_id' +
      '&end_at=gte.' + encodeURIComponent(startISO) +
      '&start_at=lte.' + encodeURIComponent(endISO) +
      '&order=start_at.asc'
  );

  const clientIds = [...new Set(visits.map((v) => v.client_id).filter(Boolean))];
  const jobIds = [...new Set(visits.map((v) => v.job_id).filter(Boolean))];

  let clientsById = {};
  if (clientIds.length) {
    const r = await supabaseRequest('clients?jobber_id=in.(' + clientIds.join(',') + ')&select=jobber_id,name');
    const list = r.ok ? await r.json() : [];
    clientsById = Object.fromEntries(list.map((c) => [c.jobber_id, c.name]));
  }
  let jobsById = {};
  if (jobIds.length) {
    const r = await supabaseRequest('jobs?jobber_id=in.(' + jobIds.join(',') + ')&select=jobber_id,job_number,title,job_status,jobber_web_uri');
    const list = r.ok ? await r.json() : [];
    jobsById = Object.fromEntries(list.map((j) => [j.jobber_id, j]));
  }

  const items = visits.map((v) => {
    const job = jobsById[v.job_id] || null;
    const startMs = v.start_at ? new Date(v.start_at).getTime() : null;
    const endMs = v.end_at ? new Date(v.end_at).getTime() : null;
    let status = 'upcoming';
    if (v.completed_at) status = 'completed';
    else if (startMs && endMs && nowMs >= startMs && nowMs <= endMs) status = 'in_progress';
    else if (endMs && nowMs > endMs) status = 'overdue';
    return {
      title: v.title,
      clientName: clientsById[v.client_id] || null,
      jobNumber: job ? job.job_number : null,
      jobStatus: job ? job.job_status : null,
      jobberUrl: job ? job.jobber_web_uri : null,
      startAt: v.start_at,
      endAt: v.end_at,
      isAllDay: !!v.is_all_day,
      status,
    };
  });

  let nextScheduledAt = null;
  if (items.length === 0) {
    const r3 = await supabaseRequest('visits?select=start_at&start_at=gt.' + encodeURIComponent(endISO) + '&order=start_at.asc&limit=1');
    const nextRows = r3.ok ? await r3.json() : [];
    nextScheduledAt = nextRows[0] ? nextRows[0].start_at : null;
  }

  return res.status(200).json({
    ok: true,
    resource: 'today_schedule',
    date: dateStr,
    totalVisits: items.length,
    completed: items.filter((i) => i.status === 'completed').length,
    inProgress: items.filter((i) => i.status === 'in_progress').length,
    upcoming: items.filter((i) => i.status === 'upcoming').length,
    overdue: items.filter((i) => i.status === 'overdue').length,
    nextScheduledAt,
    coverageNote: 'Real scheduled visit times and job info from Jobber, including real crew assignment and arrival windows synced per visit. See resource=crew_schedule for the crew-grouped dispatch view.',
    visits: items,
  });
}

// ---- REAL crew dispatch board (Command Center's bigger sibling: the
// HiveLogic Job Schedule page). Groups today's visits by assigned crew
// member -- assigned_users and arrival windows are real, synced from
// Jobber (see sync-extended.js VISITS_QUERY). Vehicle GPS is real and
// live too, but Jobber has no tech-to-vehicle link configured on this
// account, so vehicles are listed separately, not attached to a crew row.
// FleetSharp is the primary GPS source, Jobber the fallback (2026-08-11):
// whichever has the newer timestamp for a given vehicle wins. FleetSharp
// wins whenever it's actively pushing (api/jobber/sync-extended.js,
// ?resource=fleetsharp_push); Jobber's own 15-minute
// Vehicle.liveState.currentPosition sync only wins if FleetSharp goes quiet
// for that specific truck.
// Freshness is reported, not just used to choose. "Whichever is newer" says
// nothing about whether the winner is any good: with Jobber's own feed frozen
// since 2026-07-28 on this account, a truck whose FleetSharp push goes quiet
// falls back to an 18-day-old position that is indistinguishable from a current
// one unless the caller does the arithmetic itself. Callers that draw a marker
// need to know, so `stale`, `ageMs` and `source` come back with the position.
// FleetSharp is the ONLY source of vehicle position (Chris, 2026-08-16).
//
// This used to pick whichever of Jobber and FleetSharp was newer. That sounds
// safe and was not: Jobber's own GPS feed on this account has been frozen
// since 2026-07-28 (that is why the FleetSharp push was added on 2026-08-11),
// so the "fallback" was never a fallback -- it was a guarantee of a
// three-week-old position wherever FleetSharp happened not to win. Worse, the
// several read paths that never called this helper at all read the Jobber
// columns directly and drew those stale positions on the map with no
// indication anything was wrong. Checked before changing: all 10 vehicles have
// a FleetSharp fix, the newest is minutes old, and the newest Jobber fix is
// 2026-07-28. Dropping Jobber loses no coverage.
//
// The Jobber columns are still synced and still in the table -- this stops
// READING them for position, it does not delete anything, so restoring the
// old behaviour is a one-line revert if Jobber's feed ever comes back.
//
// Freshness is still reported rather than assumed. A single source means a
// silent FleetSharp outage has nothing to hide behind, so `stale` and `ageMs`
// matter MORE now, not less: callers that draw a marker must be able to tell a
// live truck from a parked history. api/_lib/health-signals.js watches
// vehicles.fleetsharp_updated_at for the same reason.
// ---------- Capacity Planning, Phase 1 (2026-08-11) ----------
// Crew scheduled hours + backlog by month, built from real visits/jobs data
// (the page was previously 100% hardcoded mock -- confirmed via investigation,
// zero fetch() calls anywhere in it). Deliberately does NOT compute a "% of
// capacity" or an oversold/undersold status: there is no "expected hours per
// week" concept anywhere in this schema (no admin setting, no stored
// default), so inventing one here would be exactly the kind of fabricated
// precision Law 1 forbids (same reasoning already applied to job-health
// scoring in api/jobs.js). Shows real scheduled hours instead, sorted
// busiest-first -- an honest relative comparison, not a fake absolute
// percentage. Grouped by individual technician (assigned_users' own name),
// not by a "crew pairing" concept -- no reliable, populated crew-pairing
// field exists to group by instead.
async function handleCapacityCrewHours(req, res) {
  const days = Math.max(1, Math.min(180, Number(req.query.days) || 30));
  const rangeStartISO = new Date().toISOString();
  const rangeEndISO = new Date(Date.now() + days * 86400000).toISOString();
  const rows = await fiFetchAllRows(
    'visits',
    '?select=start_at,end_at,assigned_users' +
      '&start_at=gte.' + encodeURIComponent(rangeStartISO) +
      '&start_at=lte.' + encodeURIComponent(rangeEndISO)
  );
  const hoursByTech = {};
  for (const v of rows) {
    if (!v.start_at || !v.end_at) continue;
    const hrs = (new Date(v.end_at).getTime() - new Date(v.start_at).getTime()) / 3600000;
    if (!(hrs > 0)) continue;
    let assigned = [];
    try { assigned = typeof v.assigned_users === 'string' ? JSON.parse(v.assigned_users) : (v.assigned_users || []); } catch (e) { assigned = []; }
    for (const person of assigned) {
      const name = person && person.name;
      if (!name) continue;
      hoursByTech[name] = (hoursByTech[name] || 0) + hrs;
    }
  }
  const crew = Object.entries(hoursByTech)
    .map(([name, hours]) => ({ name, hours: Math.round(hours * 10) / 10 }))
    .sort((a, b) => b.hours - a.hours);
  return res.status(200).json({
    ok: true,
    resource: 'capacity_crew_hours',
    days,
    rangeStart: rangeStartISO,
    rangeEnd: rangeEndISO,
    crew,
    note: 'Real scheduled hours from the visit calendar, grouped by technician. There is no "expected hours per week" setting anywhere in HiveLogic yet, so this shows relative load (busiest first) rather than a fabricated percent of capacity.',
  });
}

// Real signed-job dollar totals bucketed by each job's scheduled start
// month -- "backlog" here means active (non-archived) work, not pipeline/
// quotes (that's a separate, not-yet-built comparison). Jobs with no
// start_at yet (unscheduled) can't be placed in a month and are excluded,
// not silently folded into the current month.
async function handleCapacityBacklogByMonth(req, res) {
  const months = Math.max(1, Math.min(12, Number(req.query.months) || 4));
  const now = new Date();
  const rangeStartISO = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const rangeEndISO = new Date(now.getFullYear(), now.getMonth() + months, 1).toISOString();
  const rows = await fiFetchAllRows(
    'jobs',
    '?select=job_number,total,start_at,job_status' +
      '&start_at=gte.' + encodeURIComponent(rangeStartISO) +
      '&start_at=lt.' + encodeURIComponent(rangeEndISO) +
      '&job_status=neq.archived'
  );
  const buckets = {};
  const order = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    buckets[key] = { key, label: d.toLocaleString('en-US', { month: 'short' }).toUpperCase(), total: 0, jobCount: 0 };
    order.push(key);
  }
  let unscheduledSkipped = 0;
  for (const j of rows) {
    if (!j.start_at) { unscheduledSkipped++; continue; }
    const d = new Date(j.start_at);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (!buckets[key]) continue;
    buckets[key].total += Number(j.total) || 0;
    buckets[key].jobCount += 1;
  }
  return res.status(200).json({
    ok: true,
    resource: 'capacity_backlog_by_month',
    months: order.map((k) => buckets[k]),
    unscheduledSkipped,
    note: 'Real signed-job totals bucketed by each job\'s scheduled start month. Jobs with no start date set yet are not included in any month above.',
  });
}

// Looks up each vehicle's most recent arrival/departure at a job site today,
// from the geofence engine's fleet_job_presence table (api/fleet/detect-presence.js).
// Joined by VIN: public.vehicles has no link to the fleet_* tables directly,
// fleet_vehicles.vin == public.vehicles.vin is the documented join (see
// supabase/migrations/20260814192951_fleet_slice1_schema.sql). Returns a plain
// object keyed by VIN so the caller can attach it to each vehicle it already has.
export async function fleetJobPresenceByVin(vehicles, sinceISO) {
  const vins = [...new Set(vehicles.map((v) => v.vin).filter(Boolean))];
  if (!vins.length) return {};

  const vinList = vins.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',');
  const fvRes = await supabaseRequest(`fleet_vehicles?select=id,vin&vin=in.(${vinList})`);
  const fleetVehicles = fvRes.ok ? await fvRes.json() : [];
  if (!fleetVehicles.length) return {};
  const vinByFleetVehicleId = Object.fromEntries(fleetVehicles.map((fv) => [fv.id, fv.vin]));

  const presRes = await supabaseRequest(
    'fleet_job_presence?vehicle_id=in.(' + fleetVehicles.map((fv) => fv.id).join(',') + ')' +
      '&arrived_at=gte.' + encodeURIComponent(sinceISO) +
      '&select=vehicle_id,job_uuid,arrived_at,departed_at&order=arrived_at.desc'
  );
  const presenceRows = presRes.ok ? await presRes.json() : [];
  if (!presenceRows.length) return {};

  // Rows arrive newest-first; keep only each vehicle's latest interval today.
  const latestByVehicleId = {};
  for (const row of presenceRows) {
    if (!latestByVehicleId[row.vehicle_id]) latestByVehicleId[row.vehicle_id] = row;
  }

  const jobUuids = [...new Set(Object.values(latestByVehicleId).map((r) => r.job_uuid).filter(Boolean))];
  let jobNumberByUuid = {};
  if (jobUuids.length) {
    const jRes = await supabaseRequest(`jobs?uuid_id=in.(${jobUuids.join(',')})&select=uuid_id,job_number`);
    const jRows = jRes.ok ? await jRes.json() : [];
    jobNumberByUuid = Object.fromEntries(jRows.map((j) => [j.uuid_id, j.job_number]));
  }

  const byVin = {};
  for (const [vehicleId, row] of Object.entries(latestByVehicleId)) {
    const vin = vinByFleetVehicleId[vehicleId];
    if (!vin) continue;
    byVin[vin] = {
      arrivedAt: row.arrived_at,
      departedAt: row.departed_at,
      jobNumber: row.job_uuid ? (jobNumberByUuid[row.job_uuid] || null) : null,
    };
  }
  return byVin;
}

export async function handleCrewSchedule(res) {
  const { dateStr, startISO, endISO } = todayRangeET();
  const visits = await fiFetchAllRows(
    'visits',
    '?select=jobber_id,title,start_at,end_at,arrival_window_start,arrival_window_end,visit_status,assigned_users,client_id,job_id' +
      '&end_at=gte.' + encodeURIComponent(startISO) +
      '&start_at=lte.' + encodeURIComponent(endISO) +
      '&order=start_at.asc'
  );
  const clientIds = [...new Set(visits.map((v) => v.client_id).filter(Boolean))];
  const jobIds = [...new Set(visits.map((v) => v.job_id).filter(Boolean))];
  let clientsById = {};
  if (clientIds.length) {
    const r = await supabaseRequest('clients?jobber_id=in.(' + clientIds.join(',') + ')&select=jobber_id,name');
    const list = r.ok ? await r.json() : [];
    clientsById = Object.fromEntries(list.map((c) => [c.jobber_id, c.name]));
  }
  let jobsById = {};
  if (jobIds.length) {
    const r = await supabaseRequest('jobs?jobber_id=in.(' + jobIds.join(',') + ')&select=jobber_id,job_number,title,job_status,jobber_web_uri');
    const list = r.ok ? await r.json() : [];
    jobsById = Object.fromEntries(list.map((j) => [j.jobber_id, j]));
  }
  const vehiclesRes = await supabaseRequest(`vehicles?select=jobber_id,name,make,model,icon_color,vin,${VEHICLE_GPS_COLUMNS}&order=name.asc`);
  const vehicles = vehiclesRes.ok ? await vehiclesRes.json() : [];
  const vehiclesByJobberId = Object.fromEntries(vehicles.map((v) => [v.jobber_id, v]));
  const presenceByVin = await fleetJobPresenceByVin(vehicles, startISO);

  const usersVehicleRes = await supabaseRequest('users?assigned_vehicle_id=not.is.null&select=jobber_id,name,assigned_vehicle_id,assigned_vehicle_name');
  const usersVehicleRows = usersVehicleRes.ok ? await usersVehicleRes.json() : [];
  const vehicleByUserId = Object.fromEntries(usersVehicleRows.map((u) => [u.jobber_id, { id: u.assigned_vehicle_id, name: u.assigned_vehicle_name }]));
  const vehicleAssignments = usersVehicleRows.map((u) => ({
    techName: u.name,
    techJobberId: u.jobber_id,
    vehicleId: u.assigned_vehicle_id,
    vehicleName: u.assigned_vehicle_name,
  }));

  const crews = {};
  const unassigned = [];
  for (const v of visits) {
    let assigned = [];
    try {
      assigned = typeof v.assigned_users === 'string' ? JSON.parse(v.assigned_users) : (v.assigned_users || []);
    } catch (e) { assigned = []; }
    const job = jobsById[v.job_id] || null;
    const entry = {
      visitId: v.jobber_id,
      title: v.title,
      clientName: clientsById[v.client_id] || null,
      jobNumber: job ? job.job_number : null,
      jobberUrl: job ? job.jobber_web_uri : null,
      startAt: v.start_at,
      endAt: v.end_at,
      arrivalWindowStart: v.arrival_window_start,
      arrivalWindowEnd: v.arrival_window_end,
      status: v.visit_status || null,
    };
    if (!assigned.length) { unassigned.push(entry); continue; }
    for (const person of assigned) {
      const key = person.name || person.id;
      if (!key) continue;
      if (!crews[key]) {
        const assignedVehicle = vehicleByUserId[person.id] || null;
        let vehicleInfo = null;
        if (assignedVehicle) {
          const vg = vehiclesByJobberId[assignedVehicle.id] || null;
          const fresh = vg ? vehicleGps(vg) : null;
          vehicleInfo = {
            name: assignedVehicle.name,
            status: fresh ? fresh.status : null,
            speed: fresh ? fresh.speed : null,
            lat: fresh ? fresh.lat : null,
            lng: fresh ? fresh.lng : null,
            updatedAt: fresh ? fresh.updatedAt : null,
            source: fresh ? fresh.source : null,
            stale: fresh ? fresh.stale : null,
            iconColor: vg ? vg.icon_color : null,
          };
        }
        crews[key] = { name: person.name, jobberId: person.id, vehicle: vehicleInfo, visits: [] };
      }
      crews[key].visits.push(entry);
    }
  }
  const crewList = Object.values(crews).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  return res.status(200).json({
    ok: true,
    resource: 'crew_schedule',
    date: dateStr,
    crews: crewList,
    unassignedVisits: unassigned,
    vehicles: vehicles.map((v) => {
      const fresh = vehicleGps(v);
      const presence = v.vin ? presenceByVin[v.vin] : null;
      return {
        name: v.name, status: fresh.status, speed: fresh.speed, lat: fresh.lat, lng: fresh.lng, updatedAt: fresh.updatedAt, source: fresh.source, stale: fresh.stale, ageMs: fresh.ageMs, iconColor: v.icon_color,
        arrivedAt: presence ? presence.arrivedAt : null,
        departedAt: presence ? presence.departedAt : null,
        presenceJobNumber: presence ? presence.jobNumber : null,
      };
    }),
    vehicleAssignments,
    coverageNote: 'Crew assignment and arrival windows are real, synced from Jobber. Vehicle positions are real, but check each vehicle\'s source/stale/updatedAt rather than assuming live: Jobber\'s own GPS feed has not advanced since 2026-07-28 on this account, so FleetSharp is carrying the fleet and a vehicle falling back to source=jobber is showing a long-stale position. ' + Object.keys(vehicleByUserId).length + ' techs company-wide currently have a truck assigned in Jobber -- any of them on today\'s schedule show their vehicle below; everyone else has no tech-to-vehicle assignment configured yet.',
  });
}

// ---------- Reina Lab read-only bridge (resource=reina_lab_read) ----------
// A broad but field-allowlisted server-to-server projection for the isolated
// Lab. It gives Reina useful read visibility across the business without
// exposing credentials, contact channels, banking/payroll data, raw notes, or
// any write operation. The dedicated token is unrelated to CRON_SECRET and
// Supabase service credentials and is compared in constant time.
function reinaLabTokenMatches(req) {
  const configured = String(process.env.REINA_LAB_READ_TOKEN || '');
  const supplied = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '').replace(/^Bearer\s+/i, '');
  if (!configured || !supplied) return false;
  const a = Buffer.from(configured), b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function handleReinaLabRead(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!reinaLabTokenMatches(req)) return res.status(401).json({ ok: false, error: 'Connector authentication required.' });

  // Preserve the already-reviewed narrow Lab connector unless the broader
  // business projection is enabled independently. A configured Lab token by
  // itself must never silently expand the data it can read after a deploy.
  if (process.env.REINA_LAB_FULL_READ_ENABLED !== 'true') {
    const [vehiclesRes, jobsRes, briefResult] = await Promise.all([
      supabaseRequest(`vehicles?select=name,${VEHICLE_GPS_COLUMNS}&order=name.asc`),
      supabaseRequest('jobs?select=job_number,title,job_status,start_at,end_at,jobber_updated_at&job_status=neq.archived&order=jobber_updated_at.desc&limit=100'),
      (async () => {
        let statusCode = 200;
        let payload = null;
        const capture = {
          status(code) { statusCode = code; return this; },
          json(body) { payload = body; return body; },
        };
        await handleFiDailyBrief(capture);
        if (statusCode !== 200 || !payload || payload.ok !== true) return null;
        return payload;
      })().catch(() => null),
    ]);
    if (!vehiclesRes.ok || !jobsRes.ok) return res.status(503).json({ ok: false, error: 'Verified HiveLogic source unavailable.' });
    const vehicles = (await vehiclesRes.json()).map((v) => {
      const g = vehicleGps(v);
      return {
        name: v.name,
        status: g.status,
        speed: g.speed,
        latitude: g.lat,
        longitude: g.lng,
        gpsUpdatedAt: g.updatedAt,
        // Reported, never assumed: one source means a silent outage has
        // nothing to hide behind, so the reader must be able to tell a live
        // truck from a parked history.
        gpsStale: g.stale,
        gpsSource: g.source,
      };
    });
    const jobs = (await jobsRes.json()).map((j) => ({
      jobNumber: j.job_number,
      title: j.title,
      status: j.job_status,
      startAt: j.start_at,
      endAt: j.end_at,
      updatedAt: j.jobber_updated_at,
    }));
    const todayDecisions = briefResult ? {
      available: true,
      headline: String(briefResult.headline || '').slice(0, 500),
      asOf: briefResult.asOf || null,
      source: String(briefResult.source || 'HiveLogic Daily Brief').slice(0, 160),
      decisions: (Array.isArray(briefResult.decisions) ? briefResult.decisions : []).slice(0, 20).map((decision) => ({
        type: String(decision.type || 'REVIEW').slice(0, 24),
        text: String(decision.text || '').slice(0, 1000),
        source: String(decision.source || 'HiveLogic').slice(0, 120),
        confidence: decision.confidence ? String(decision.confidence).slice(0, 500) : null,
      })),
    } : { available: false, reason: 'Today\'s Decisions are temporarily unavailable.' };
    return res.status(200).json({
      ok: true,
      source: 'HiveLogic read-only bridge',
      asOf: new Date().toISOString(),
      vehicles,
      jobs,
      todayDecisions,
    });
  }

  const text = (value, max = 500) => value == null ? null : String(value).slice(0, max);
  const number = (value) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  const requestedJobNumber = String((req.query && req.query.job_number) || '').trim();
  const requestedLookupKind = String((req.query && req.query.lookup_kind) || '').trim().toLowerCase();
  const requestedLookupTerm = String((req.query && req.query.lookup_term) || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (requestedJobNumber && !/^[a-z0-9-]{2,40}$/i.test(requestedJobNumber)) {
    return res.status(400).json({ ok: false, error: 'Invalid job number.' });
  }
  if (requestedLookupKind && !['client', 'invoice', 'estimate', 'job', 'vehicle'].includes(requestedLookupKind)) {
    return res.status(400).json({ ok: false, error: 'Invalid lookup kind.' });
  }
  if (requestedLookupTerm && (requestedLookupTerm.length < 2 || requestedLookupTerm.length > 120
    || !/^[\p{L}\p{N} '#&.\-]+$/u.test(requestedLookupTerm))) {
    return res.status(400).json({ ok: false, error: 'Invalid lookup term.' });
  }
  // visits.assigned_users is [{ id, name }] straight from Jobber.
  const assignedNames = (value) => {
    const rows = Array.isArray(value) ? value : [];
    const names = [];
    for (const entry of rows.slice(0, 12)) {
      const name = entry && typeof entry === 'object' ? text(entry.name, 160) : null;
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  };
  const jobProjection = (j) => ({
    jobNumber: j.job_number,
    title: j.title,
    status: j.job_status,
    type: j.job_type,
    total: number(j.total),
    clientName: text(j.client_name, 160),
    city: text(j.loc_city, 100),
    region: text(j.loc_province, 80),
    startAt: j.start_at,
    endAt: j.end_at,
    completedAt: j.completed_at,
    updatedAt: j.jobber_updated_at,
  });
  const readRows = async (path, project, limit) => {
    try {
      const response = await supabaseRequest(path);
      if (!response.ok) return { available: false, reason: 'Source temporarily unavailable.', records: [] };
      const rows = await response.json();
      if (!Array.isArray(rows)) return { available: false, reason: 'Source returned an invalid shape.', records: [] };
      return { available: true, recordLimit: limit, records: rows.slice(0, limit).map(project) };
    } catch (_) {
      return { available: false, reason: 'Source temporarily unavailable.', records: [] };
    }
  };
  const readExecutiveSnapshot = async () => {
    try {
      const response = await supabaseRequest('rpc/snapshot_aggregates', { method: 'POST', body: '{}' });
      if (!response.ok) return { available: false, reason: 'Executive snapshot temporarily unavailable.' };
      const payload = await response.json();
      const source = Array.isArray(payload) ? payload[0] : payload;
      if (!source || typeof source !== 'object') return { available: false, reason: 'Executive snapshot returned an invalid shape.' };
      return { available: true, snapshot: source };
    } catch (_) {
      return { available: false, reason: 'Executive snapshot temporarily unavailable.' };
    }
  };
  // What is actually owed.
  //
  // This used to filter on `balance > 0`, which returned NOTHING -- Jobber's
  // sync has never written that column, and all 2,852 invoices carry
  // balance = NULL. So Reina, asked who owed money, said nobody, while 27
  // invoices sat past due. A filter on a column nobody populates does not
  // fail; it quietly answers "none", which is the worst possible way for this
  // to be wrong.
  //
  // Status is what the sync does maintain, so status is what selects an
  // unpaid invoice, and the amount owed is derived from figures that are
  // actually there. Derived is stated as derived: `amountDueIsExact` is false
  // when it came from arithmetic rather than from Jobber's own balance, so an
  // invoice paid down in a way this cannot see is never reported as certain.
  // Estimates, with the LIVE ones first.
  //
  // Ordering the whole table by last-updated buried them: 730 archived and 666
  // converted quotes crowd out the ten still awaiting an answer, which are the
  // only ones anybody asks about. Reina had "access to estimates" and could
  // not have told you which were outstanding. Open ones are read on their own
  // and come first; recent activity follows as context.
  const OPEN_QUOTE_STATUSES = ['awaiting_response', 'draft', 'approved'];
  const QUOTE_COLUMNS = 'quote_number,title,quote_status,total,client_name,jobber_created_at,jobber_updated_at';
  const readEstimates = async () => {
    const project = (row) => ({
      quoteNumber: text(row.quote_number, 80), title: text(row.title, 240), status: text(row.quote_status, 40),
      total: number(row.total), clientName: text(row.client_name, 160),
      createdAt: row.jobber_created_at || null, updatedAt: row.jobber_updated_at || null,
    });
    try {
      const [openResponse, recentResponse] = await Promise.all([
        supabaseRequest(`quotes?select=${QUOTE_COLUMNS}&quote_status=in.(${OPEN_QUOTE_STATUSES.join(',')})&order=jobber_updated_at.desc.nullslast&limit=60`),
        supabaseRequest(`quotes?select=${QUOTE_COLUMNS}&quote_status=not.in.(${OPEN_QUOTE_STATUSES.join(',')})&order=jobber_updated_at.desc.nullslast&limit=60`),
      ]);
      if (!openResponse.ok && !recentResponse.ok) return { available: false, reason: 'Source temporarily unavailable.', records: [] };
      const openRows = openResponse.ok ? await openResponse.json() : [];
      const recentRows = recentResponse.ok ? await recentResponse.json() : [];
      const open = (Array.isArray(openRows) ? openRows : []).map(project);
      const recent = (Array.isArray(recentRows) ? recentRows : []).map(project);
      return { available: true, recordLimit: 120, openCount: open.length, records: [...open, ...recent] };
    } catch (_) {
      return { available: false, reason: 'Source temporarily unavailable.', records: [] };
    }
  };

  const RECEIVABLE_STATUSES = ['past_due', 'awaiting_payment', 'bad_debt', 'draft'];
  const readReceivables = async () => {
    try {
      const response = await supabaseRequest(`invoices?select=invoice_number,invoice_status,subject,total,balance,payments,deposit,discount,due_date,issued_date,job_id,client_id,jobber_updated_at&invoice_status=in.(${RECEIVABLE_STATUSES.join(',')})&order=due_date.asc.nullslast&limit=150`);
      if (!response.ok) return { available: false, reason: 'Source temporarily unavailable.', records: [] };
      const rows = await response.json();
      if (!Array.isArray(rows)) return { available: false, reason: 'Source returned an invalid shape.', records: [] };
      // "Who owes me money" is a question about PEOPLE. An invoice number
      // without a name attached cannot answer it.
      const clientIds = [...new Set(rows.map((row) => row.client_id).filter(Boolean))].slice(0, 150);
      const names = new Map();
      if (clientIds.length) {
        const list = clientIds.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',');
        const clientResponse = await supabaseRequest(`clients?select=jobber_id,name,company_name&jobber_id=in.(${encodeURIComponent(list)})&limit=150`);
        if (clientResponse.ok) {
          const clientRows = await clientResponse.json();
          for (const row of Array.isArray(clientRows) ? clientRows : []) {
            names.set(String(row.jobber_id), row.name || row.company_name || null);
          }
        }
      }
      const records = rows.slice(0, 150).map((row) => {
        // The same arithmetic the invoices screen and the client portal use,
        // from the same helper. Reina quoting a different number than the
        // screen shows would be worse than her not knowing.
        const owed = invoiceAmountDue(row);
        return {
          invoiceNumber: text(row.invoice_number, 80),
          status: text(row.invoice_status, 40),
          subject: text(row.subject, 240),
          clientName: text(names.get(String(row.client_id)), 160),
          total: number(row.total),
          amountDue: owed.amountDue,
          amountDueIsExact: owed.isExact,
          paid: number(row.payments),
          dueDate: row.due_date || null,
          issuedDate: row.issued_date || null,
          jobRef: text(row.job_id, 100),
          updatedAt: row.jobber_updated_at || null,
        };
      }).filter((record) => record.amountDue == null || record.amountDue > 0);
      return { available: true, recordLimit: 150, basis: 'unpaid_status', records };
    } catch (_) {
      return { available: false, reason: 'Source temporarily unavailable.', records: [] };
    }
  };

  // ---- the rest of the business ------------------------------------------
  // Added 2026-08-21 after Reina, reading the right calendar, had to say
  // "technician assignments aren't included". The pattern held everywhere: the
  // data existed and the bridge simply never asked. These are the remaining
  // tables with real rows in them that a person actually asks about. Tables
  // that are empty today are deliberately NOT here -- a query per turn for a
  // table with nothing in it is latency spent to learn nothing, and the turn
  // budget is the thing that broke tonight.
  const readPeople = async () => {
    const [rolesResult, tradesResult] = await Promise.all([
      readRows('employee_roles?select=jobber_id,lens,division,crew_label,is_lead,permission_role,updated_at&order=sort_order.asc&limit=80', (row) => ({
        personRef: text(row.jobber_id, 100), area: text(row.lens, 80), division: text(row.division, 120),
        crew: text(row.crew_label, 120), isLead: row.is_lead === true, role: text(row.permission_role, 60),
        updatedAt: row.updated_at || null,
      }), 80),
      readRows('trades?select=name,category,description,active,sort_order&active=is.true&order=sort_order.asc&limit=80', (row) => ({
        name: text(row.name, 120), category: text(row.category, 120), description: text(row.description, 300),
      }), 80),
    ]);
    return { available: rolesResult.available || tradesResult.available, crewRoles: rolesResult, trades: tradesResult };
  };

  const readTimeclock = async () => readRows(
    'workforce_time_sessions?select=employee_id,clock_in,clock_out,status,status_flag,on_break,total_break_seconds,close_reason&order=clock_in.desc&limit=80',
    (row) => ({
      personRef: text(row.employee_id, 100), clockIn: row.clock_in || null, clockOut: row.clock_out || null,
      status: text(row.status, 40), flag: text(row.status_flag, 60), onBreak: row.on_break === true,
      breakSeconds: number(row.total_break_seconds), closeReason: text(row.close_reason, 120),
    }), 80);

  const readTimesheets = async () => readRows(
    'time_sheet_entries?select=start_at,end_at,final_duration,user_id,job_id,jobber_updated_at&order=start_at.desc&limit=120',
    (row) => ({
      startAt: row.start_at || null, endAt: row.end_at || null, durationSeconds: number(row.final_duration),
      personRef: text(row.user_id, 100), jobRef: text(row.job_id, 100), updatedAt: row.jobber_updated_at || null,
    }), 120);

  const readActivity = async () => readRows(
    'timeline_events?select=job_id,label,source,occurred_at&order=occurred_at.desc&limit=120',
    (row) => ({
      jobRef: text(row.job_id, 100), label: text(row.label, 300), source: text(row.source, 80),
      occurredAt: row.occurred_at || null,
    }), 120);

  // Photo metadata only, and never gps_lat/gps_lng -- the same rule the
  // vehicle read follows. Where a photo was taken is a coordinate.
  const readPhotos = async () => readRows(
    'media?select=job_id,media_type,captured_at,uploaded_by,created_at&order=created_at.desc&limit=120',
    (row) => ({
      jobRef: text(row.job_id, 100), kind: text(row.media_type, 40),
      capturedAt: row.captured_at || null, addedAt: row.created_at || null,
    }), 120);

  const readCosting = async () => readRows(
    'cost_lines?select=section,name,amount,frequency,cost_type,source,confidence,archived,updated_at&archived=is.false&order=sort_order.asc&limit=150',
    (row) => ({
      section: text(row.section, 120), name: text(row.name, 200), amount: number(row.amount),
      frequency: text(row.frequency, 24), costType: text(row.cost_type, 40), source: text(row.source, 80),
      confidence: text(row.confidence, 40), updatedAt: row.updated_at || null,
    }), 150);

  // Summaries, never numbers and never the raw transcript. Who called is
  // contact data; what a call was about is a business fact, and only the
  // second one belongs in an answer.
  const readCalls = async () => {
    const [callsResult, voicemailResult] = await Promise.all([
      readRows('voice_calls?select=direction,status,client_id,job_id,started_at,ended_at,duration_seconds,ai_summary,escalation_requested&order=started_at.desc&limit=60', (row) => ({
        direction: text(row.direction, 24), status: text(row.status, 40), clientRef: text(row.client_id, 100),
        jobRef: text(row.job_id, 100), startedAt: row.started_at || null, endedAt: row.ended_at || null,
        seconds: number(row.duration_seconds), summary: text(row.ai_summary, 600),
        escalationRequested: row.escalation_requested === true,
      }), 60),
      readRows('voice_voicemails?select=duration_seconds,ai_summary,read,created_at&deleted_at=is.null&order=created_at.desc&limit=40', (row) => ({
        seconds: number(row.duration_seconds), summary: text(row.ai_summary, 600),
        heard: row.read === true, receivedAt: row.created_at || null,
      }), 40),
    ]);
    return { available: callsResult.available || voicemailResult.available, calls: callsResult, voicemail: voicemailResult };
  };

  // ---- everything about ONE job -------------------------------------------
  //
  // Asked "was the material ordered for this job", Reina said the material
  // status was not available. She was right -- and she had also looked at
  // nothing, because the areas she reads are business-wide lists, 150 rows
  // deep and one row per job. There was no way to go DOWN into a single job.
  //
  // When a question is about one job, this reads what is attached to it:
  // the visit and who is on it, what has happened, the photos, the money, the
  // hours, the change orders and the line items. Bounded per source, because
  // depth on one job must not cost what breadth across all of them does.
  //
  // An empty section here means NO RECORD EXISTS, which is a different and
  // more useful fact than "not read this turn" -- and it is the difference
  // between "nobody has logged materials for this job" and "I did not look".
  //
  // A job carries TWO identities. Everything synced from Jobber hangs off the
  // opaque Jobber id; the tables HiveLogic grew on its own (purchase orders
  // most recently) key on the row's own uuid. Resolve both here so a source
  // is never missed for having picked the wrong one -- "no purchase orders on
  // this job" has to mean there are none, not that we asked with the other id.
  const resolveJobId = async (jobNumber) => {
    if (!jobNumber) return null;
    try {
      const response = await supabaseRequest(`jobs?select=jobber_id,uuid_id&job_number=eq.${encodeURIComponent(jobNumber)}&limit=2`);
      if (!response.ok) return null;
      const rows = await response.json();
      // Exactly one, or nothing. A job number that is not unique cannot be
      // used to answer a question about "this job".
      if (!Array.isArray(rows) || rows.length !== 1) return null;
      const jobberId = rows[0].jobber_id || null;
      const uuidId = rows[0].uuid_id || null;
      return jobberId || uuidId ? { jobberId, uuidId } : null;
    } catch (_) { return null; }
  };

  // The Job Setup checklist, in the words it is written in on the screen.
  //
  // job_workflow.readiness_items stores only the boxes somebody has touched,
  // under keys like "permits.filed_approved". Handed over raw, that is both
  // unreadable and misleading: an untouched box is simply absent, so a job
  // where nothing has been checked looks the same as a job with no checklist.
  // Spelling out all twelve items, checked or not, is the difference between
  // "materials are not on site" and "nobody has said either way".
  //
  // Two items are not stored at all -- they are computed from the workflow
  // row, exactly as public/index.html computes them -- so what Reina says
  // matches what the setup screen shows.
  const READINESS_GATES = [
    { gate: 'Client confirmed', items: [
      ['client.start_date', 'Start date confirmed with client'],
      ['client.access', 'Access and parking arranged (gate codes, pets)'],
    ] },
    { gate: 'Deposit collected', items: [
      ['deposit.invoice_sent', 'Deposit invoice sent'],
      ['deposit.payment_received', 'Payment received and cleared', 'depositPaid'],
    ] },
    { gate: 'Materials and POs', items: [
      ['materials.on_site', 'Materials on site', 'materialsOnSite'],
    ] },
    { gate: 'Permits and documents', items: [
      ['permits.filed_approved', 'Permits filed and approved'],
      ['permits.plans_in_folder', 'Plans and specs in job folder'],
      ['permits.coi_current', 'COI current'],
    ] },
    { gate: 'Crew assigned', items: [
      ['crew.lead_helpers', 'Lead and helpers chained'],
      ['crew.sub_commitments', 'Sub commitments confirmed'],
    ] },
  ];

  const readinessChecklist = (workflowRow) => {
    const stored = workflowRow && workflowRow.readiness_items && typeof workflowRow.readiness_items === 'object'
      ? workflowRow.readiness_items : {};
    const computed = {
      depositPaid: !!(workflowRow && workflowRow.deposit_paid_at),
      materialsOnSite: !!(workflowRow && workflowRow.materials_status === 'on_site'),
    };
    const out = [];
    for (const { gate, items } of READINESS_GATES) {
      for (const [key, label, computedFrom] of items) {
        if (computedFrom) {
          out.push({ gate, item: label, done: computed[computedFrom] === true, checkedBy: null, checkedAt: null });
          continue;
        }
        const entry = stored[key] && typeof stored[key] === 'object' ? stored[key] : null;
        // Who ticked it is stored as their sign-in address. Who is the useful
        // part; the address is not, and this bridge does not hand out
        // addresses.
        const by = entry ? text(entry.by, 160) : null;
        out.push({
          gate, item: label,
          done: !!(entry && entry.done === true),
          checkedBy: by ? by.split('@')[0] : null,
          checkedAt: entry ? entry.at || null : null,
        });
      }
    }
    return out;
  };

  const readJobDossier = async (job, jobNumber) => {
    if (!job || (!job.jobberId && !job.uuidId)) return null;
    const id = encodeURIComponent(job.jobberId || job.uuidId);
    const poProjection = (row) => ({
      poNumber: text(row.po_number, 80), orderType: text(row.order_type, 60),
      status: text(row.lifecycle_status, 60), overheadCategory: text(row.overhead_category, 120),
      notPreapproved: row.not_preapproved === true, version: number(row.version),
      createdAt: row.created_at || null, updatedAt: row.updated_at || null,
    });
    const PO_SELECT = 'po_number,overhead_category,order_type,lifecycle_status,not_preapproved,version,created_at,updated_at';
    const NO_IDENTITY = { available: true, records: [] };
    const readPurchaseOrders = (column, value) => (value
      ? readRows(`purchase_orders?select=${PO_SELECT}&${column}=eq.${encodeURIComponent(value)}&order=updated_at.desc&limit=30`, poProjection, 30)
      : Promise.resolve(NO_IDENTITY));
    // Both identities were asked under; a purchase order carrying both must
    // not be reported twice, and one source failing must not be reported as
    // "no purchase orders".
    const mergePurchaseOrders = (a, b) => {
      if (a.available !== true && b.available !== true) {
        return { available: false, reason: a.reason || b.reason || 'Source temporarily unavailable.', records: [] };
      }
      const seen = new Set();
      const records = [];
      for (const record of [...(a.records || []), ...(b.records || [])]) {
        const key = record.poNumber || JSON.stringify(record);
        if (seen.has(key)) continue;
        seen.add(key);
        records.push(record);
      }
      return { available: true, recordLimit: 30, records: records.slice(0, 30) };
    };

    const [visits, timeline, photos, invoices, expenses, changeOrders, lineItems, workflow, hours,
      posByJobberId, posByUuid] = await Promise.all([
      readRows(`visits?select=title,start_at,end_at,completed_at,visit_status,assigned_users,arrival_window_start,arrival_window_end&job_id=eq.${id}&order=start_at.desc&limit=30`, (row) => ({
        title: text(row.title, 240), startAt: row.start_at || null, endAt: row.end_at || null,
        completedAt: row.completed_at || null, status: text(row.visit_status, 60),
        assignedTo: assignedNames(row.assigned_users),
        arrivalWindowStart: row.arrival_window_start || null, arrivalWindowEnd: row.arrival_window_end || null,
      }), 30),
      readRows(`timeline_events?select=label,source,occurred_at&job_id=eq.${id}&order=occurred_at.desc&limit=40`, (row) => ({
        label: text(row.label, 300), source: text(row.source, 80), occurredAt: row.occurred_at || null,
      }), 40),
      readRows(`media?select=media_type,captured_at,created_at&job_id=eq.${id}&order=created_at.desc&limit=30`, (row) => ({
        kind: text(row.media_type, 40), capturedAt: row.captured_at || null, addedAt: row.created_at || null,
      }), 30),
      readRows(`invoices?select=invoice_number,invoice_status,subject,total,balance,payments,deposit,discount,due_date,issued_date&job_id=eq.${id}&order=issued_date.desc&limit=20`, (row) => {
        const owed = invoiceAmountDue(row);
        return {
          invoiceNumber: text(row.invoice_number, 80), status: text(row.invoice_status, 40),
          subject: text(row.subject, 240), total: number(row.total),
          amountDue: owed.amountDue, amountDueIsExact: owed.isExact,
          dueDate: row.due_date || null, issuedDate: row.issued_date || null,
        };
      }, 20),
      readRows(`expenses?select=title,total,expense_date,reimbursable_to_user&job_id=eq.${id}&order=expense_date.desc&limit=30`, (row) => ({
        title: text(row.title, 240), total: number(row.total), date: row.expense_date || null,
        reimbursable: row.reimbursable_to_user === true,
      }), 30),
      readRows(`change_orders?select=co_number,kind,lifecycle_status,version,created_at,updated_at&job_id=eq.${id}&order=updated_at.desc&limit=20`, (row) => ({
        changeOrderNumber: text(row.co_number, 80), kind: text(row.kind, 60),
        status: text(row.lifecycle_status, 60), version: number(row.version),
        createdAt: row.created_at || null, updatedAt: row.updated_at || null,
      }), 20),
      readRows(`job_line_items?select=description,quantity,unit_price,line_total,sort_order&job_ref=eq.${id}&order=sort_order.asc&limit=60`, (row) => ({
        description: text(row.description, 300), quantity: number(row.quantity),
        unitPrice: number(row.unit_price), lineTotal: number(row.line_total),
      }), 60),
      readRows(`job_workflow?select=materials_status,materials_eta,deposit_required,deposit_paid_at,deposit_amount,on_hold_at,on_hold_reason,readiness_items,updated_at&job_ref=eq.${id}&limit=5`, (row) => ({
        materialsStatus: text(row.materials_status, 40), materialsEta: row.materials_eta || null,
        depositRequired: number(row.deposit_required), depositPaidAt: row.deposit_paid_at || null,
        depositAmount: number(row.deposit_amount), onHoldAt: row.on_hold_at || null,
        onHoldReason: text(row.on_hold_reason, 300),
        setupChecklist: readinessChecklist(row),
        updatedAt: row.updated_at || null,
      }), 5),
      readRows(`time_sheet_entries?select=start_at,end_at,final_duration,user_id&job_id=eq.${id}&order=start_at.desc&limit=60`, (row) => ({
        startAt: row.start_at || null, endAt: row.end_at || null,
        durationSeconds: number(row.final_duration), personRef: text(row.user_id, 100),
      }), 60),
      // Asked as two queries rather than one `or=`, because a Jobber id is
      // base64 -- padding and all -- and PostgREST's or() list is the wrong
      // place to find out how that quotes.
      readPurchaseOrders('job_id', job.jobberId),
      readPurchaseOrders('job_uuid', job.uuidId),
    ]);
    return {
      available: true,
      jobNumber: jobNumber == null ? null : String(jobNumber).slice(0, 40),
      // Said in words, because "the section is empty" and "the section was not
      // read" look identical in JSON and mean opposite things.
      note: 'Everything HiveLogic has attached to this one job. A section with no records means nothing has been recorded against this job, not that it was not read. workflow.setupChecklist is the Job Setup checklist in full -- every item is listed whether or not anyone has ticked it, so an item marked done:false means it has not been confirmed, and "Materials on site" reflects the materials status staff set on the job.',
      visits, timeline, photos, invoices, expenses, changeOrders, lineItems, workflow, hours,
      purchaseOrders: mergePurchaseOrders(posByJobberId, posByUuid),
    };
  };

  const exactLookup = async () => {
    if (!requestedLookupKind || !requestedLookupTerm) return null;
    const pattern = encodeURIComponent(`*${requestedLookupTerm}*`);
    const result = (records, reason = 'No matching record was found.') => ({
      available: records.length > 0,
      kind: requestedLookupKind,
      term: requestedLookupTerm,
      records: records.slice(0, 12),
      ...(records.length ? {} : { reason }),
    });
    try {
      if (requestedLookupKind === 'job') {
        const numeric = /^#?[a-z0-9-]{2,40}$/i.test(requestedLookupTerm);
        const filter = numeric
          ? `job_number=eq.${encodeURIComponent(requestedLookupTerm.replace(/^#/, ''))}`
          : `or=(job_number.ilike.${pattern},title.ilike.${pattern},client_name.ilike.${pattern})`;
        const response = await supabaseRequest(`jobs_enriched?select=job_number,title,job_status,job_type,total,start_at,end_at,completed_at,jobber_updated_at,client_name,loc_city,loc_province&${filter}&order=jobber_updated_at.desc.nullslast&limit=12`);
        if (!response.ok) return result([], 'Job lookup temporarily unavailable.');
        const rows = await response.json();
        return result(Array.isArray(rows) ? rows.map(jobProjection) : [], 'Job not found.');
      }
      if (requestedLookupKind === 'estimate') {
        const response = await supabaseRequest(`quotes?select=jobber_id,quote_number,title,quote_status,total,client_name,jobber_created_at,jobber_updated_at&or=(quote_number.ilike.${pattern},title.ilike.${pattern},client_name.ilike.${pattern})&order=jobber_updated_at.desc.nullslast&limit=12`);
        if (!response.ok) return result([], 'Estimate lookup temporarily unavailable.');
        const rows = await response.json();
        return result(Array.isArray(rows) ? rows.map((row) => ({
          estimateRef: text(row.jobber_id, 100), estimateNumber: text(row.quote_number, 80), title: text(row.title, 240),
          status: text(row.quote_status, 40), total: number(row.total), clientName: text(row.client_name, 160),
          createdAt: row.jobber_created_at || null, updatedAt: row.jobber_updated_at || null,
        })) : [], 'Estimate not found.');
      }
      if (requestedLookupKind === 'client' || requestedLookupKind === 'invoice') {
        const clientResponse = await supabaseRequest(`clients?select=jobber_id,name,company_name,is_lead,is_archived,jobber_updated_at&or=(name.ilike.${pattern},company_name.ilike.${pattern})&order=jobber_updated_at.desc.nullslast&limit=8`);
        const clientRows = clientResponse.ok ? await clientResponse.json() : [];
        const clients = Array.isArray(clientRows) ? clientRows : [];
        if (requestedLookupKind === 'client') return result(clients.map((row) => ({
          clientRef: text(row.jobber_id, 100), name: text(row.name, 160), companyName: text(row.company_name, 160),
          isLead: row.is_lead === true, isArchived: row.is_archived === true, updatedAt: row.jobber_updated_at || null,
        })), clientResponse.ok ? 'Client not found.' : 'Client lookup temporarily unavailable.');

        const directResponse = await supabaseRequest(`invoices?select=jobber_id,client_id,invoice_number,invoice_status,subject,total,balance,due_date,issued_date,job_id,jobber_updated_at&or=(invoice_number.ilike.${pattern},subject.ilike.${pattern})&order=jobber_updated_at.desc.nullslast&limit=12`);
        const directRows = directResponse.ok ? await directResponse.json() : [];
        const byClient = await Promise.all(clients.slice(0, 5).map(async (client) => {
          const response = await supabaseRequest(`invoices?select=jobber_id,client_id,invoice_number,invoice_status,subject,total,balance,due_date,issued_date,job_id,jobber_updated_at&client_id=eq.${encodeURIComponent(client.jobber_id)}&order=jobber_updated_at.desc.nullslast&limit=12`);
          const rows = response.ok ? await response.json() : [];
          return (Array.isArray(rows) ? rows : []).map((row) => ({ ...row, client_name: client.name || client.company_name || null }));
        }));
        const clientNameById = new Map(clients.map((client) => [String(client.jobber_id), client.name || client.company_name || null]));
        const combined = [...(Array.isArray(directRows) ? directRows : []), ...byClient.flat()];
        const seen = new Set();
        return result(combined.filter((row) => row && row.jobber_id && !seen.has(row.jobber_id) && seen.add(row.jobber_id)).map((row) => ({
          invoiceRef: text(row.jobber_id, 100), invoiceNumber: text(row.invoice_number, 80), status: text(row.invoice_status, 40),
          subject: text(row.subject, 240), total: number(row.total), balance: number(row.balance), dueDate: row.due_date || null,
          issuedDate: row.issued_date || null, jobRef: text(row.job_id, 100),
          clientName: text(row.client_name || clientNameById.get(String(row.client_id)), 160), updatedAt: row.jobber_updated_at || null,
        })), directResponse.ok && clientResponse.ok ? 'Invoice not found for that client or number.' : 'Invoice lookup temporarily unavailable.');
      }
      if (requestedLookupKind === 'vehicle') {
        const aliases = { 'dump truck': '2014 RAM 5500', dumptruck: '2014 RAM 5500' };
        const alias = aliases[requestedLookupTerm.toLowerCase().replace(/[^a-z0-9 ]/g, '')] || null;
        const vehiclePattern = encodeURIComponent(`*${alias || requestedLookupTerm}*`);
        const response = await supabaseRequest(`vehicles?select=name,make,model,year,${VEHICLE_GPS_COLUMNS}&name=ilike.${vehiclePattern}&order=name.asc&limit=12`);
        if (!response.ok) return result([], 'Vehicle lookup temporarily unavailable.');
        const rows = await response.json();
        const safeRows = [];
        for (const row of Array.isArray(rows) ? rows : []) {
          let locationLabel = null;
          let address = null;
          let locationSource = null;
          const g = vehicleGps(row);
          const lat = Number(g.lat);
          const lng = Number(g.lng);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            // Translate sensitive raw GPS into a useful server-owned place
            // label. Coordinates never leave this function or reach Reina.
            const latitudeWindow = 0.015;
            const longitudeWindow = 0.02;
            const [locationsResponse, officeResponse] = await Promise.all([
              supabaseRequest(`client_locations?select=jobber_id,street,city,lat,lng&lat=gte.${encodeURIComponent(lat - latitudeWindow)}&lat=lte.${encodeURIComponent(lat + latitudeWindow)}&lng=gte.${encodeURIComponent(lng - longitudeWindow)}&lng=lte.${encodeURIComponent(lng + longitudeWindow)}&limit=40`),
              supabaseRequest('office_location?id=eq.hq&select=address,lat,lng&limit=1'),
            ]);
            const locations = locationsResponse.ok ? await locationsResponse.json() : [];
            const officeRows = officeResponse.ok ? await officeResponse.json() : [];
            const nearby = (Array.isArray(locations) ? locations : [])
              .filter((place) => Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng)))
              .map((place) => ({ place, miles: haversineMiles(lat, lng, Number(place.lat), Number(place.lng)) }))
              .sort((a, b) => a.miles - b.miles)[0] || null;
            const office = Array.isArray(officeRows) ? officeRows[0] : null;
            const officeMiles = office && Number.isFinite(Number(office.lat)) && Number.isFinite(Number(office.lng))
              ? haversineMiles(lat, lng, Number(office.lat), Number(office.lng)) : null;
            if (nearby && nearby.miles <= TECH_LIVE_ARRIVED_RADIUS_MI
              && (officeMiles == null || nearby.miles <= officeMiles)) {
              const clientResponse = await supabaseRequest(`clients?jobber_id=eq.${encodeURIComponent(nearby.place.jobber_id)}&select=name,company_name&limit=1`);
              const clients = clientResponse.ok ? await clientResponse.json() : [];
              const client = Array.isArray(clients) ? clients[0] : null;
              address = [text(nearby.place.street, 160), text(nearby.place.city, 100)].filter(Boolean).join(', ') || null;
              locationLabel = text(client?.name || client?.company_name, 160) || address;
              locationSource = locationLabel ? 'matched_client_address' : null;
            } else if (officeMiles != null && officeMiles <= TECH_LIVE_ARRIVED_RADIUS_MI) {
              locationLabel = 'the shop';
              address = text(office.address, 240);
              locationSource = 'matched_office_address';
            }
          }
          safeRows.push({
            name: text(row.name, 160), make: text(row.make, 80), model: text(row.model, 80), year: number(row.year),
            status: text(g.status, 80), speed: number(g.speed), updatedAt: g.updatedAt || null, stale: g.stale, source: g.source,
            matchedAlias: alias ? requestedLookupTerm : null,
            locationLabel, address, locationSource,
          });
        }
        return result(safeRows, 'Vehicle not found.');
      }
    } catch (_) {
      return result([], 'Exact lookup temporarily unavailable.');
    }
    return result([]);
  };

  // WHICH AREAS THIS TURN NEEDS.
  //
  // Every area used to be read on every turn. That was survivable with six of
  // them and it is not with twenty: the full read is what pushed the composer
  // past its budget tonight and made Reina answer "unavailable" to everything.
  // The caller says what the question is about, and only those are fetched.
  //
  // No `areas` parameter means all of them, so every existing caller behaves
  // exactly as before. An unknown name is ignored rather than rejected -- a
  // stale caller asking for something that no longer exists should get a
  // smaller answer, not an error.
  const requestedAreas = String((req.query && req.query.areas) || '').split(',')
    .map((name) => name.trim()).filter(Boolean);
  const wants = (name) => requestedAreas.length === 0 || requestedAreas.includes(name);
  const skipped = { available: false, reason: 'Not read for this turn. Ask about it directly.', records: [] };
  const when = (name, read) => wants(name) ? read() : Promise.resolve(skipped);

  const [vehiclesRes, jobsRes, jobLookupRes, briefResult, clients, executive, receivables, estimates, workflow,
    schedule, leads, requests, expenses, vendors, subscriptions, subcontractors,
    purchaseOrders, internalEstimates, syncHealth, mail,
    people, timeclock, timesheets, activity, photos, costing, calls,
    exactLookupResult] = await Promise.all([
    supabaseRequest(`vehicles?select=name,${VEHICLE_GPS_COLUMNS}&order=name.asc`),
    supabaseRequest('jobs_enriched?select=job_number,title,job_status,job_type,total,start_at,end_at,completed_at,jobber_updated_at,client_name,loc_city,loc_province&job_status=neq.archived&order=jobber_updated_at.desc&limit=150'),
    requestedJobNumber
      ? supabaseRequest(`jobs_enriched?select=job_number,title,job_status,job_type,total,start_at,end_at,completed_at,jobber_updated_at,client_name,loc_city,loc_province&job_number=eq.${encodeURIComponent(requestedJobNumber)}&limit=2`)
      : Promise.resolve(null),
    (async () => {
      let statusCode = 200;
      let payload = null;
      const capture = {
        status(code) { statusCode = code; return this; },
        json(body) { payload = body; return body; },
      };
      await handleFiDailyBrief(capture);
      if (statusCode !== 200 || !payload || payload.ok !== true) return null;
      return payload;
    })().catch(() => null),
    when('clients', () => readRows('clients?select=jobber_id,name,company_name,is_lead,is_archived,jobber_created_at,jobber_updated_at&order=jobber_updated_at.desc&limit=200', (row) => ({
      clientRef: text(row.jobber_id, 100), name: text(row.name, 160), companyName: text(row.company_name, 160),
      isLead: row.is_lead === true, isArchived: row.is_archived === true,
      createdAt: row.jobber_created_at || null, updatedAt: row.jobber_updated_at || null,
    }), 200)),
    when('executive', readExecutiveSnapshot),
    when('receivables', () => readReceivables()),
    when('estimates', () => readEstimates()),
    when('workflow', () => readRows('job_workflow?select=job_ref,deposit_required,deposit_paid_at,deposit_amount,setup_complete_at,materials_status,materials_eta,on_hold_at,on_hold_reason,readiness_items,readiness_override_at,is_tm,tm_service_type,tm_rate_hourly,updated_at&order=updated_at.desc&limit=150', (row) => ({
      jobRef: text(row.job_ref, 100), depositRequired: number(row.deposit_required), depositPaidAt: row.deposit_paid_at || null,
      depositAmount: number(row.deposit_amount), setupCompleteAt: row.setup_complete_at || null, materialsStatus: text(row.materials_status, 40),
      materialsEta: row.materials_eta || null, onHoldAt: row.on_hold_at || null, onHoldReason: text(row.on_hold_reason, 300),
      readiness: row.readiness_items && typeof row.readiness_items === 'object' ? row.readiness_items : {},
      readinessOverrideAt: row.readiness_override_at || null, isTimeAndMaterials: row.is_tm === true,
      serviceType: text(row.tm_service_type, 120), hourlyRate: number(row.tm_rate_hourly), updatedAt: row.updated_at || null,
    }), 150)),
    // assigned_users is why she had to say "technician assignments aren't
    // included, so I can't confirm coverage" while reading the right calendar.
    // The column was there and synced; the projection just never selected it.
    when('schedule', () => readRows('visits?select=title,start_at,end_at,completed_at,is_all_day,job_id,arrival_window_start,arrival_window_end,visit_status,assigned_users,jobber_updated_at&order=start_at.desc&limit=150', (row) => ({
      title: text(row.title, 240), startAt: row.start_at || null, endAt: row.end_at || null, completedAt: row.completed_at || null,
      isAllDay: row.is_all_day === true, jobRef: text(row.job_id, 100), arrivalWindowStart: row.arrival_window_start || null,
      arrivalWindowEnd: row.arrival_window_end || null, status: text(row.visit_status, 60),
      // Names only. The Jobber user id behind each one is an identifier for
      // systems, not an answer to "who is on this job".
      assignedTo: assignedNames(row.assigned_users),
      updatedAt: row.jobber_updated_at || null,
    }), 150)),
    when('leads', () => readRows('lead_pipeline?select=id,stage,estimated_value,lead_source,division,need,urgency,lost_reason,first_contacted_at,last_contacted_at,created_at,updated_at&order=updated_at.desc&limit=100', (row) => ({
      leadRef: text(row.id, 80), stage: text(row.stage, 40), estimatedValue: number(row.estimated_value), source: text(row.lead_source, 120),
      division: text(row.division, 120), need: text(row.need, 300), urgency: text(row.urgency, 80), lostReason: text(row.lost_reason, 240),
      firstContactedAt: row.first_contacted_at || null, lastContactedAt: row.last_contacted_at || null,
      createdAt: row.created_at || null, updatedAt: row.updated_at || null,
    }), 100)),
    when('requests', () => readRows('requests?select=title,request_status,jobber_created_at,jobber_updated_at&order=jobber_updated_at.desc&limit=100', (row) => ({
      title: text(row.title, 240), status: text(row.request_status, 60), createdAt: row.jobber_created_at || null, updatedAt: row.jobber_updated_at || null,
    }), 100)),
    when('expenses', () => readRows('expenses?select=title,total,expense_date,reimbursable_to_user,job_id,jobber_updated_at&order=expense_date.desc&limit=100', (row) => ({
      title: text(row.title, 240), total: number(row.total), date: row.expense_date || null,
      reimbursable: row.reimbursable_to_user === true, jobRef: text(row.job_id, 100), updatedAt: row.jobber_updated_at || null,
    }), 100)),
    when('vendors', () => readRows('vendors?select=name,category,subcategory,what_they_provide,relationship_owner,status,updated_at&order=name.asc&limit=150', (row) => ({
      name: text(row.name, 160), category: text(row.category, 80), subcategory: text(row.subcategory, 120),
      provides: text(row.what_they_provide, 300), owner: text(row.relationship_owner, 160), status: text(row.status, 40), updatedAt: row.updated_at || null,
    }), 150)),
    when('subscriptions', () => readRows('subscriptions?select=name,category,what_it_does,relationship_owner,monthly_cost,cost_source,billing_cycle,renewal_date,status,updated_at&order=name.asc&limit=150', (row) => ({
      name: text(row.name, 160), category: text(row.category, 80), purpose: text(row.what_it_does, 300), owner: text(row.relationship_owner, 160),
      monthlyCost: number(row.monthly_cost), costSource: text(row.cost_source, 40), billingCycle: text(row.billing_cycle, 40),
      renewalDate: row.renewal_date || null, status: text(row.status, 40), updatedAt: row.updated_at || null,
    }), 150)),
    when('subcontractors', () => readRows('subcontractors?select=name,trade,status,track_1099,w9_on_file,updated_at&order=name.asc&limit=150', (row) => ({
      name: text(row.name, 160), trade: text(row.trade, 120), status: text(row.status, 40),
      tracks1099: row.track_1099 === true, w9OnFile: row.w9_on_file === true, updatedAt: row.updated_at || null,
    }), 150)),
    when('purchaseOrders', () => readRows('purchase_orders?select=po_number,job_id,overhead_category,order_type,lifecycle_status,not_preapproved,version,created_at,updated_at&order=updated_at.desc&limit=100', (row) => ({
      poNumber: text(row.po_number, 80), jobRef: text(row.job_id, 100), overheadCategory: text(row.overhead_category, 120),
      orderType: text(row.order_type, 60), status: text(row.lifecycle_status, 60), notPreapproved: row.not_preapproved === true,
      version: number(row.version), createdAt: row.created_at || null, updatedAt: row.updated_at || null,
    }), 100)),
    when('internalEstimates', () => readRows('estimates?select=estimate_number,client_id,lifecycle_status,version,created_at,updated_at&order=updated_at.desc&limit=100', (row) => ({
      estimateNumber: text(row.estimate_number, 80), clientRef: text(row.client_id, 100), status: text(row.lifecycle_status, 60),
      version: number(row.version), createdAt: row.created_at || null, updatedAt: row.updated_at || null,
    }), 100)),
    when('syncHealth', () => readRows('sync_log?select=ran_at,status,clients_synced,jobs_synced,invoices_synced&order=ran_at.desc&limit=20', (row) => ({
      ranAt: row.ran_at || null, status: text(row.status, 40), clientsSynced: number(row.clients_synced),
      jobsSynced: number(row.jobs_synced), invoicesSynced: number(row.invoices_synced),
    }), 20)),
    // Mail Reina has already triaged: who it was from, what it was about, and
    // what she thought should happen. Deliberately NOT the message body -- the
    // triage summary is what makes an inbox answerable out loud, and a raw
    // inbox in a prompt is a different decision than this one. The sender's
    // address is reduced to its domain: enough to tell a supplier from a
    // customer, without putting private contact details in a model prompt.
    when('mail', () => readRows('reina_mail_triage?select=subject,from_name,from_address,received_at,label,corrected_label,confidence,summary_text,action_text,acted_action,acted_at&order=received_at.desc&limit=120', (row) => ({
      subject: text(row.subject, 240),
      fromName: text(row.from_name, 160),
      fromDomain: text(String(row.from_address || '').split('@')[1] || null, 120),
      receivedAt: row.received_at || null,
      label: text(row.corrected_label || row.label, 40),
      confidence: number(row.confidence),
      summary: text(row.summary_text, 600),
      suggestedAction: text(row.action_text, 400),
      actedAction: text(row.acted_action, 60),
      actedAt: row.acted_at || null,
    }), 120)),
    when('people', readPeople),
    when('timeclock', readTimeclock),
    when('timesheets', readTimesheets),
    when('activity', readActivity),
    when('photos', readPhotos),
    when('costing', readCosting),
    when('calls', readCalls),
    exactLookup(),
  ]);
  if (!vehiclesRes.ok || !jobsRes.ok) return res.status(503).json({ ok: false, error: 'Verified HiveLogic source unavailable.' });
  const vehicles = (await vehiclesRes.json()).map((v) => {
    const g = vehicleGps(v);
    return {
      name: v.name,
      status: g.status,
      speed: g.speed,
      latitude: g.lat,
      longitude: g.lng,
      gpsUpdatedAt: g.updatedAt,
      gpsStale: g.stale,
      gpsSource: g.source,
    };
  });
  const jobs = (await jobsRes.json()).map(jobProjection);
  let jobLookup = null;
  if (requestedJobNumber) {
    if (!jobLookupRes || !jobLookupRes.ok) {
      jobLookup = { available: false, jobNumber: requestedJobNumber, reason: 'Job lookup temporarily unavailable.' };
    } else {
      const matches = await jobLookupRes.json();
      jobLookup = Array.isArray(matches) && matches.length === 1
        ? { available: true, jobNumber: requestedJobNumber, record: jobProjection(matches[0]) }
        : { available: false, jobNumber: requestedJobNumber, reason: Array.isArray(matches) && matches.length > 1 ? 'Job number is not unique.' : 'Job not found.' };
    }
  }
  const todayDecisions = briefResult ? {
    available: true,
    headline: String(briefResult.headline || '').slice(0, 500),
    asOf: briefResult.asOf || null,
    source: String(briefResult.source || 'HiveLogic Daily Brief').slice(0, 160),
    decisions: (Array.isArray(briefResult.decisions) ? briefResult.decisions : []).slice(0, 20).map((decision) => ({
      type: String(decision.type || 'REVIEW').slice(0, 24),
      text: String(decision.text || '').slice(0, 1000),
      source: String(decision.source || 'HiveLogic').slice(0, 120),
      confidence: decision.confidence ? String(decision.confidence).slice(0, 500) : null,
    })),
  } : { available: false, reason: 'Today\'s Decisions are temporarily unavailable.' };

  // A question about ONE job gets that job in depth. The id comes from
  // whichever identification actually succeeded -- an explicit job number, or
  // a single unambiguous match from the exact lookup.
  let dossierJobNumber = null;
  if (requestedJobNumber && jobLookup && jobLookup.available === true) {
    dossierJobNumber = requestedJobNumber;
  } else if (exactLookupResult && exactLookupResult.kind === 'job'
    && exactLookupResult.available === true && exactLookupResult.records.length === 1) {
    dossierJobNumber = exactLookupResult.records[0].jobNumber || null;
  }
  // The projections deliberately do not carry Jobber's opaque id -- it is an
  // identifier for systems, not an answer -- so resolve it here, once, and
  // only when a dossier is actually being built.
  const jobDossier = await readJobDossier(await resolveJobId(dossierJobNumber), dossierJobNumber);

  return res.status(200).json({
    ok: true,
    source: 'HiveLogic read-only bridge',
    asOf: new Date().toISOString(),
    access: {
      mode: 'full_business_read',
      readOnly: true,
      businessAreas: ['executive', 'clients', 'jobs', 'schedule', 'receivables', 'estimates', 'sales', 'requests', 'expenses', 'vendors', 'subscriptions', 'subcontractors', 'purchasing', 'fleet', 'mail', 'people', 'timeclock', 'timesheets', 'activity', 'photos', 'costing', 'calls', 'today_decisions', 'sync_health'],
      areasReadThisTurn: requestedAreas.length ? requestedAreas : 'all',
      excluded: ['credentials', 'tokens', 'bank accounts', 'payment card data', 'payroll', 'tax identifiers', 'private contact details', 'mail message bodies', 'raw notes', 'write operations'],
    },
    vehicles,
    jobs,
    jobLookup,
    jobDossier,
    exactLookup: exactLookupResult,
    todayDecisions,
    business: {
      clients, executive, receivables, estimates, workflow, schedule, leads, requests, expenses,
      vendors, subscriptions, subcontractors, purchaseOrders, internalEstimates, syncHealth, mail,
      people, timeclock, timesheets, activity, photos, costing, calls,
    },
  });
}

// ---------- Live tech-header status (resource=tech_live_status) ----------
// 2026-07-26: "Dispatch tab polish" item 4/4 -- on-site/en-route/available
// status per tech column. Decision (Chris, 2026-07-26): build this on real
// vehicle GPS + geocoded client addresses, NOT the Field App's "ON MY WAY"/
// "arrived" check-in buttons -- those are wired up (api/fieldops.js,
// travel_sessions/job_time_entries tables) but almost entirely unused in
// practice (checked live data: 2-3 rows total, all Chris's own testing, days
// old). Vehicle GPS updates every few minutes for every tech with a truck
// assigned in Jobber (confirmed live) and needs no behavior change from the
// crew, so it's the only source that's actually real *today*. If Field App
// adoption ever takes off, layer that in as a second, higher-confidence
// signal -- don't rip this out, it's the fallback for anyone without GPS.
//
// Method: straight-line (haversine) distance from the tech's assigned
// vehicle to (a) the client address of whichever visit is scheduled right
// now, or the next one if none is active, and (b) the office. Moving fast
// enough to be driving beats being near a location; parked at the current
// job's address wins over parked at the shop. A tech with no vehicle
// assigned gets vehicleTracked:false and no live label -- the frontend
// keeps showing the existing schedule-based "N jobs today" text for them
// rather than fabricating a status with no signal behind it.
const TECH_LIVE_MOVING_MPH = 5;
const TECH_LIVE_ARRIVED_RADIUS_MI = 0.3;
const TECH_LIVE_GPS_STALE_MIN = 20;

function techLiveTimeLabel(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  } catch (e) {
    return '';
  }
}

async function handleTechLiveStatus(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) {
    return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  }

  const { dateStr, startISO, endISO, nowMs } = todayRangeET();

  const [vehiclesRes, usersVehicleRes, visitsRaw] = await Promise.all([
    supabaseRequest(`vehicles?select=jobber_id,name,${VEHICLE_GPS_COLUMNS}`),
    supabaseRequest('users?assigned_vehicle_id=not.is.null&select=jobber_id,name,assigned_vehicle_id,assigned_vehicle_name'),
    fiFetchAllRows(
      'visits',
      '?select=jobber_id,title,start_at,end_at,assigned_users,client_id' +
        '&end_at=gte.' + encodeURIComponent(startISO) +
        '&start_at=lte.' + encodeURIComponent(endISO)
    ),
  ]);
  const vehicles = vehiclesRes.ok ? await vehiclesRes.json() : [];
  const usersVehicleRows = usersVehicleRes.ok ? await usersVehicleRes.json() : [];
  const vehiclesByName = Object.fromEntries(vehicles.map((v) => [v.name, v]));

  const clientIds = [...new Set(visitsRaw.map((v) => v.client_id).filter(Boolean))];
  let clientsById = {};
  if (clientIds.length) {
    const r = await supabaseRequest('clients?jobber_id=in.(' + clientIds.join(',') + ')&select=jobber_id,name');
    const list = r.ok ? await r.json() : [];
    clientsById = Object.fromEntries(list.map((c) => [c.jobber_id, c.name]));
  }
  let locsById = {};
  if (clientIds.length) {
    const r = await supabaseRequest('client_locations?jobber_id=in.(' + clientIds.join(',') + ')&select=jobber_id,lat,lng');
    const list = r.ok ? await r.json() : [];
    locsById = Object.fromEntries(list.map((l) => [l.jobber_id, l]));
  }
  const officeRes = await supabaseRequest('office_location?id=eq.hq&select=lat,lng');
  const officeRows = officeRes.ok ? await officeRes.json() : [];
  const office = officeRows[0] || null;

  const clientLabel = (v) => (v && v.client_id && clientsById[v.client_id]) || (v && v.title) || 'client';

  const techs = usersVehicleRows.map((u) => {
    const vehicle = vehiclesByName[u.assigned_vehicle_name];
    const base = { jobberId: u.jobber_id, techName: u.name, vehicleTracked: !!vehicle, vehicleName: u.assigned_vehicle_name || null };
    if (!vehicle) {
      return { ...base, state: 'no_vehicle', label: null, color: null, speedMph: null, gpsUpdatedAt: null, gpsStale: true, distanceToClientMiles: null, distanceToOfficeMiles: null };
    }

    const g = vehicleGps(vehicle, nowMs);
    const gpsUpdatedAt = g.updatedAt || null;
    const gpsAgeMin = gpsUpdatedAt ? (nowMs - new Date(gpsUpdatedAt).getTime()) / 60000 : null;
    const gpsStale = gpsAgeMin == null || gpsAgeMin > TECH_LIVE_GPS_STALE_MIN;
    const speedMph = Number(g.speed) || 0;
    const hasFix = g.lat != null && g.lng != null;

    const techVisits = visitsRaw
      .filter((v) => Array.isArray(v.assigned_users) && v.assigned_users.some((au) => au.id === u.jobber_id))
      .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
    const currentVisit = techVisits.find((v) => {
      const s = new Date(v.start_at).getTime(), e = new Date(v.end_at).getTime();
      return nowMs >= s && nowMs <= e;
    }) || null;
    const nextVisit = techVisits.find((v) => new Date(v.start_at).getTime() > nowMs) || null;

    const distTo = (visit) => {
      if (!visit || !hasFix) return null;
      const loc = visit.client_id && locsById[visit.client_id];
      if (!loc || loc.lat == null || loc.lng == null) return null;
      return haversineMiles(Number(g.lat), Number(g.lng), Number(loc.lat), Number(loc.lng));
    };
    const distanceToClientMi = distTo(currentVisit) ?? distTo(nextVisit);
    const distanceToOfficeMi = (hasFix && office && office.lat != null)
      ? haversineMiles(Number(g.lat), Number(g.lng), Number(office.lat), Number(office.lng))
      : null;

    let state, label, color;
    if (gpsStale) {
      state = 'unknown'; label = 'GPS signal stale'; color = '#8b92a8';
    } else if (speedMph >= TECH_LIVE_MOVING_MPH) {
      const dest = currentVisit || nextVisit;
      state = 'en_route';
      label = dest ? ('En route to ' + clientLabel(dest)) : 'Driving';
      color = '#3E7BDD';
    } else if (currentVisit && distTo(currentVisit) != null && distTo(currentVisit) <= TECH_LIVE_ARRIVED_RADIUS_MI) {
      state = 'on_site'; label = 'On site — ' + clientLabel(currentVisit); color = '#1B7A50';
    } else if (distanceToOfficeMi != null && distanceToOfficeMi <= TECH_LIVE_ARRIVED_RADIUS_MI) {
      state = 'at_shop'; label = 'At the shop'; color = '#8b92a8';
    } else if (currentVisit) {
      state = 'near_job'; label = 'Stopped near ' + clientLabel(currentVisit); color = '#E0912E';
    } else if (nextVisit) {
      state = 'between_visits'; label = 'Between visits — next at ' + techLiveTimeLabel(nextVisit.start_at); color = '#8b92a8';
    } else {
      state = techVisits.length ? 'idle' : 'no_visits';
      label = techVisits.length ? (techVisits.length + ' visit' + (techVisits.length > 1 ? 's' : '') + ' today') : 'No visits today';
      color = '#8b92a8';
    }

    return {
      ...base, state, label, color, speedMph,
      gpsUpdatedAt, gpsStale,
      distanceToClientMiles: distanceToClientMi != null ? Math.round(distanceToClientMi * 10) / 10 : null,
      distanceToOfficeMiles: distanceToOfficeMi != null ? Math.round(distanceToOfficeMi * 10) / 10 : null,
    };
  });

  return res.status(200).json({
    ok: true,
    resource: 'tech_live_status',
    date: dateStr,
    asOf: new Date(nowMs).toISOString(),
    techs,
    coverageNote: techs.filter((t) => t.vehicleTracked).length + ' of ' + techs.length + ' techs with a Jobber vehicle assignment have live GPS this run. Techs with no vehicle assigned keep the schedule-based status text (no location signal exists for them yet). GPS older than ' + TECH_LIVE_GPS_STALE_MIN + ' min is reported as stale rather than guessed.',
  });
}

// ---------- Weather (Open-Meteo, free, no key) -- resource=weather ----------
const WX_LAT = 41.2048, WX_LON = -73.6440; // Bedford, NY 10506 (HQ)
let wxCacheT = 0; let wxCacheData = null;
function wxCodeInfo(code) {
  const c = Number(code);
  if (c === 0) return { label: 'Clear', emoji: '☀️', risk: 0 };
  if (c === 1) return { label: 'Mostly clear', emoji: '🌤️', risk: 0 };
  if (c === 2) return { label: 'Partly cloudy', emoji: '⛅', risk: 0 };
  if (c === 3) return { label: 'Overcast', emoji: '☁️', risk: 0 };
  if (c === 45 || c === 48) return { label: 'Fog', emoji: '🌫️', risk: 1 };
  if (c >= 51 && c <= 57) return { label: 'Drizzle', emoji: '🌦️', risk: 1 };
  if (c >= 61 && c <= 67) return { label: 'Rain', emoji: '🌧️', risk: 2 };
  if (c >= 71 && c <= 77) return { label: 'Snow', emoji: '🌨️', risk: 2 };
  if (c >= 80 && c <= 82) return { label: 'Rain showers', emoji: '🌧️', risk: 2 };
  if (c === 85 || c === 86) return { label: 'Snow showers', emoji: '🌨️', risk: 2 };
  if (c >= 95) return { label: 'Thunderstorms', emoji: '⛈️', risk: 3 };
  return { label: 'Mixed', emoji: '🌥️', risk: 0 };
}
async function getWeatherBedford() {
  if (wxCacheData && (Date.now() - wxCacheT) < 30 * 60 * 1000) return wxCacheData;
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + WX_LAT + '&longitude=' + WX_LON +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,uv_index,precipitation' +
    '&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m,uv_index' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max' +
    '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York&forecast_days=7';
  const r = await fetch(url);
  if (!r.ok) throw new Error('Open-Meteo returned ' + r.status);
  const j = await r.json();
  wxCacheData = j; wxCacheT = Date.now();
  return j;
}
function wxSummarize(j) {
  const cur = j.current || {};
  const d = j.daily || {};
  const days = (d.time || []).map(function (t, i) {
    const info = wxCodeInfo((d.weather_code || [])[i]);
    return {
      date: t,
      dow: new Date(t + 'T12:00:00-04:00').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }),
      hiF: Math.round((d.temperature_2m_max || [])[i]),
      loF: Math.round((d.temperature_2m_min || [])[i]),
      precipPct: (d.precipitation_probability_max || [])[i],
      windMph: Math.round((d.wind_speed_10m_max || [])[i]),
      label: info.label, emoji: info.emoji, risk: info.risk
    };
  });
  const nowInfo = wxCodeInfo(cur.weather_code);
  // Hourly grouped by local date (Open-Meteo already returns America/New_York local
  // timestamps because we request timezone=America/New_York, so parse the hour straight
  // from the string -- do NOT re-shift through Date+timeZone or it double-converts).
  const h = j.hourly || {};
  const htimes = h.time || [];
  const hourly = {};
  for (let i = 0; i < htimes.length; i++) {
    const t = String(htimes[i]);
    const date = t.slice(0, 10);
    const hh = parseInt(t.slice(11, 13), 10);
    const hourLabel = ((hh % 12) || 12) + ' ' + (hh < 12 ? 'AM' : 'PM');
    const hInfo = wxCodeInfo((h.weather_code || [])[i]);
    (hourly[date] = hourly[date] || []).push({
      time: t,
      hour: hourLabel,
      hour24: hh,
      tempF: (h.temperature_2m || [])[i] != null ? Math.round((h.temperature_2m || [])[i]) : null,
      apparentF: (h.apparent_temperature || [])[i] != null ? Math.round((h.apparent_temperature || [])[i]) : null,
      code: (h.weather_code || [])[i],
      emoji: hInfo.emoji, label: hInfo.label,
      precipPct: (h.precipitation_probability || [])[i],
      windMph: (h.wind_speed_10m || [])[i] != null ? Math.round((h.wind_speed_10m || [])[i]) : null,
      gustMph: (h.wind_gusts_10m || [])[i] != null ? Math.round((h.wind_gusts_10m || [])[i]) : null,
      humidity: (h.relative_humidity_2m || [])[i] != null ? Math.round((h.relative_humidity_2m || [])[i]) : null,
      uv: (h.uv_index || [])[i] != null ? Math.round((h.uv_index || [])[i]) : null
    });
  }
  const current = {
    tempF: cur.temperature_2m != null ? Math.round(cur.temperature_2m) : null,
    apparentF: cur.apparent_temperature != null ? Math.round(cur.apparent_temperature) : null,
    code: cur.weather_code, emoji: nowInfo.emoji, label: nowInfo.label,
    humidity: cur.relative_humidity_2m != null ? Math.round(cur.relative_humidity_2m) : null,
    uv: cur.uv_index != null ? Math.round(cur.uv_index) : null,
    windMph: cur.wind_speed_10m != null ? Math.round(cur.wind_speed_10m) : null,
    precipPct: days[0] ? days[0].precipPct : null,
    hiF: days[0] ? days[0].hiF : null,
    loF: days[0] ? days[0].loF : null,
    updated: cur.time || null
  };
  let risk = null;
  for (const day of days) { if ((day.precipPct != null && day.precipPct >= 50) || day.risk >= 2) { risk = day; break; } }
  const summaryText = (cur.temperature_2m != null ? Math.round(cur.temperature_2m) + 'F ' + nowInfo.label.toLowerCase() : 'Conditions unavailable') +
    (risk ? ' -- ' + risk.label + ' ' + risk.dow + ' (' + (risk.precipPct != null ? risk.precipPct + '% precip' : 'risk') + ')' : ' -- no weather risk next 7 days');
  return { location: 'Bedford, NY 10506 (HQ)', now: { tempF: cur.temperature_2m != null ? Math.round(cur.temperature_2m) : null, label: nowInfo.label, emoji: nowInfo.emoji }, current: current, today: days[0] || null, days: days, daily: days, hourly: hourly, risk: risk, summaryText: summaryText, source: 'Open-Meteo, live' };
}
async function handleWeather(req, res) {
  const j = await getWeatherBedford();
  return res.status(200).json(Object.assign({ ok: true, resource: 'weather' }, wxSummarize(j)));
}

// ---------- Watching (aggregated, honest) -- resource=watching_all ----------
async function handleWatchingAll(req, res) {
  const items = [];
  const notConnected = [];
  try {
    const nowISO = new Date().toISOString();
    const in7ISO = new Date(Date.now() + 7 * 86400000).toISOString();
    const visits = await fiFetchAllRows('visits', '?select=jobber_id,title,start_at,assigned_users,visit_status&start_at=gte.' + encodeURIComponent(nowISO) + '&start_at=lte.' + encodeURIComponent(in7ISO) + '&order=start_at.asc');
    const insp = visits.filter(function (v) { return /inspect/i.test(v.title || ''); });
    insp.slice(0, 3).forEach(function (v) {
      const dt = new Date(v.start_at);
      items.push({ kind: 'inspection', icon: '🔍', title: String(v.title || 'Inspection').slice(0, 70), detail: 'INSPECTIONS -- ' + dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }) + ' ' + dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }), pip: 'g' });
    });
    const techs = new Set();
    visits.forEach(function (v) { let a = []; try { a = typeof v.assigned_users === 'string' ? JSON.parse(v.assigned_users) : (v.assigned_users || []); } catch (e) { a = []; } (a || []).forEach(function (p) { if (p && p.name) techs.add(p.name); }); });
    items.push({ kind: 'crew', icon: '👷', title: 'Crew load next 7 days', detail: 'CREW -- ' + visits.length + ' visit(s) across ' + techs.size + ' assigned tech(s), live from Jobber sync', pip: 'g' });
  } catch (e) {
    notConnected.push({ kind: 'schedule', title: 'Schedule-based watches', reason: 'Schedule lookup failed: ' + e.message });
  }
  notConnected.push({ kind: 'vendor_insurance', title: 'Vendor insurance & certs', reason: 'No vendor-compliance data source connected yet.' });
  notConnected.push({ kind: 'permits', title: 'Permits', reason: 'No permit-tracking data source connected yet.' });
  notConnected.push({ kind: 'change_orders', title: 'Change orders', reason: 'Jobber sync does not include change-order approval state yet.' });
  notConnected.push({ kind: 'equipment', title: 'Truck & equipment service', reason: 'No fleet-maintenance data source connected yet.' });
  notConnected.push({ kind: 'loans', title: 'Loan payments', reason: 'Debt-service detail is not broken out of QuickBooks yet.' });
  return res.status(200).json({ ok: true, resource: 'watching_all', items: items, notConnected: notConnected });
}

// ---------- Notifications hub -- resource=notifications ----------
async function hcSupabaseGet(path) {
  const url = process.env.HIVECONNECT_SUPABASE_URL;
  const key = process.env.HIVECONNECT_SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  const r = await fetch(url + '/rest/v1/' + path, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
  if (!r.ok) throw new Error('HiveConnect lookup failed: ' + (await r.text()).slice(0, 160));
  return r.json();
}
async function handleNotifications(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const groups = [];
  const notConnected = [];
  if (requester.role === 'admin' || requester.role === 'superadmin') {
    try {
      const token = await getValidMicrosoftAccessToken();
      const gRes = await fetch('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=8&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,isRead', { headers: { Authorization: 'Bearer ' + token } });
      const data = await gRes.json();
      if (!gRes.ok) throw new Error((data.error && data.error.message) || 'inbox error');
      const unread = (data.value || []).filter(function (m) { return !m.isRead; }).slice(0, 5).map(function (m) {
        return { title: (m.from && m.from.emailAddress && (m.from.emailAddress.name || m.from.emailAddress.address)) || 'Unknown sender', detail: m.subject || '(no subject)', at: m.receivedDateTime };
      });
      groups.push({ kind: 'email', priority: 1, label: 'Unread email', count: unread.length, items: unread });
    } catch (e) { notConnected.push({ kind: 'email', reason: 'Email: ' + e.message }); }
  } else {
    notConnected.push({ kind: 'email', reason: 'Email notifications are admin-only right now.' });
  }
  try {
    const mapping = requester.id ? await getMapping(requester.id).catch(function () { return null; }) : null;
    if (!mapping || !mapping.hiveconnect_user_id) {
      notConnected.push({ kind: 'messages', reason: 'This account is not linked to a HiveConnect user yet.' });
    } else {
      const hcUserId = mapping.hiveconnect_user_id;
      const notifs = await hcSupabaseGet('notifications?select=id,kind,read,created_at,actor_id,message_id&user_id=eq.' + encodeURIComponent(hcUserId) + '&order=created_at.desc&limit=10');
      if (notifs === null) { notConnected.push({ kind: 'messages', reason: 'HiveConnect bridge is not configured on this deployment.' }); }
      else {
        const unread = notifs.filter(function (n) { return !n.read; });
        const toShow = (unread.length ? unread : notifs).slice(0, 5);
        const uniq = function (arr) { return arr.filter(function (v, i) { return arr.indexOf(v) === i; }); };
        const actorList = uniq(toShow.map(function (n) { return n.actor_id; }).filter(Boolean));
        const msgList = uniq(toShow.map(function (n) { return n.message_id; }).filter(Boolean));
        const results = await Promise.all([
          actorList.length ? hcSupabaseGet('profiles?select=id,display_name&id=in.(' + actorList.join(',') + ')') : Promise.resolve([]),
          msgList.length ? hcSupabaseGet('messages?select=id,content&id=in.(' + msgList.join(',') + ')') : Promise.resolve([])
        ]);
        const actorById = {}; (results[0] || []).forEach(function (a) { actorById[a.id] = a.display_name; });
        const contentById = {}; (results[1] || []).forEach(function (m) { contentById[m.id] = m.content; });
        const items = toShow.map(function (n) {
          const name = actorById[n.actor_id];
          return { title: name ? (name + ' messaged you') : 'Message', detail: String(contentById[n.message_id] || '').slice(0, 90), at: n.created_at };
        });
        groups.push({ kind: 'messages', priority: 2, label: 'HiveConnect messages', count: unread.length, items: items });
      }
    }
  } catch (e) { notConnected.push({ kind: 'messages', reason: e.message }); }
  notConnected.push({ kind: 'calls', reason: 'No phone system connected yet -- missed calls will land here once one is.' });
  try {
    const since = new Date(Date.now() - 24 * 3600000).toISOString();
    const results = await Promise.all([
      fiFetchAllRows('clients', '?select=jobber_id,name,jobber_updated_at&jobber_updated_at=gte.' + encodeURIComponent(since) + '&order=jobber_updated_at.desc&limit=5'),
      fiFetchAllRows('jobs', '?select=jobber_id,title,job_status,jobber_updated_at&jobber_updated_at=gte.' + encodeURIComponent(since) + '&order=jobber_updated_at.desc&limit=5'),
      fiFetchAllRows('invoices', '?select=jobber_id,invoice_number,invoice_status,jobber_updated_at&jobber_updated_at=gte.' + encodeURIComponent(since) + '&order=jobber_updated_at.desc&limit=5')
    ]);
    const items = [];
    results[0].slice(0, 3).forEach(function (c) { items.push({ title: 'Client updated', detail: c.name || c.jobber_id, at: c.jobber_updated_at }); });
    results[1].slice(0, 3).forEach(function (j) { items.push({ title: 'Job ' + String(j.job_status || 'updated').replace(/_/g, ' '), detail: j.title || j.jobber_id, at: j.jobber_updated_at }); });
    results[2].slice(0, 3).forEach(function (i) { items.push({ title: 'Invoice ' + String(i.invoice_status || 'updated').replace(/_/g, ' '), detail: '#' + (i.invoice_number || i.jobber_id), at: i.jobber_updated_at }); });
    items.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
    groups.push({ kind: 'client_updates', priority: 4, label: 'Client & job updates (24h)', count: results[0].length + results[1].length + results[2].length, items: items.slice(0, 5) });
  } catch (e) { notConnected.push({ kind: 'client_updates', reason: 'Jobber-sync lookup failed: ' + e.message }); }
  try {
    const since = new Date(Date.now() - 24 * 3600000).toISOString();
    const results = await Promise.all([
      fiFetchAllRows('requests', '?select=jobber_id,title,client_id,jobber_created_at&jobber_created_at=gte.' + encodeURIComponent(since) + '&order=jobber_created_at.desc&limit=5'),
      fiFetchAllRows('clients', '?is_lead=eq.true&select=jobber_id,name,company_name,jobber_updated_at&jobber_updated_at=gte.' + encodeURIComponent(since) + '&order=jobber_updated_at.desc&limit=5')
    ]);
    const items = [];
    results[0].forEach(function (r) { items.push({ title: 'New request', detail: r.title || r.jobber_id, at: r.jobber_created_at }); });
    results[1].forEach(function (c) { items.push({ title: 'New lead', detail: c.name || c.company_name || c.jobber_id, at: c.jobber_updated_at }); });
    items.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
    groups.push({ kind: 'new_leads', priority: 3, label: 'New lead opportunities (24h)', count: results[0].length + results[1].length, items: items.slice(0, 5) });
  } catch (e) { notConnected.push({ kind: 'new_leads', reason: 'Lead lookup failed: ' + e.message }); }
  notConnected.push({ kind: 'vendor', reason: 'No vendor feeds connected yet.' });
  groups.sort(function (a, b) { return a.priority - b.priority; });
  return res.status(200).json({ ok: true, resource: 'notifications', groups: groups, notConnected: notConnected });
}

// GET /api/track1?resource=check_new_leads -- Vercel Cron only (every 15 min,
// see vercel.json). Alerts Chris by SMS the FIRST time each new lead
// opportunity is seen, from any source: a new Jobber request, or a client
// newly marked is_lead=true (covers HiveLogic-native leads tagged via
// lead_pipeline.lead_source: angi/thumbtack/yelp/facebook/website/etc, and
// Jobber-synced potential clients).
//
// Idempotent by design (sql/033_lead_alerts.sql): Vercel Cron delivery is
// best-effort and can duplicate or miss invocations (Vercel's own docs
// recommend building cron handlers to be idempotent), so each lead is
// claimed via an atomic ignore-duplicates insert -- only a lead that has
// never been claimed before triggers an SMS, no matter how many times this
// fires or how long the lead keeps showing up in the lookback window.
//
// SMS is gated behind REINA_LEAD_ALERT_PHONE (unset = no-op for SMS, exactly
// like REINA_VOICEMAIL_ALERT_PHONE in api/voice-webhook.js) -- the in-app
// notifications group above works regardless of this env var.
// A lead's name, made safe to put in a text message to a person.
//
// The first version of this blocklisted 13 TLDs, which is the wrong shape of
// rule and was trivially bypassed: .ly, .ai, .ru, .gg, .tv, .click, .page and
// every other TLD sailed through, as did "call 914-555-0142 now", as did a
// quote character that closed the framing quotes and let the text read as our
// own prose. bit.ly/x auto-linkifies in every mobile SMS client.
//
// So this allowlists what MAY appear instead. There is no rendering context to
// escape into here -- only a person holding a phone, reading a message that
// arrives FROM THEIR OWN COMPANY NUMBER, deciding whether to tap. The two
// payloads that matter are a link and a phone number, and both are removed
// outright rather than encoded.
//
// Ordinary lead names pass through untouched: "Kitchen remodel — cabinets",
// "Back door will not latch", "O'Brien - 14 Maple Ave". That matters as much
// as the blocking does; a sanitiser that mangles real enquiries gets turned off.
function smsSafeLeadTitle(raw) {
  let t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  // A double quote would close the framing the alert puts around this. The
  // apostrophe is kept -- O'Brien is a customer, not an attack.
  t = t.replace(/["`]/g, '');
  // The character allowlist runs FIRST, so the markers added below survive it
  // intact. Unicode letters and numbers are kept so a real customer's name
  // comes through; the lookalike dot (U+2024) and its friends do not, because
  // they are simply not in this set.
  t = t.replace(/[^\p{L}\p{N} .,'&()#+/–—-]/gu, '');
  // Any dot-joined token, with no TLD list to fall behind: bit.ly, evil.tv,
  // 192.0.2.10, hivelogic-id.ai/r. A real lead name has no reason to hold one.
  t = t.replace(/\S*[^\s.]\.[^\s.]\S*/g, '[link removed]');
  // Explicit schemes and www., including the obfuscated ones people still tap.
  t = t.replace(/\b(?:h[tx]{2}ps?:\/{0,2}|www\b)\S*/gi, '[link removed]');
  // A callback number is the other half of a voice-phishing attempt, and the
  // sender being the company's own number is what sells it.
  t = t.replace(/[+(]?\d[\d\s().-]{6,}\d/g, '[number removed]');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 60).trimEnd() + '…' : (t || 'New lead');
}

async function handleCheckNewLeadsGet(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ ok: false, error: 'This endpoint is for Vercel Cron only.' });
  }

  const since = new Date(Date.now() - 3 * 24 * 3600000).toISOString();
  const candidates = [];
  try {
    const requests = await fiFetchAllRows('requests', '?select=jobber_id,title,client_id,jobber_created_at&jobber_created_at=gte.' + encodeURIComponent(since) + '&order=jobber_created_at.desc');
    requests.forEach(function (r) { candidates.push({ source: 'request', leadId: r.jobber_id, title: r.title || 'New request' }); });
  } catch (e) { /* best-effort -- a failure here should not block the clients-based check below */ }
  try {
    const leads = await fiFetchAllRows('clients', '?is_lead=eq.true&select=jobber_id,name,company_name,jobber_updated_at&jobber_updated_at=gte.' + encodeURIComponent(since) + '&order=jobber_updated_at.desc');
    leads.forEach(function (c) { candidates.push({ source: 'client_lead', leadId: c.jobber_id, title: c.name || c.company_name || 'New lead' }); });
  } catch (e) { /* same */ }

  const alerted = [];
  for (const cand of candidates) {
    try {
      const claimRes = await supabaseRequest('lead_alerts_sent?on_conflict=source,lead_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({ source: cand.source, lead_id: cand.leadId }),
      });
      if (!claimRes.ok) continue;
      const claimed = await claimRes.json();
      if (!claimed || !claimed.length) continue; // already alerted before -- skip
      alerted.push(cand);
    } catch (e) { /* skip this candidate, don't block the rest */ }
  }

  const alertPhone = process.env.REINA_LEAD_ALERT_PHONE;
  if (alerted.length && alertPhone) {
    try {
      const numRes = await supabaseRequest('voice_numbers?role=eq.main&active=eq.true&select=e164&limit=1');
      const mainNumber = numRes.ok ? (await numRes.json())[0] : null;
      if (mainNumber) {
        for (const cand of alerted.slice(0, 5)) {
          // The name is quoted, trimmed and stripped of anything link-shaped
          // (2026-08-23, security review of the web lead intake). Since
          // /api/web-lead exists, a lead name can be typed by a stranger --
          // and this SMS arrives on Chris's phone FROM HIS OWN COMPANY NUMBER,
          // which makes it a ready-made phishing channel: name a lead
          // "HiveLogic alert: re-auth at <domain>" and it reads as a system
          // message from a trusted sender. Quoting it makes it visibly
          // somebody's words rather than ours.
          const body = 'New lead opportunity: "' + smsSafeLeadTitle(cand.title) + '" (' + (cand.source === 'request' ? 'Jobber request' : 'new lead') + ')';
          await twilioRequest('Messages.json', { method: 'POST', body: new URLSearchParams({ From: mainNumber.e164, To: alertPhone, Body: body }) });
        }
      }
    } catch (e) { /* SMS is best-effort -- the lead is still claimed/recorded either way */ }
  }

  return res.status(200).json({ ok: true, resource: 'check_new_leads', checked: candidates.length, newlyAlerted: alerted.length });
}

// ---------- HiveLogic-native record creation (Supabase; Jobber write-back is a later phase) ----------
// One client's service address, for forms that link to an existing client.
//
// The New Lead form used to tell the user "phone and address aren't synced to
// this view yet, so double-check them with the client". Half of that was
// wrong: 6,407 of 8,689 clients have a street address sitting in
// client_locations -- it just was not exposed anywhere the form could reach.
// Retyping an address HiveLogic already knows is how you end up with two
// spellings of the same house.
//
// The phone half of that warning IS accurate and stays: clients.phone exists
// as a column but the Jobber sync populates it for exactly 0 of 8,689 clients,
// so there is nothing to fill.
//
// Deliberately a single-client lookup rather than joining locations into
// /api/clients: that endpoint returns thousands of rows to callers who don't
// need an address, and this is only ever wanted for the one client a user just
// picked.
// GET /api/track1?resource=schedule_unscheduled
//
// Chris, 2026-08-23: "AFTER SAVING THE JOB FORM TO UNASSIGNED JOBS, IT DIDN'T
// SHOW IN THE UNASSIGNED JOBS LAYER ON THE SCHEDULE"
//
// It could not have. The board's `demands` array -- the thing the unscheduled
// rail renders -- was the literal `[]` in public/schedule-board/data.js. The
// rail has never shown anything for anyone: the counter has always read 0 and
// the panel has always said "No unscheduled work 🎉", on a company with 18 open
// jobs that have no slot.
//
// So "Add to Unscheduled" wrote a perfectly good job into a list nothing
// displayed. This is the source that list should have had.
//
// UNSCHEDULED means: open, not archived, not completed, and nowhere to be --
// no start time from Jobber and no HiveLogic appointment. A job with a
// start_at is scheduled, even if the board has no appointment row for it,
// because that is the time the client was given.
async function handleScheduleUnscheduled(req, res) {
  const jRes = await supabaseRequest(
    'jobs?select=jobber_id,job_number,title,client_id,division_code,total,job_status,start_at,completed_at' +
    '&completed_at=is.null&start_at=is.null&job_status=neq.archived' +
    '&order=jobber_created_at.desc&limit=200'
  );
  if (!jRes.ok) return res.status(500).json({ ok: false, error: 'Could not read jobs.' });
  let jobs = await jRes.json();

  // A job that already has an appointment is on the board, not waiting for one.
  // hl_appointments is empty in production today, so this filters nothing yet --
  // it is here so the rail does not start double-listing the moment somebody
  // books one.
  try {
    const refs = jobs.map(j => j.jobber_id).filter(Boolean);
    if (refs.length) {
      const inList = refs.map(r => encodeURIComponent(`"${r}"`)).join(',');
      const aRes = await supabaseRequest(`hl_appointments?job_ref=in.(${inList})&canceled=eq.false&select=job_ref`);
      if (aRes.ok) {
        const booked = new Set((await aRes.json()).map(a => a.job_ref));
        jobs = jobs.filter(j => !booked.has(j.jobber_id));
      }
    }
  } catch { /* an unfiltered rail beats an empty one */ }

  // Who and where, so the card is worth reading. Both non-fatal: a job with no
  // client name still needs to be schedulable.
  const clientIds = [...new Set(jobs.map(j => j.client_id).filter(Boolean))];
  const nameById = new Map(), cityById = new Map();
  if (clientIds.length) {
    const inList = clientIds.map(c => encodeURIComponent(`"${c}"`)).join(',');
    try {
      const cRes = await supabaseRequest(`clients?jobber_id=in.(${inList})&select=jobber_id,name,company_name`);
      if (cRes.ok) for (const c of await cRes.json()) {
        nameById.set(c.jobber_id, c.name || c.company_name || null);
      }
    } catch { /* names are a convenience */ }
    try {
      const lRes = await supabaseRequest(`client_locations?jobber_id=in.(${inList})&select=jobber_id,city,street`);
      if (lRes.ok) for (const l of await lRes.json()) {
        if (!cityById.has(l.jobber_id)) cityById.set(l.jobber_id, l.city || null);
      }
    } catch { /* nor is the town */ }
  }

  const jobsOut = jobs.map(j => ({
    jobRef: j.jobber_id,
    jobNo: j.job_number || null,
    title: j.title || 'Untitled job',
    client: nameById.get(j.client_id) || null,
    city: cityById.get(j.client_id) || null,
    division: j.division_code || null,
    total: j.total != null ? Number(j.total) : null,
  }));

  res.status(200).json({ ok: true, resource: 'schedule_unscheduled', jobs: jobsOut });
}

// GET /api/track1?resource=address_suggest&q=... -- address autocomplete for
// somewhere HiveLogic has never been.
//
// Chris, 2026-08-23: "as you are entering a new address for the new client, it
// should be offering a selectable list of addresses that relate to the
// characters being typed into the text box"
//
// The FIRST tier of that happens in the browser with no network at all: 6,409
// of 8,690 clients have a service address on file, they are already in the
// client book the form has loaded, and offering those first is both instant and
// the more useful half -- an address we already hold usually means a client we
// already have, which is the duplicate this form is trying not to create.
//
// This is the second tier: a house nobody has worked on yet. It goes through
// Nominatim/OpenStreetMap, the same keyless geocoder api/_lib/geocode.js
// already uses, so it needs no API key and no billing account.
//
// NOMINATIM'S USAGE POLICY IS THE CONSTRAINT, and it is why this is shaped the
// way it is. One request per second, and a real identifying User-Agent. Firing
// on every keystroke would breach that and get the IP blocked -- which would
// take the service-area geocoding down with it, a feature nobody was touching.
// So: the browser debounces, this end requires a query long enough to be a real
// address fragment, asks for at most five, and caps how often one user can ask.
async function handleAddressSuggest(req, res) {
  const q = String(req.query.q || '').trim();
  // Short enough that it would match half of Connecticut, and that is exactly
  // the request Nominatim asks people not to send.
  if (q.length < 6) return res.status(200).json({ ok: true, suggestions: [], reason: 'too-short' });

  const rl = await checkRateLimit({
    bucket: 'address_suggest',
    identifier: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown',
    limit: 40,
    windowMs: 60 * 1000,
    deps: { supabaseRequest },
  });
  if (!rl.allowed) {
    // Not an error the user should see as a failure: the on-file addresses are
    // still there, and this tier is a bonus.
    return res.status(200).json({ ok: true, suggestions: [], reason: 'throttled' });
  }

  try {
    const url = 'https://nominatim.openstreetmap.org/search'
      + '?format=json&addressdetails=1&limit=5&countrycodes=us'
      + '&q=' + encodeURIComponent(q);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'HiveLogic/1.0 c_kendall@icloud.com', Accept: 'application/json' },
    });
    if (!r.ok) return res.status(200).json({ ok: true, suggestions: [], reason: 'upstream' });
    const rows = await r.json();
    const suggestions = (Array.isArray(rows) ? rows : []).map((hit) => {
      const a = hit.address || {};
      const street = [a.house_number, a.road].filter(Boolean).join(' ');
      const town = a.city || a.town || a.village || a.hamlet || a.suburb || null;
      const line = [street || null, town, a.state, a.postcode].filter(Boolean).join(', ');
      return {
        // What goes in the box: the tidy one-line form, falling back to
        // Nominatim's own label when we could not assemble one.
        address: line || String(hit.display_name || '').slice(0, 200),
        lat: Number(hit.lat), lng: Number(hit.lon),
      };
    }).filter((s) => s.address);
    return res.status(200).json({ ok: true, suggestions });
  } catch (e) {
    // A geocoder being unreachable must never be more than a missing
    // convenience -- the address box still takes anything typed into it.
    return res.status(200).json({ ok: true, suggestions: [], reason: 'unreachable' });
  }
}

async function handleClientLocation(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const clientId = String((req.query && req.query.clientId) || '').trim();
  if (!clientId) return res.status(400).json({ ok: false, error: 'Which client? No clientId given.' });

  const r = await supabaseRequest(
    `client_locations?jobber_id=eq.${encodeURIComponent(clientId)}&select=street,city,province,postal_code&limit=1`
  );
  if (!r.ok) return res.status(502).json({ ok: false, error: 'Could not look up that client address.' });
  const row = (await r.json())[0];
  if (!row || !row.street) {
    return res.status(200).json({ ok: true, resource: 'client_location', found: false, address: null });
  }
  const address = [row.street, row.city, row.province].filter(Boolean).join(', ')
    + (row.postal_code ? ' ' + row.postal_code : '');
  return res.status(200).json({
    ok: true, resource: 'client_location', found: true,
    address, street: row.street, city: row.city, province: row.province, postalCode: row.postal_code,
  });
}

async function handleCreateClient(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const b = req.body || {};
  const first = String(b.firstName || '').trim();
  const last = String(b.lastName || '').trim();
  const company = String(b.companyName || '').trim();
  if (!first && !last && !company) return res.status(400).json({ ok: false, error: 'Need a first/last name or a company name.' });
  // Phone (2026-08-21): the Schedule board's "new client" path needs one --
  // a dispatcher booking a visit for someone they cannot call has booked half
  // a visit. Stored raw AND as e164 when it parses, matching what the sync
  // writes for Jobber clients so downstream callers do not have to special-case
  // HiveLogic-created rows.
  const phoneRaw = String(b.phone || '').trim();
  const digits = phoneRaw.replace(/\D/g, '');
  const e164 = digits.length === 10 ? ('+1' + digits)
    : (digits.length === 11 && digits[0] === '1') ? ('+' + digits)
    : null;

  const row = {
    jobber_id: 'HL-' + Date.now(),
    name: (first || last) ? (first + ' ' + last).trim() : company,
    first_name: first || null,
    last_name: last || null,
    company_name: company || null,
    email: String(b.email || '').trim() || null,
    phone: phoneRaw || null,
    phone_e164: e164,
    is_lead: true,
    is_archived: false,
    jobber_updated_at: new Date().toISOString(),
    // The rest of what the New Client form asks. Optional to a fault: the
    // Schedule board's quick-add calls this endpoint with a name and nothing
    // else, and must keep working. Trimmed to null rather than stored as ''
    // so "not asked" and "answered blank" read the same downstream.
    client_type: String(b.clientType || '').trim() || null,
    preferred_contact: String(b.preferredContact || '').trim() || null,
    source: String(b.source || '').trim() || null,
    brand: String(b.brand || '').trim() || null,
    membership: String(b.membership || '').trim() || null,
    second_contact: String(b.secondContact || '').trim() || null,
    property_notes: String(b.propertyNotes || '').trim() || null,
  };
  const r = await supabaseRequest('clients', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
  if (!r.ok) return res.status(500).json({ ok: false, error: 'Insert failed: ' + (await r.text()).slice(0, 300) });
  const created = (await r.json())[0];

  // Address, when given. A separate row in client_locations because that is
  // where every other client's address already lives -- the board reads the
  // same table for a Jobber client and a HiveLogic one. Deliberately NOT
  // fatal: the client exists either way, and losing the whole client because
  // the address failed to write would be the worse outcome. lat/lng are left
  // null for the existing geocoder to fill rather than guessed here.
  let locationSaved = false;
  const street = String(b.street || '').trim();
  if (created && created.jobber_id && street) {
    try {
      const locRow = {
        jobber_id: created.jobber_id,
        street,
        city: String(b.city || '').trim() || null,
        province: String(b.province || '').trim() || null,
        postal_code: String(b.postalCode || '').trim() || null,
        country: String(b.country || '').trim() || null,
      };
      const lr = await supabaseRequest('client_locations', { method: 'POST', body: JSON.stringify(locRow) });
      locationSaved = lr.ok;
    } catch (e) { locationSaved = false; }
  }

  return res.status(200).json({ ok: true, resource: 'create_client', client: created, locationSaved, note: 'Saved in HiveLogic. Not pushed to Jobber yet -- Jobber write-back is a later phase.' });
}
// 2026-08-25, jomell, looking at jovie folloso's client card: "his number is
// not present anywhere add this and it should reflect to all clients and
// future clients." Every existing client-mutation path only ever CREATES a
// brand-new HiveLogic client (handleCreateClient above) -- there was no way
// to edit contact info on an already-synced client at all.
//
// Deliberately writes ONLY clients.phone, never phone_e164. The Jobber sync
// (api/jobber/sync.js mapClient()) does a full-row upsert on jobber_id every
// hour and always includes phone_e164 in that payload (even as null) --
// writing there directly would get silently wiped on the very next sync for
// any client with a real Jobber id. `phone` is never in that payload, and
// api/clients.js already reads it as the fallback
// (`phone: c.phone_e164 || c.phone || null`), so this is the column that's
// actually safe to own from HiveLogic's side -- same column
// handleCreateClient already uses for a brand-new client, just now also
// settable on an existing one.
// jomell, 2026-08-27: there was no way to enter or fix an address on an
// EXISTING client -- handleCreateClient above only ever writes one at
// creation time. Same reasoning as the phone half of this endpoint: a real
// street a real person typed in beats none on file. lat/lng are left null
// here too, same as at creation -- for the existing geocoder to fill, never
// guessed inline.
async function upsertClientAddress(clientId, b) {
  const street = String(b.street || '').trim();
  if (!street) return;
  const locRow = {
    street,
    city: String(b.city || '').trim() || null,
    province: String(b.province || '').trim() || null,
    postal_code: String(b.postalCode || '').trim() || null,
  };
  const existing = await supabaseRequest(`client_locations?jobber_id=eq.${encodeURIComponent(clientId)}&select=jobber_id&limit=1`);
  const rows = existing.ok ? await existing.json() : [];
  if (rows.length) {
    await supabaseRequest(`client_locations?jobber_id=eq.${encodeURIComponent(clientId)}`, {
      method: 'PATCH',
      body: JSON.stringify(locRow),
    });
  } else {
    await supabaseRequest('client_locations', {
      method: 'POST',
      body: JSON.stringify({ jobber_id: clientId, ...locRow }),
    });
  }
}

async function handleUpdateClientContact(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const b = req.body || {};
  const id = String(b.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'A client id is required.' });
  const phoneRaw = String(b.phone || '').trim();
  const r = await supabaseRequest(`clients?jobber_id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ phone: phoneRaw || null }),
  });
  if (!r.ok) return res.status(500).json({ ok: false, error: 'Update failed: ' + (await r.text()).slice(0, 300) });
  const rows = await r.json();
  if (!rows.length) return res.status(404).json({ ok: false, error: 'Client not found.' });

  let addressSaved = true;
  if (String(b.street || '').trim()) {
    try { await upsertClientAddress(id, b); } catch (e) { addressSaved = false; }
  }
  return res.status(200).json({ ok: true, resource: 'update_client_contact', client: rows[0], addressSaved });
}
// 2026-08-25, jomell: "in active jobs, when clicking on a job, there should
// be an option to 'close job' (meaning its done)."
//
// Deliberately writes ONLY jobs.hl_closed_at, never job_status or
// completed_at -- both of those are in the Jobber sync's mapJob() full-row
// upsert payload every run, so writing "closed" there directly for a real
// Jobber-synced job would get silently wiped on the next sync. hl_closed_at
// is a new HiveLogic-owned column (20260825160000_jobs_hl_closed.sql) the
// sync never touches, same discipline as clients.phone above and
// project_seq/division_code already on this table. A toggle (closed: true
// sets it to now, false clears it) rather than a one-way action, so a job
// closed by mistake can be reopened without a database console.
async function handleSetJobClosed(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const b = req.body || {};
  const id = String(b.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'A job id is required.' });
  const closed = !!b.closed;
  const r = await supabaseRequest(`jobs?jobber_id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ hl_closed_at: closed ? new Date().toISOString() : null }),
  });
  if (!r.ok) return res.status(500).json({ ok: false, error: 'Update failed: ' + (await r.text()).slice(0, 300) });
  const rows = await r.json();
  if (!rows.length) return res.status(404).json({ ok: false, error: 'Job not found.' });
  return res.status(200).json({ ok: true, resource: 'set_job_closed', job: rows[0] });
}
async function handleCreateJob(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ ok: false, error: 'Job needs a title.' });

  // T&M (Chris's ask, 2026-07-21): checkbox + predetermined rate-type dropdown
  // on the same New Job form -- no separate T&M intake screen. The rate is
  // always looked up server-side from tm_rate_types, never trusted from the
  // client, so a tampered request can't set an arbitrary hourly rate.
  // Where the job lands. The New Job form now asks explicitly instead of every
  // job silently becoming 'active'. 'unscheduled' is an existing job_status this
  // project already uses, so the Unscheduled list and every status filter pick
  // these up with no new flag to teach them.
  const wantsUnscheduled = b.schedule === 'unscheduled';
  const jobStatus = wantsUnscheduled ? 'unscheduled' : 'active';

  const isTm = b.isTm === true;
  let tmServiceType = null;
  let tmRateHourly = null;
  if (isTm) {
    tmServiceType = String(b.tmServiceType || '').trim();
    if (!tmServiceType) return res.status(400).json({ ok: false, error: 'T&M jobs need a rate type selected.' });
    const rateR = await supabaseRequest(`tm_rate_types?key=eq.${encodeURIComponent(tmServiceType)}&active=eq.true&select=rate_hourly`);
    if (!rateR.ok) return res.status(502).json({ ok: false, error: `Failed to look up T&M rate: ${await rateR.text()}` });
    const rateRows = await rateR.json();
    if (!rateRows.length) return res.status(400).json({ ok: false, error: 'Unknown or inactive T&M rate type.' });
    tmRateHourly = Number(rateRows[0].rate_hourly);
  }

  // Project numbering + the client link + a real division field all live in
  // createNativeJob, so the New Job form and estimate-conversion produce
  // identical jobs. See api/_lib/native-job.js for the three defects this
  // replaced (no number, no client link, division glued into the title).
  const companySlug = (await companySlugForUser({ id: requester.id })) || 'greenwich-handyman';
  let created, jobReference;
  try {
    const result = await createNativeJob({
      companyId: companySlug,
      title,
      clientId: b.clientId || null,
      total: b.total,
      division: b.division || null,
      jobStatus,
    });
    created = result.job;
    jobReference = result.jobRef;
  } catch (e) {
    const status = e.code === 'PROJECT_NUMBER_TAKEN' ? 409 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }

  // Everything below runs against an ALREADY-CREATED job. Failures are
  // reported in `warnings` rather than turned into an error response, because
  // returning a failure for a job that does exist is what makes someone create
  // it a second time.
  const warnings = [];

  const notes = String(b.notes || '').trim();
  if (notes) {
    // job_workflow.notes already exists and is already the per-job note field
    // the Job Setup view reads -- no new column for this.
    const nR = await supabaseRequest('job_workflow?on_conflict=job_ref', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ job_ref: created.jobber_id, notes, updated_by: requester.email || requester.id }),
    });
    if (!nR.ok) warnings.push('The job was created, but its notes did not save: ' + (await nR.text()).slice(0, 160));
  }

  let lineItems = [];
  if (Array.isArray(b.lineItems) && b.lineItems.length) {
    try {
      lineItems = await replaceJobLineItems(created.jobber_id, b.lineItems, requester);
    } catch (e) {
      warnings.push('The job was created, but its line items did not save: ' + e.message);
    }
  }

  if (isTm) {
    const wfRow = { job_ref: created.jobber_id, is_tm: true, tm_service_type: tmServiceType, tm_rate_hourly: tmRateHourly };
    const wfR = await supabaseRequest('job_workflow?on_conflict=job_ref', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(wfRow),
    });
    if (!wfR.ok) {
      // Job itself was created successfully -- don't fail the whole request
      // over the T&M flag not saving, but say so honestly.
      warnings.push('The job was created, but its T&M flag did not save: ' + (await wfR.text()).slice(0, 160));
    }
  }

  return res.status(200).json({
    ok: true, resource: 'create_job', job: created, jobRef: jobReference,
    isTm, tmServiceType, tmRateHourly,
    jobStatus, lineItems, warnings,
    note: 'Saved in HiveLogic. Not pushed to Jobber yet -- Jobber write-back is a later phase.',
  });
}

// T&M rate types (Chris's ask, 2026-07-21): the New Job form's T&M checkbox
// reveals a dropdown of predetermined hourly rates by service type. The rate
// table lives in Postgres (tm_rate_types), never hardcoded here -- add rows
// there to expand the dropdown. Starts with exactly one Chris-confirmed row:
// General T&M at $225/hr.
async function handleTmRateTypesList(req, res) {
  const r = await supabaseRequest('tm_rate_types?active=eq.true&select=key,label,rate_hourly&order=label.asc');
  if (!r.ok) return res.status(502).json({ ok: false, error: `Failed to load rate types: ${await r.text()}` });
  const rows = await r.json();
  return res.status(200).json({ ok: true, resource: 'tm_rate_types_list', rateTypes: rows });
}

// jomell, 2026-08-27: invoices should carry a 7-day payment deadline --
// every HiveLogic-created invoice gets a real due date, not a blank one,
// when the caller doesn't supply their own.
function defaultInvoiceDueDate() {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function handleCreateInvoice(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const b = req.body || {};
  const amount = Number(b.amount);
  if (!isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: 'Invoice needs a dollar amount.' });
  const row = {
    // Date.now() alone can collide when two requests land in the same
    // millisecond. The synced-table primary key is jobber_id, so give every
    // HiveLogic-owned draft a collision-resistant namespace id.
    jobber_id: 'HL-INV-' + crypto.randomUUID(),
    invoice_number: String(Math.floor(Date.now() / 1000)),
    invoice_status: 'draft',
    total: amount,
    payments: 0,
    due_date: b.dueDate || defaultInvoiceDueDate(),
    client_id: b.clientId || null,
    jobber_updated_at: new Date().toISOString()
  };
  const r = await supabaseRequest('invoices', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
  if (!r.ok) return res.status(500).json({ ok: false, error: 'Insert failed: ' + (await r.text()).slice(0, 300) });
  const created = (await r.json())[0];
  return res.status(200).json({ ok: true, resource: 'create_invoice', invoice: created, note: 'Saved as a DRAFT in HiveLogic. Not sent to the client and not in Jobber/QuickBooks yet.' });
}

// Mark-paid is a STATUS WRITE ONLY -- it records that money already arrived. It
// does not charge a card, call Authorize.Net/Twilio, or notify the client.
//
// Restricted to invoices HiveLogic created itself ("HL-INV-*"). Jobber-synced
// rows are owned by api/jobber/sync.js: setting invoice_status on one here would
// be overwritten on the next sync, so the UI would show a change that silently
// reverts. Those stay read-only and link out to Jobber instead.
// ---- Job line items -------------------------------------------------------
//
// Chris's ask (2026-08-18): a job needs itemised priced activities, and a way
// to become an invoice. Estimates, quotes and invoices already carried priced
// lines; a job could only hold a single lump `total`, so the work done on a job
// could never be itemised and a job->invoice conversion had nothing to copy.
//
// Saving is replace-the-set rather than per-row PATCH: the editor is a small
// grid where rows are added and removed freely, and diffing that client-side is
// how rows quietly go missing.
const JOB_LINE_MAX = 200;

function normalizeJobLine(raw, index) {
  const description = String((raw && raw.description) || '').trim();
  // A blank description is how the editor represents "row not filled in yet".
  if (!description) return null;
  const quantity = Number(raw.quantity);
  const unitPrice = Number(raw.unitPrice != null ? raw.unitPrice : raw.unit_price);
  const q = isFinite(quantity) && quantity >= 0 ? quantity : 1;
  const p = isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0;
  return {
    description: description.slice(0, 500),
    quantity: q,
    unit_price: p,
    // Rounded at save time rather than left to float drift on read: this is the
    // number an invoice gets raised from.
    line_total: Math.round(q * p * 100) / 100,
    sort_order: index,
  };
}

export async function replaceJobLineItems(jobRefId, rawLines, requester, deps = {}) {
  const sb = deps.supabaseRequest || supabaseRequest;
  const who = (requester && (requester.email || requester.id)) || null;
  const lines = (Array.isArray(rawLines) ? rawLines : [])
    .slice(0, JOB_LINE_MAX)
    .map(normalizeJobLine)
    .filter(Boolean)
    .map((l, i) => ({ ...l, sort_order: i, job_ref: jobRefId, created_by: who }));

  const del = await sb(`job_line_items?job_ref=eq.${encodeURIComponent(jobRefId)}`, { method: 'DELETE' });
  if (!del.ok) throw new Error('Could not clear the old lines: ' + (await del.text()).slice(0, 200));
  if (!lines.length) return [];

  const ins = await sb('job_line_items', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(lines),
  });
  if (!ins.ok) throw new Error('Could not save the lines: ' + (await ins.text()).slice(0, 200));
  return ins.json();
}

export async function readJobLineItems(jobRefId, deps = {}) {
  const sb = deps.supabaseRequest || supabaseRequest;
  const r = await sb(`job_line_items?job_ref=eq.${encodeURIComponent(jobRefId)}&order=sort_order.asc,created_at.asc&select=*`);
  if (!r.ok) throw new Error('Could not read the lines: ' + (await r.text()).slice(0, 200));
  return r.json();
}

function sumLineTotals(lines) {
  return Math.round((lines || []).reduce((t, l) => t + (Number(l.line_total) || 0), 0) * 100) / 100;
}

// GET  ?resource=job_line_items&jobRef=HL-JOB-10001   -> the job's lines
// POST  { jobRef, lines: [{ description, quantity, unitPrice }] } -> replace them
async function handleJobLineItems(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });

  if (req.method === 'GET') {
    const jobRefId = String(req.query.jobRef || '').trim();
    if (!jobRefId) return res.status(400).json({ ok: false, error: 'Which job? No jobRef given.' });
    const lines = await readJobLineItems(jobRefId);
    return res.status(200).json({ ok: true, resource: 'job_line_items', jobRef: jobRefId, lines, total: sumLineTotals(lines) });
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET or POST only' });
  const b = req.body || {};
  const jobRefId = String(b.jobRef || '').trim();
  if (!jobRefId) return res.status(400).json({ ok: false, error: 'Which job? No jobRef given.' });

  const jobR = await supabaseRequest(`jobs?jobber_id=eq.${encodeURIComponent(jobRefId)}&select=jobber_id&limit=1`);
  if (!jobR.ok) return res.status(502).json({ ok: false, error: 'Could not look up that job.' });
  if (!(await jobR.json()).length) return res.status(404).json({ ok: false, error: 'That job no longer exists.' });

  let lines;
  try {
    lines = await replaceJobLineItems(jobRefId, b.lines, requester);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  return res.status(200).json({ ok: true, resource: 'job_line_items', jobRef: jobRefId, lines, total: sumLineTotals(lines) });
}

// ---- Job -> invoice -------------------------------------------------------
//
// Raises a DRAFT invoice from a job's line items. Nothing is sent to the client
// and nothing reaches Jobber/QuickBooks -- same contract as create_invoice.
//
// invoices already had every column this needs: job_id (text, jobs.jobber_id),
// job_uuid, and line_items (jsonb). Nothing schema-side was added for this.
async function handleCreateInvoiceFromJob(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const b = req.body || {};
  const jobRefId = String(b.jobRef || '').trim();
  if (!jobRefId) return res.status(400).json({ ok: false, error: 'Which job? No jobRef given.' });

  const jobR = await supabaseRequest(
    `jobs?jobber_id=eq.${encodeURIComponent(jobRefId)}&select=jobber_id,uuid_id,title,total,client_id,client_uuid,project_seq,job_number&limit=1`
  );
  if (!jobR.ok) return res.status(502).json({ ok: false, error: 'Could not look up that job.' });
  const job = (await jobR.json())[0];
  if (!job) return res.status(404).json({ ok: false, error: 'That job no longer exists.' });

  // Billing the same job twice is a money mistake, not a UI annoyance, so it
  // takes an explicit second confirmation rather than a warning after the fact.
  const priorR = await supabaseRequest(
    `invoices?job_id=eq.${encodeURIComponent(jobRefId)}&select=jobber_id,invoice_number,invoice_status,total`
  );
  const prior = priorR.ok ? await priorR.json() : [];
  if (prior.length && b.allowDuplicate !== true) {
    return res.status(409).json({
      ok: false,
      error: 'This job already has ' + prior.length + ' invoice' + (prior.length === 1 ? '' : 's') + '.',
      existing: prior,
      needsConfirm: true,
    });
  }

  // 2026-08-26, jomell: "the amount should be customizable... since its
  // going to be just a draft first. the name/label should be customizable
  // as well as the amount." A draft invoice no longer has to bill the
  // job's full line-item total under the job's own title -- a deposit or
  // any other partial amount is now a real option. When a custom amount
  // is given it replaces the line-item computation entirely with a single
  // line under the custom title; omitting it keeps the original
  // job-line-items behavior untouched, so any other caller of this action
  // is unaffected.
  const customSubject = String(b.subject || '').trim();
  const customAmount = Number(b.amount);
  const hasCustomAmount = isFinite(customAmount) && customAmount > 0;

  let lineItems;
  let amount;
  if (hasCustomAmount) {
    amount = Math.round(customAmount * 100) / 100;
    lineItems = [{ description: customSubject || job.title || 'Work performed', quantity: 1, unitPrice: amount, lineTotal: amount }];
  } else {
    const jobLines = await readJobLineItems(jobRefId);
    lineItems = jobLines.map((l) => ({
      description: l.description,
      quantity: Number(l.quantity),
      unitPrice: Number(l.unit_price),
      lineTotal: Number(l.line_total),
    }));

    // A job with no itemised lines but a priced total still has something to
    // bill -- turn that into one line rather than refusing.
    if (!lineItems.length) {
      const lump = Number(job.total);
      if (!isFinite(lump) || lump <= 0) {
        return res.status(400).json({ ok: false, error: 'This job has no line items and no value, so there is nothing to invoice yet. Add a line item first.' });
      }
      lineItems = [{ description: job.title || 'Work performed', quantity: 1, unitPrice: lump, lineTotal: lump }];
    }

    amount = Math.round(lineItems.reduce((t, l) => t + (Number(l.lineTotal) || 0), 0) * 100) / 100;
    if (amount <= 0) return res.status(400).json({ ok: false, error: 'Those line items add up to $0 -- nothing to invoice.' });
  }

  const row = {
    jobber_id: 'HL-INV-' + crypto.randomUUID(),
    invoice_number: String(Math.floor(Date.now() / 1000)),
    invoice_status: 'draft',
    subject: customSubject || job.title || null,
    subtotal: amount,
    total: amount,
    balance: amount,
    payments: 0,
    due_date: b.dueDate || defaultInvoiceDueDate(),
    client_id: job.client_id || null,
    client_uuid: job.client_uuid || null,
    job_id: job.jobber_id,
    job_uuid: job.uuid_id || null,
    line_items: lineItems,
    jobber_updated_at: new Date().toISOString(),
  };
  const r = await supabaseRequest('invoices', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
  if (!r.ok) return res.status(500).json({ ok: false, error: 'Insert failed: ' + (await r.text()).slice(0, 300) });
  const created = (await r.json())[0];
  return res.status(200).json({
    ok: true,
    resource: 'create_invoice_from_job',
    invoice: created,
    lineCount: lineItems.length,
    amount,
    note: 'Saved as a DRAFT in HiveLogic. Not sent to the client and not in Jobber/QuickBooks yet.',
  });
}

// 2026-08-25, jomell: "the client should be informed or mailed about the
// invoice since they will be making a deposit for this." A draft invoice
// created from a job (handleCreateInvoiceFromJob above) is explicitly "not
// sent to the client" -- there was no way to actually tell them it exists
// at all. Mirrors send.js's estimate email (sendEmail/isEmailConfigured,
// same escapeHtml/money helpers) but simpler: an invoice needs no
// approve/reject decision, just a notification. No "Pay now" link --
// Phase 1 of the Client Portal explicitly has no live payment processor
// wired in (sql/013_client_portal.sql's own header), so a payment button
// here would be exactly the kind of capability Law 1 forbids inventing.
// Same guard as handleMarkInvoicePaid: only ever a HiveLogic-created
// invoice (HL-INV-) -- a Jobber-synced one is not this app's to notify
// about.
function ivEscapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function ivMoney(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

async function handleSendInvoiceEmail(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const id = String((req.body || {}).id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'Which invoice? No id given.' });
  if (!id.startsWith('HL-INV-')) {
    return res.status(400).json({ ok: false, error: 'This invoice is synced from Jobber -- send it from there.' });
  }

  const invR = await supabaseRequest(`invoices?jobber_id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  if (!invR.ok) return res.status(502).json({ ok: false, error: 'Could not look up that invoice.' });
  const invoice = (await invR.json())[0];
  if (!invoice) return res.status(404).json({ ok: false, error: 'That invoice no longer exists.' });

  if (!invoice.client_id) return res.status(422).json({ ok: false, error: 'This invoice has no client on it.' });
  const clientR = await supabaseRequest(`clients?jobber_id=eq.${encodeURIComponent(invoice.client_id)}&select=email,name,first_name,phone&limit=1`);
  const client = clientR.ok ? (await clientR.json())[0] : null;
  if (!client || !client.email) return res.status(422).json({ ok: false, error: 'No email on file for this client.' });
  if (!isEmailConfigured()) return res.status(422).json({ ok: false, error: 'Email is not configured for this deployment (RESEND_API_KEY unset).' });

  // 2026-08-27, jomell: invoices emailed to a client should carry a real
  // PDF of the invoice. Everything below is read fresh, real data for the
  // attached PDF -- an address on file, the
  // job it's billing against, and the job's other real invoices for a true
  // running balance. Any of the three can legitimately be missing (no
  // address on file, no linked job, no other invoices yet); the PDF just
  // omits that section rather than guessing.
  let address = null;
  if (client) {
    const addrR = await supabaseRequest(`client_locations?jobber_id=eq.${encodeURIComponent(invoice.client_id)}&select=street,city,province,postal_code&limit=1`);
    if (addrR.ok) { const rows = await addrR.json(); address = rows[0] || null; }
  }
  let job = null;
  if (invoice.job_id) {
    const jobR = await supabaseRequest(`jobs?jobber_id=eq.${encodeURIComponent(invoice.job_id)}&select=title,total&limit=1`);
    if (jobR.ok) { const rows = await jobR.json(); job = rows[0] || null; }
  }
  let accountBalance = null;
  let jobInvoices = null;
  if (invoice.job_id) {
    const jiR = await supabaseRequest(`invoices?job_id=eq.${encodeURIComponent(invoice.job_id)}&select=jobber_id,invoice_number,subject,total,balance,invoice_status&order=issued_date.asc.nullslast`);
    if (jiR.ok) {
      const rows = await jiR.json();
      accountBalance = rows.reduce((sum, r) => sum + (Number(r.balance) || 0), 0);
      jobInvoices = rows;
    }
  }
  const pdfBytes = await generateInvoicePdf({ invoice, client, address, job, accountBalance, jobInvoices });
  const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

  const clientName = client.first_name || client.name || 'there';
  const dueLine = invoice.due_date ? `<tr><td style="padding:6px 0;color:#484f64">Due</td><td style="padding:6px 0;text-align:right;font-weight:700">${ivEscapeHtml(invoice.due_date)}</td></tr>` : '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
      <p>Hi ${ivEscapeHtml(clientName)},</p>
      <p>You have a new invoice${invoice.subject ? ` for <b>${ivEscapeHtml(invoice.subject)}</b>` : ''} -- the full details are in the attached PDF.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0" role="presentation">
        <tr><td style="padding:6px 0;color:#484f64">Invoice</td><td style="padding:6px 0;text-align:right;font-weight:700">#${ivEscapeHtml(invoice.invoice_number || '')}</td></tr>
        <tr><td style="padding:6px 0;color:#484f64">Amount due</td><td style="padding:6px 0;text-align:right;font-weight:700;font-size:16px">${ivMoney(invoice.total)}</td></tr>
        ${dueLine}
      </table>
      <p style="color:#484f64">Please contact us to arrange payment.</p>
    </div>`;
  const text = `You have a new invoice #${invoice.invoice_number || ''} for ${ivMoney(invoice.total)}. The full details are in the attached PDF. Please contact us to arrange payment.`;

  const sent = await sendEmail({
    to: client.email,
    subject: `Invoice #${invoice.invoice_number || ''}`,
    html, text,
    attachments: [{ filename: `Invoice-${invoice.invoice_number || id}.pdf`, content: pdfBase64 }],
  });
  if (!sent.ok) return res.status(422).json({ ok: false, error: sent.error || 'Could not send the email.' });

  let updated = invoice;
  if (invoice.invoice_status === 'draft') {
    const patchR = await supabaseRequest(`invoices?jobber_id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ invoice_status: 'awaiting_payment', jobber_updated_at: new Date().toISOString() }),
    });
    if (patchR.ok) { const rows = await patchR.json(); if (rows.length) updated = rows[0]; }
  }

  return res.status(200).json({ ok: true, resource: 'send_invoice_email', invoice: updated, email: client.email });
}

async function handleMarkInvoicePaid(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const id = String((req.body || {}).id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'Which invoice? No id given.' });
  if (!id.startsWith('HL-INV-')) {
    return res.status(400).json({ ok: false, error: 'This invoice is synced from Jobber. Record the payment in Jobber/QuickBooks -- HiveLogic mirrors that status, it does not set it.' });
  }
  const r = await supabaseRequest(`invoices?jobber_id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ invoice_status: 'paid', jobber_updated_at: new Date().toISOString() })
  });
  if (!r.ok) return res.status(500).json({ ok: false, error: 'Update failed: ' + (await r.text()).slice(0, 300) });
  const rows = await r.json();
  if (!rows.length) return res.status(404).json({ ok: false, error: 'That invoice no longer exists.' });
  return res.status(200).json({ ok: true, resource: 'mark_invoice_paid', invoice: rows[0], note: 'Status only. No payment was processed and nothing was sent to the client.' });
}

// 2026-08-26, jomell: "the invoices... should have a title or label rather
// than just the number... their names should be edittable" -- then, after
// the title-only version shipped: "it should also apply to when im
// editting an invoice" (the amount too). Same HL-INV- guard as
// handleMarkInvoicePaid/handleSendInvoiceEmail above: a Jobber-synced
// invoice's subject/total is overwritten by the Jobber sync's own upsert
// on every run, so editing either here would just get silently reverted.
// Restricted to still-draft invoices for the same reason
// updateChangeOrderDescription locks a change order after it's been acted
// on -- once sent, the client has already seen a specific amount, and
// rewriting it after the fact would silently misrepresent what was
// actually communicated.
async function handleUpdateInvoice(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const b = req.body || {};
  const id = String(b.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'Which invoice? No id given.' });
  if (!id.startsWith('HL-INV-')) {
    return res.status(400).json({ ok: false, error: "This invoice is synced from Jobber -- edit it there." });
  }
  const subject = String(b.subject || '').trim();
  if (!subject) return res.status(400).json({ ok: false, error: 'A title is required.' });

  const curR = await supabaseRequest(`invoices?jobber_id=eq.${encodeURIComponent(id)}&select=invoice_status,line_items&limit=1`);
  if (!curR.ok) return res.status(502).json({ ok: false, error: 'Could not look up that invoice.' });
  const current = (await curR.json())[0];
  if (!current) return res.status(404).json({ ok: false, error: 'That invoice no longer exists.' });
  if (current.invoice_status !== 'draft') {
    return res.status(400).json({ ok: false, error: 'This invoice has already been sent -- only a draft can still be edited.' });
  }

  const patch = { subject, jobber_updated_at: new Date().toISOString() };
  const amount = Number(b.amount);
  if (isFinite(amount) && amount > 0) {
    const rounded = Math.round(amount * 100) / 100;
    patch.total = rounded;
    patch.subtotal = rounded;
    patch.balance = rounded;
    // Only re-price the invoice's line items when there is exactly one --
    // the single custom line the "customizable amount" create flow writes.
    // A multi-line invoice keeps its real itemization; only the lump total
    // moves, same as every other total shown elsewhere in this app.
    const lines = Array.isArray(current.line_items) ? current.line_items : [];
    if (lines.length === 1) {
      patch.line_items = [{ ...lines[0], description: subject, unitPrice: rounded, lineTotal: rounded }];
    }
  }

  const r = await supabaseRequest(`invoices?jobber_id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) return res.status(500).json({ ok: false, error: 'Update failed: ' + (await r.text()).slice(0, 300) });
  const rows = await r.json();
  if (!rows.length) return res.status(404).json({ ok: false, error: 'That invoice no longer exists.' });
  return res.status(200).json({ ok: true, resource: 'update_invoice', invoice: rows[0] });
}

// 2026-08-26, jomell: "lets start with the timesheet... copy it into our
// own [Time & Timesheets tab]." A week's worth of time_sheet_entries
// (Jobber-synced table, api/jobber/sync-extended.js), shaped for the
// weekly grid: each entry's job resolved to a real title where one
// exists, or "General" for the entries no job is attached to (matches
// Jobber's own screenshot layout). Job titles are looked up only for the
// distinct job ids actually present this week -- not the whole jobs
// table -- since a week's entries touch at most a handful of jobs.
async function handleTimesheetWeek(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const startAt = String(req.query.startAt || '').trim();
  const endAt = String(req.query.endAt || '').trim();
  if (!startAt || !endAt || isNaN(Date.parse(startAt)) || isNaN(Date.parse(endAt))) {
    return res.status(400).json({ ok: false, error: 'A valid startAt and endAt are required.' });
  }

  const entriesRes = await supabaseRequest(
    `time_sheet_entries?start_at=gte.${encodeURIComponent(startAt)}&start_at=lt.${encodeURIComponent(endAt)}` +
    `&select=jobber_id,start_at,end_at,final_duration,user_id,job_id,note&order=start_at.asc&limit=2000`
  );
  if (!entriesRes.ok) return res.status(500).json({ ok: false, error: 'Could not load timesheet entries: ' + (await entriesRes.text()).slice(0, 300) });
  const entries = await entriesRes.json();

  const jobIds = [...new Set(entries.map(e => e.job_id).filter(Boolean))];
  let jobTitleById = {};
  if (jobIds.length) {
    const jobsRes = await supabaseRequest(`jobs?jobber_id=in.(${jobIds.map(id => encodeURIComponent(id)).join(',')})&select=jobber_id,title`);
    if (jobsRes.ok) { (await jobsRes.json()).forEach(j => { jobTitleById[j.jobber_id] = j.title; }); }
  }

  const shaped = entries.map(e => {
    const durationSeconds = isFinite(Number(e.final_duration)) && Number(e.final_duration) > 0
      ? Number(e.final_duration)
      : Math.round((new Date(e.end_at) - new Date(e.start_at)) / 1000);
    return {
      id: e.jobber_id,
      userId: e.user_id,
      jobId: e.job_id || null,
      jobLabel: e.job_id ? (jobTitleById[e.job_id] || 'Job') : 'General',
      startAt: e.start_at,
      endAt: e.end_at,
      durationSeconds,
      note: e.note || null,
    };
  });

  return res.status(200).json({ ok: true, resource: 'timesheet_week', entries: shaped });
}

// The Create Timesheet Entry popup. HiveLogic-native rows use their own
// 'HL-TSE-<uuid>' id namespace (same convention as HL-INV-/HL-JOB-/HL-CO-)
// so the Jobber sync's own timeSheetEntries upsert never touches or
// collides with one. Duration is always DERIVED from startAt/endAt here,
// never trusted from a client-submitted hours/minutes figure that could
// drift from the actual time range (Law 1).
async function handleCreateTimesheetEntry(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const b = req.body || {};
  const userId = String(b.userId || '').trim();
  if (!userId) return res.status(400).json({ ok: false, error: 'An employee is required.' });
  const jobId = String(b.jobId || '').trim() || null;
  const startAt = String(b.startAt || '').trim();
  const endAt = String(b.endAt || '').trim();
  if (!startAt || !endAt || isNaN(Date.parse(startAt)) || isNaN(Date.parse(endAt))) {
    return res.status(400).json({ ok: false, error: 'A valid start and end time are required.' });
  }
  const startMs = new Date(startAt).getTime();
  const endMs = new Date(endAt).getTime();
  if (endMs <= startMs) return res.status(400).json({ ok: false, error: 'End time must be after start time.' });

  let jobUuid = null;
  let jobTitle = null;
  if (jobId) {
    const jobRes = await supabaseRequest(`jobs?jobber_id=eq.${encodeURIComponent(jobId)}&select=uuid_id,title&limit=1`);
    if (jobRes.ok) { const rows = await jobRes.json(); jobUuid = rows[0]?.uuid_id || null; jobTitle = rows[0]?.title || null; }
  }

  const row = {
    jobber_id: 'HL-TSE-' + crypto.randomUUID(),
    start_at: new Date(startAt).toISOString(),
    end_at: new Date(endAt).toISOString(),
    final_duration: Math.round((endMs - startMs) / 1000),
    user_id: userId,
    job_id: jobId,
    job_uuid: jobUuid,
    note: String(b.note || '').trim() || null,
    jobber_updated_at: new Date().toISOString(),
  };
  const r = await supabaseRequest('time_sheet_entries', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
  if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not save this timesheet entry: ' + (await r.text()).slice(0, 300) });
  const created = (await r.json())[0];
  return res.status(200).json({
    ok: true,
    resource: 'create_timesheet_entry',
    entry: {
      id: created.jobber_id, userId: created.user_id, jobId: created.job_id || null,
      jobLabel: jobId ? (jobTitle || 'Job') : 'General', startAt: created.start_at, endAt: created.end_at,
      durationSeconds: row.final_duration, note: created.note || null,
    },
  });
}

// Editing the Employee is deliberately not offered here (matches the
// Jobber modal jomell is copying, which greys that field out) -- reassigning
// whose hours these are is a bigger action than fixing a time/job/note, and
// nothing in the UI asks for it.
async function handleUpdateTimesheetEntry(req, res) {
  if (req.method !== 'PATCH') return res.status(405).json({ ok: false, error: 'PATCH only' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const b = req.body || {};
  const id = String(b.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'Which entry? No id given.' });
  if (!id.startsWith('HL-TSE-')) {
    return res.status(400).json({ ok: false, error: 'This entry is synced from Jobber -- edit it there.' });
  }
  const jobId = String(b.jobId || '').trim() || null;
  const startAt = String(b.startAt || '').trim();
  const endAt = String(b.endAt || '').trim();
  if (!startAt || !endAt || isNaN(Date.parse(startAt)) || isNaN(Date.parse(endAt))) {
    return res.status(400).json({ ok: false, error: 'A valid start and end time are required.' });
  }
  const startMs = new Date(startAt).getTime();
  const endMs = new Date(endAt).getTime();
  if (endMs <= startMs) return res.status(400).json({ ok: false, error: 'End time must be after start time.' });

  let jobUuid = null;
  let jobTitle = null;
  if (jobId) {
    const jobRes = await supabaseRequest(`jobs?jobber_id=eq.${encodeURIComponent(jobId)}&select=uuid_id,title&limit=1`);
    if (jobRes.ok) { const rows = await jobRes.json(); jobUuid = rows[0]?.uuid_id || null; jobTitle = rows[0]?.title || null; }
  }

  const patch = {
    start_at: new Date(startAt).toISOString(),
    end_at: new Date(endAt).toISOString(),
    final_duration: Math.round((endMs - startMs) / 1000),
    job_id: jobId,
    job_uuid: jobUuid,
    note: String(b.note || '').trim() || null,
    jobber_updated_at: new Date().toISOString(),
  };
  const r = await supabaseRequest(`time_sheet_entries?jobber_id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
  if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not save this timesheet entry: ' + (await r.text()).slice(0, 300) });
  const rows = await r.json();
  if (!rows.length) return res.status(404).json({ ok: false, error: 'That entry no longer exists.' });
  const updated = rows[0];
  return res.status(200).json({
    ok: true,
    resource: 'update_timesheet_entry',
    entry: {
      id: updated.jobber_id, userId: updated.user_id, jobId: updated.job_id || null,
      jobLabel: jobId ? (jobTitle || 'Job') : 'General', startAt: updated.start_at, endAt: updated.end_at,
      durationSeconds: patch.final_duration, note: updated.note || null,
    },
  });
}

async function handleDeleteTimesheetEntry(req, res) {
  if (req.method !== 'DELETE') return res.status(405).json({ ok: false, error: 'DELETE only' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const id = String((req.query && req.query.id) || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'Which entry? No id given.' });
  if (!id.startsWith('HL-TSE-')) {
    return res.status(400).json({ ok: false, error: 'This entry is synced from Jobber -- delete it there.' });
  }
  const r = await supabaseRequest(`time_sheet_entries?jobber_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not delete this entry: ' + (await r.text()).slice(0, 300) });
  return res.status(200).json({ ok: true, resource: 'delete_timesheet_entry' });
}

async function handleMyJobsToday(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const { dateStr, startISO, endISO } = todayRangeET();
  const visits = await fiFetchAllRows(
    'visits',
    '?select=jobber_id,title,start_at,end_at,arrival_window_start,arrival_window_end,visit_status,assigned_users,client_id,job_id' +
      '&end_at=gte.' + encodeURIComponent(startISO) +
      '&start_at=lte.' + encodeURIComponent(endISO) +
      '&order=start_at.asc'
  );
  const myName = String(requester.full_name || '').trim().toLowerCase();
  const mine = [];
  visits.forEach((v) => {
    let assigned = [];
    try {
      assigned = typeof v.assigned_users === 'string' ? JSON.parse(v.assigned_users) : (v.assigned_users || []);
    } catch (e) { assigned = []; }
    const isMine = myName && (assigned || []).some((p) => String(p.name || '').trim().toLowerCase() === myName);
    if (isMine) mine.push(v);
  });
  const clientIds = [...new Set(mine.map((v) => v.client_id).filter(Boolean))];
  const jobIds = [...new Set(mine.map((v) => v.job_id).filter(Boolean))];
  let clientsById = {};
  if (clientIds.length) {
    const r = await supabaseRequest('clients?jobber_id=in.(' + clientIds.join(',') + ')&select=jobber_id,name');
    const list = r.ok ? await r.json() : [];
    clientsById = Object.fromEntries(list.map((c) => [c.jobber_id, c.name]));
  }
  let jobsById = {};
  if (jobIds.length) {
    const r = await supabaseRequest('jobs?jobber_id=in.(' + jobIds.join(',') + ')&select=jobber_id,job_number,title,job_status,jobber_web_uri');
    const list = r.ok ? await r.json() : [];
    jobsById = Object.fromEntries(list.map((j) => [j.jobber_id, j]));
  }
  const jobsOut = mine.map((v) => {
    const job = jobsById[v.job_id] || null;
    return {
      title: v.title,
      clientName: clientsById[v.client_id] || null,
      jobNumber: job ? job.job_number : null,
      jobStatus: job ? job.job_status : null,
      jobberUrl: job ? job.jobber_web_uri : null,
      startAt: v.start_at,
      endAt: v.end_at,
      arrivalWindowStart: v.arrival_window_start,
      arrivalWindowEnd: v.arrival_window_end,
      status: v.visit_status || null,
    };
  });
  return res.status(200).json({
    ok: true,
    resource: 'my_jobs_today',
    date: dateStr,
    employeeName: requester.full_name || null,
    matchedBy: 'name',
    jobs: jobsOut,
    note: myName
      ? 'Matched to your visits by comparing your HiveLogic name to the Jobber-assigned-tech name -- if a job you are on is missing, make sure your full name in HiveLogic matches Jobber exactly.'
      : 'Your HiveLogic profile has no name on file, so jobs cannot be matched to you yet -- set your full name in your profile.',
  });
}
async function handleScheduleRange(req, res) {
  const { startDateStr, endDateStr, startISO, endISO } = rangeParamsET(req);
  const visits = await fiFetchAllRows(
    'visits',
    '?select=jobber_id,title,start_at,end_at,arrival_window_start,arrival_window_end,visit_status,assigned_users,client_id,job_id' +
      '&end_at=gte.' + encodeURIComponent(startISO) +
      '&start_at=lte.' + encodeURIComponent(endISO) +
      '&order=start_at.asc'
  );
  const clientIds = [...new Set(visits.map((v) => v.client_id).filter(Boolean))];
  const jobIds = [...new Set(visits.map((v) => v.job_id).filter(Boolean))];
  // Contact details, not just a name. The Schedule board's job sheet used to
  // print a phone, an email and a street address invented from a hash of the
  // client's name (synthClient(), left over from when that board was a
  // synthetic lab). Real values live here: phone_e164 is populated for 7,434 of
  // 8,690 clients and email for 7,962 -- it is clients.phone, the column an
  // older comment in this file writes off as empty, that has none. Batched into
  // the two round trips already being made rather than fetched per visit.
  let clientsById = {};
  if (clientIds.length) {
    const r = await supabaseRequest('clients?jobber_id=in.(' + clientIds.join(',') + ')&select=jobber_id,name,phone,phone_e164,email');
    const list = r.ok ? await r.json() : [];
    clientsById = Object.fromEntries(list.map((c) => [c.jobber_id, c]));
  }
  // The service address. jobs_enriched carries only city/province/coords, so a
  // street address has to come from client_locations -- the same source
  // Command Center's map pins read.
  let addrByClient = {};
  if (clientIds.length) {
    const r = await supabaseRequest('client_locations?jobber_id=in.(' + clientIds.join(',') + ')&select=jobber_id,street,city,province,postal_code');
    const list = r.ok ? await r.json() : [];
    addrByClient = Object.fromEntries(list.filter((l) => l.street).map((l) => [
      l.jobber_id,
      [l.street, l.city, l.province].filter(Boolean).join(', ') + (l.postal_code ? ' ' + l.postal_code : ''),
    ]));
  }
  let jobsById = {};
  if (jobIds.length) {
    const r = await supabaseRequest('jobs?jobber_id=in.(' + jobIds.join(',') + ')&select=jobber_id,job_number,title,job_status,jobber_web_uri');
    const list = r.ok ? await r.json() : [];
    jobsById = Object.fromEntries(list.map((j) => [j.jobber_id, j]));
  }
  // Geocoords for the map view: jobs_enriched carries geocoded lat/lng + city per job
  // (keyed by the job's jobber_id, same key as visits.job_id). Additive — the crew-row
  // board ignores these; the map uses them. ~98% of jobs are geocoded.
  let geoById = {};
  if (jobIds.length) {
    const r = await supabaseRequest('jobs_enriched?jobber_id=in.(' + jobIds.join(',') + ')&select=jobber_id,gps_lat,gps_lng,loc_city');
    const list = r.ok ? await r.json() : [];
    geoById = Object.fromEntries(list.map((g) => [g.jobber_id, g]));
  }
  const visitsOut = visits.map((v) => {
    let assigned = [];
    try {
      assigned = typeof v.assigned_users === 'string' ? JSON.parse(v.assigned_users) : (v.assigned_users || []);
    } catch (e) { assigned = []; }
    const job = jobsById[v.job_id] || null;
    const geo = geoById[v.job_id] || null;
    const client = clientsById[v.client_id] || null;
    return {
      visitId: v.jobber_id,
      title: v.title,
      clientName: client ? client.name : null,
      clientId: v.client_id || null,
      // Nulls, deliberately, where a client has no number or no address on
      // file. A caller can say "none on file"; it cannot un-invent a value.
      clientPhone: client ? (client.phone_e164 || client.phone || null) : null,
      clientEmail: client ? (client.email || null) : null,
      clientAddress: addrByClient[v.client_id] || null,
      jobNumber: job ? job.job_number : null,
      jobberId: job ? job.jobber_id : null,
      jobStatus: job ? job.job_status : null,
      jobberUrl: job ? job.jobber_web_uri : null,
      startAt: v.start_at,
      endAt: v.end_at,
      arrivalWindowStart: v.arrival_window_start,
      arrivalWindowEnd: v.arrival_window_end,
      status: v.visit_status || null,
      lat: geo && geo.gps_lat != null ? Number(geo.gps_lat) : null,
      lng: geo && geo.gps_lng != null ? Number(geo.gps_lng) : null,
      city: geo ? (geo.loc_city || null) : null,
      assignedTechs: (assigned || [])
        .map((p) => ({ name: p.name || null, jobberId: p.id || null }))
        .filter((p) => p.name || p.jobberId),
    };
  });
  return res.status(200).json({
    ok: true,
    resource: 'schedule_range',
    start: startDateStr,
    end: endDateStr,
    visits: visitsOut,
    count: visitsOut.length,
  });
}
async function handleWorkforceStatus(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const today = todayStr();
  const sessRes = await supabaseRequest(`workforce_time_sessions?employee_id=eq.${requester.id}&status=eq.active&order=clock_in.desc&limit=1`);
  const sessions = sessRes.ok ? await sessRes.json() : [];
  const sumRes = await supabaseRequest(`workforce_daily_summaries?employee_id=eq.${requester.id}&summary_date=eq.${today}&limit=1`);
  const summaries = sumRes.ok ? await sumRes.json() : [];

  // "They're back." This endpoint is polled every 60s by an open tab and is
  // called on every page load, so reaching it is proof the person is still
  // here -- which cancels any pending browser-gone clock-out. A refresh
  // therefore clears its own mark within a second or two, long before the
  // grace window elapses. Fire-and-forget: failing to clear must never break
  // the status call itself; the worst case is one sweep closing a session the
  // person then re-opens.
  const activeSession = (sessions && sessions[0]) || null;
  if (activeSession && activeSession.browser_gone_at) {
    try {
      await supabaseRequest(`workforce_time_sessions?id=eq.${activeSession.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ browser_gone_at: null }),
      });
      activeSession.browser_gone_at = null;
    } catch (e) { /* best effort */ }
  }

  // Why the last clock-in ended, when it ended in a way the person would
  // otherwise have no explanation for.
  //
  // The consent change (PR #364) clocks people out when they decline a prompt
  // their account requires. The server enforces that the moment it deploys; the
  // desktop agent's rewritten dialog -- the one that says declining will clock
  // you out, and pops a box when it does -- only reaches a machine when a NEW
  // AGENT BUILD is published to csk5369/hivelogic-monitor and auto-updates.
  // Until then the old dialog still reads "Not this time" and says nothing, so
  // declining looks like the app randomly clocking you out. That is the exact
  // unexplained-surprise failure this area keeps producing, so the browser
  // explains it too, on the next page load, with no agent release needed.
  //
  // Reported only while it is fresh and only when nobody is on the clock: a
  // decline from last Tuesday is history, and re-announcing it after they have
  // clocked back in would be noise. The client shows it once per session id.
  let lastClosed = null;
  if (!activeSession) {
    const recentRes = await supabaseRequest(
      `workforce_time_sessions?employee_id=eq.${requester.id}&status=eq.completed`
      + `&clock_out=gte.${new Date(Date.now() - CLOSE_NOTICE_WINDOW_MINUTES * 60 * 1000).toISOString()}`
      + `&order=clock_out.desc&limit=1&select=id,clock_out,close_reason`
    );
    const recent = recentRes.ok ? await recentRes.json() : [];
    const row = (recent && recent[0]) || null;
    if (row && CLOSE_REASONS_WORTH_EXPLAINING.includes(row.close_reason)) {
      // The wording travels with the reason so there is exactly one place that
      // says what each one means -- a rule enforced in one file and explained
      // in another is how the two drift apart.
      lastClosed = { id: row.id, clockOut: row.clock_out, closeReason: row.close_reason, notice: closeReasonNotice(row.close_reason) };
    }
  }

  const requesterIsOwner = await isOwner(requester);
  return res.status(200).json({
    ok: true,
    tablesReady: sessRes.ok && sumRes.ok,
    activeSession,
    todaySummary: (summaries && summaries[0]) || null,
    lastClosed,
    // Owners are not on the timeclock. Sent from the server rather than worked
    // out in the page, because the page used to decide this by comparing
    // against a hardcoded email -- true of exactly one person, and silently
    // false the moment ownership changed. The clock-in refusal reads the same
    // source, so the button that is hidden and the request that is refused can
    // never disagree.
    isOwner: requesterIsOwner,
    // Same reasoning, same shape (2026-08-26): the Monitor dashboard's "View
    // All" button needs to know, before it's clicked, whether this person is
    // allowed into the screenshot gallery -- handleMonitorReview enforces
    // the real rule (Superadmin or Owner) server-side; this just lets the
    // button be disabled with an honest reason instead of clickable and
    // then refused.
    canViewScreenshots: requester.role === 'superadmin' || requesterIsOwner,
  });
}

// GET /api/track1?resource=workforce_sweep_gone -- Vercel Cron only (EVERY
// MINUTE, see vercel.json). Closes sessions whose browser went away and never
// came back, backdating the clock-out to the moment it went away so nobody is
// paid for time they weren't working -- and nobody LOSES time to a refresh,
// because a refresh clears the mark long before this runs.
//
// Why every minute rather than every five. The sweep's cadence is the SECOND
// half of how long a closed browser really stays clocked in: the grace below
// sets the floor, the sweep interval sets the ceiling. At */5 the real window
// was anywhere from 5 to 10 minutes depending on where the close landed
// between runs. Observed live on 2026-08-16: Chris closed at 13:44:58, came
// back at 13:50:09 -- past the 5-minute grace -- and kept his session because
// the next sweep was still 7 seconds away. Running every minute makes the
// window 5-6 minutes and means "5 minutes" is roughly what it says. The sweep
// is a single indexed query that no-ops when nothing is marked (partial index,
// see the migration), so the extra runs cost essentially nothing.
//
// CRON_SECRET-gated, same pattern as handleMonitorPrune. Idempotent: it only
// touches sessions that are still active AND still carry a mark older than the
// grace window, so re-running it is harmless.
export const BROWSER_GONE_GRACE_MINUTES = 5;

async function handleWorkforceSweepGone(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!checkCronSecret(authHeader)) return res.status(401).json({ ok: false, error: 'Cron secret required.' });

  const cutoff = new Date(Date.now() - BROWSER_GONE_GRACE_MINUTES * 60 * 1000).toISOString();
  const staleRes = await supabaseRequest(
    `workforce_time_sessions?status=eq.active&browser_gone_at=not.is.null&browser_gone_at=lt.${encodeURIComponent(cutoff)}`,
  );
  if (!staleRes.ok) return res.status(500).json({ ok: false, error: 'Could not read sessions: ' + (await staleRes.text()) });
  const stale = await staleRes.json();

  const closed = [];
  for (const session of stale || []) {
    // Backdate to when the browser actually went away, not to now.
    const patch = {
      clock_out: session.browser_gone_at,
      status: 'completed',
      close_reason: 'browser_closed',
      browser_gone_at: null,
    };
    if (session.on_break && session.break_started_at) {
      const elapsedSeconds = Math.max(0, Math.round((new Date(session.browser_gone_at).getTime() - new Date(session.break_started_at).getTime()) / 1000));
      patch.on_break = false;
      patch.break_started_at = null;
      patch.total_break_seconds = (session.total_break_seconds || 0) + elapsedSeconds;
    }
    const updRes = await supabaseRequest(`workforce_time_sessions?id=eq.${session.id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (updRes.ok) closed.push({ sessionId: session.id, clockOut: session.browser_gone_at });
  }
  return res.status(200).json({ ok: true, graceMinutes: BROWSER_GONE_GRACE_MINUTES, considered: (stale || []).length, closed });
}

async function handleWorkforceClock(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const action = (req.body && req.body.action) || '';
  if (action === 'in') {
    // Owners are not on the timeclock. Refused HERE and not merely hidden in
    // the UI: the End-of-Day exemption was frontend-only once (2026-08-16) and
    // produced a clock-out that could neither be completed nor satisfied,
    // because the server half had never heard of it.
    //
    // This is also what keeps owners unmonitored. Monitoring only runs during a
    // clock-in, so no clock-in means no consent prompt, no recording, and no
    // idle timeout -- one rule instead of four that each have to be remembered.
    if (await isOwner(requester)) {
      return res.status(200).json({ ok: false, isOwner: true, error: OWNER_NO_CLOCK_IN_MESSAGE });
    }
    const openRes = await supabaseRequest(`workforce_time_sessions?employee_id=eq.${requester.id}&status=eq.active&limit=1`);
    if (!openRes.ok) return res.status(200).json({ ok: false, error: 'Workforce tables are not set up yet in Supabase.' });
    const open = await openRes.json();
    if (open && open[0]) return res.status(200).json({ ok: true, session: open[0], note: 'Already clocked in.' });
    const insRes = await supabaseRequest('workforce_time_sessions', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ employee_id: requester.id, clock_in: new Date().toISOString(), status: 'active' }),
    });
    if (!insRes.ok) return res.status(500).json({ ok: false, error: 'Could not clock in: ' + (await insRes.text()) });
    const rows = await insRes.json();
    return res.status(200).json({ ok: true, session: rows[0] });
  }
  if (action === 'out') {
    const openRes = await supabaseRequest(`workforce_time_sessions?employee_id=eq.${requester.id}&status=eq.active&order=clock_in.desc&limit=1`);
    if (!openRes.ok) return res.status(200).json({ ok: false, error: 'Workforce tables are not set up yet in Supabase.' });
    const open = await openRes.json();
    if (!open || !open[0]) return res.status(400).json({ ok: false, error: 'No active session to clock out of.' });
    if (open[0].on_break) return res.status(200).json({ ok: false, error: 'End your break before clocking out.' });
    const today = todayStr();
    // The Owner can clock out without an End-of-Day report; everyone else --
    // including the other admin/superadmin accounts -- still has to submit one.
    //
    // This MUST mirror hlWfIsOwner in public/index.html (workforceClockOut).
    // Bug (Chris, 2026-08-16): the exemption existed only on the frontend, so
    // the Owner's clock-out sailed past the browser check and was then refused
    // HERE, by a branch that has no idea the EOD form exists. The result was a
    // clock-out that could not be completed and could not be satisfied: the
    // toast asked for a report, but because the client-side branch (the only
    // one that navigates to the form) had been skipped, nothing ever appeared.
    //
    // WAS a hardcoded email, because `superadmin` also covers Jomell, who does
    // submit EOD reports, so gating on the login role would have exempted
    // people this rule is meant to cover. That reasoning was right about the
    // login role and wrong about roles in general: employee_roles
    // .permission_roles already carries 'owner' as a distinct job function,
    // held by Chris and Lori and by nobody else. One name in source could only
    // ever be true of one person, and silently stopped being true the moment
    // ownership changed.
    //
    // Owners no longer reach this branch at all in the normal case -- they
    // cannot clock in, so there is nothing to clock out of. It stays for
    // sessions that predate the rule, which is exactly the situation on the
    // day it ships.
    const requesterIsOwner = await isOwner(requester);
    if (!requesterIsOwner) {
      const sumRes = await supabaseRequest(`workforce_daily_summaries?employee_id=eq.${requester.id}&summary_date=eq.${today}&limit=1`);
      const sumRows = sumRes.ok ? await sumRes.json() : [];
      if (!sumRows || !sumRows[0]) return res.status(200).json({ ok: false, error: 'Please submit your End-of-Day report before clocking out.', needsEodReport: true });
    }
    // Manual clock-out (2026-08-25): "if the employee was not able to clock
    // out, the system must prompt the employee to input manual clock out."
    // manualClockOutAt is an ISO timestamp the browser already resolved from
    // a date+time the person typed (see hlWorkforceManualClockOutOpen).
    // Validated server-side, not just in the form: cannot predate this
    // session's own clock_in, cannot be in the future -- the server stays
    // the source of truth for recorded work time, a typed time is not
    // trusted blind.
    const patch = { status: 'completed' };
    if (req.body && req.body.manualClockOutAt) {
      const manualMs = new Date(req.body.manualClockOutAt).getTime();
      if (!Number.isFinite(manualMs)) return res.status(400).json({ ok: false, error: 'That clock-out time is not valid.' });
      const clockInMs = new Date(open[0].clock_in).getTime();
      if (manualMs < clockInMs) return res.status(400).json({ ok: false, error: 'Clock-out time cannot be before you clocked in.' });
      if (manualMs > Date.now() + 60000) return res.status(400).json({ ok: false, error: 'Clock-out time cannot be in the future.' });
      patch.clock_out = new Date(manualMs).toISOString();
      patch.close_reason = 'manual_entry';
    } else {
      patch.clock_out = new Date().toISOString();
    }
    const updRes = await supabaseRequest(`workforce_time_sessions?id=eq.${open[0].id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    if (!updRes.ok) return res.status(500).json({ ok: false, error: 'Could not clock out: ' + (await updRes.text()) });
    const rows = await updRes.json();
    return res.status(200).json({ ok: true, session: rows[0] });
  }
  return res.status(400).json({ ok: false, error: 'action must be "in" or "out".' });
}

async function handleWorkforceBreak(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const action = (req.body && req.body.action) || '';
  const openRes = await supabaseRequest(`workforce_time_sessions?employee_id=eq.${requester.id}&status=eq.active&order=clock_in.desc&limit=1`);
  if (!openRes.ok) return res.status(200).json({ ok: false, error: 'Workforce tables are not set up yet in Supabase.' });
  const open = await openRes.json();
  if (!open || !open[0]) return res.status(400).json({ ok: false, error: 'You need to clock in before taking a break.' });
  const session = open[0];
  if (action === 'start') {
    if (session.on_break) return res.status(200).json({ ok: true, session: session, note: 'Already on break.' });
    const updRes = await supabaseRequest(`workforce_time_sessions?id=eq.${session.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ on_break: true, break_started_at: new Date().toISOString() }),
    });
    if (!updRes.ok) return res.status(500).json({ ok: false, error: 'Could not start break: ' + (await updRes.text()) });
    const rows = await updRes.json();
    return res.status(200).json({ ok: true, session: rows[0] });
  }
  if (action === 'end') {
    if (!session.on_break || !session.break_started_at) return res.status(400).json({ ok: false, error: 'Not currently on break.' });
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(session.break_started_at).getTime()) / 1000));
    const newTotal = (session.total_break_seconds || 0) + elapsedSeconds;
    const updRes = await supabaseRequest(`workforce_time_sessions?id=eq.${session.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ on_break: false, break_started_at: null, total_break_seconds: newTotal }),
    });
    if (!updRes.ok) return res.status(500).json({ ok: false, error: 'Could not end break: ' + (await updRes.text()) });
    const rows = await updRes.json();
    return res.status(200).json({ ok: true, session: rows[0] });
  }
  return res.status(400).json({ ok: false, error: 'action must be "start" or "end".' });
}

// --- Browser-close auto-clockout safety net -- Chris: "if they close out
// the browser with HiveLogic, it logs them out for their timeclock." Fired
// by a pagehide handler in index.html via navigator.sendBeacon(), which
// can't set an Authorization header -- see the body.access_token fallback in
// getRequestingProfile() above. Marked close_reason='browser_closed' (not a
// normal manual clock-out) and deliberately skips the "submit your EOD
// report first" requirement, since the whole point is this fires when
// nobody is there to submit one. The office manager can see who owes a
// report from close_reason.
async function handleWorkforceAutoClockout(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  // Chris: idle-timeout auto-clockout (30 min idle warning, 15 min grace,
  // then auto clock-out) reuses this same safety-net endpoint as the
  // browser-close case, distinguished only by close_reason.
  const acReqBody = req.body || {};
  const closeReason = ['browser_closed', 'idle_timeout'].includes(acReqBody.reason) ? acReqBody.reason : 'browser_closed';
  const openRes = await supabaseRequest(`workforce_time_sessions?employee_id=eq.${requester.id}&status=eq.active&order=clock_in.desc&limit=1`);
  if (!openRes.ok) return res.status(200).json({ ok: true, note: 'Workforce tables not ready.' });
  const open = await openRes.json();
  if (!open || !open[0]) return res.status(200).json({ ok: true, note: 'No active session -- nothing to do.' });
  const session = open[0];

  // Browser went away: MARK, don't close (Chris, 2026-08-16).
  //
  // `pagehide` fires on a refresh exactly as it does on a real close, and the
  // browser cannot tell you which happened. Closing here would clock someone
  // out every time they hit refresh. So record the moment and let
  // workforce_sweep_gone decide, backdated to this timestamp, once the grace
  // window has passed with nobody coming back. A refresh reappears within
  // seconds and clears the mark (see handleWorkforceStatus), so it costs
  // nobody any time; a genuine close still gets an accurate clock-out rather
  // than one rounded up to whenever the sweep happened to notice.
  //
  // The idle-timeout caller is unchanged and still closes immediately -- it
  // already knows the person is gone, having watched them do nothing for 30
  // minutes.
  //
  // MARKING IS THE DEFAULT, and deliberately so. Only an explicit
  // 'idle_timeout' closes on the spot. A beacon that arrives with NO reason is
  // an OLD CACHED PAGE -- this endpoint was 401'd at the edge for fifteen days,
  // so every still-open tab in the company is running pre-fix JavaScript that
  // sends no reason at all. Treating those as an immediate close would clock
  // those people out on their next refresh: precisely the bug this change
  // exists to prevent, aimed at everyone except the person who reloaded first.
  // Defaulting to the grace path costs nothing (the sweep still closes a real
  // close five minutes later) and cannot cost anyone their time.
  if (acReqBody.reason !== 'idle_timeout') {
    const markRes = await supabaseRequest(`workforce_time_sessions?id=eq.${session.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ browser_gone_at: new Date().toISOString() }),
    });
    if (!markRes.ok) return res.status(500).json({ ok: false, error: 'Could not record browser-gone: ' + (await markRes.text()) });
    return res.status(200).json({ ok: true, marked: true, note: 'Browser gone -- clock-out pending the grace window.' });
  }
  const patch = { clock_out: new Date().toISOString(), status: 'completed', close_reason: closeReason };
  if (session.on_break && session.break_started_at) {
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(session.break_started_at).getTime()) / 1000));
    patch.on_break = false;
    patch.break_started_at = null;
    patch.total_break_seconds = (session.total_break_seconds || 0) + elapsedSeconds;
  }
  const updRes = await supabaseRequest(`workforce_time_sessions?id=eq.${session.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!updRes.ok) return res.status(500).json({ ok: false, error: 'Could not close session: ' + (await updRes.text()) });
  // Best-effort: also close any still-open Monitor session tied to this
  // clock-in so screenshots/activity stop the instant the timeclock does.
  try {
    const monRes = await supabaseRequest(`monitor_sessions?workforce_session_id=eq.${session.id}&ended_at=is.null`);
    if (monRes.ok) {
      const monSessions = await monRes.json();
      for (const m of (monSessions || [])) {
        await supabaseRequest(`monitor_sessions?id=eq.${m.id}`, { method: 'PATCH', body: JSON.stringify({ ended_at: new Date().toISOString() }) });
      }
    }
  } catch (e) { /* never block the clock-out on this */ }
  return res.status(200).json({ ok: true, closed: true, closeReason: 'browser_closed' });
}

// --- HiveLogic Monitor -- the WebWork replacement's desktop screen/activity
// tracker (schema: sql/ hivelogic_monitor_schema migration, applied
// directly). A small desktop agent (Electron, Windows + Mac) pairs itself to
// an employee via a short-lived 6-digit code generated from the browser,
// then authenticates every call after that with its own long-lived
// agent_token -- never the employee's login token. It only captures while
// the employee is actually clocked in (checked server-side on every
// heartbeat, not trusted from the agent) and the agent additionally applies
// its own business-hours window on top of that.
// Pairing codes + agent tokens both come from a CSPRNG (see api/_lib/monitor.js);
// tokens are only ever persisted as SHA-256 hashes. getRequestingAgent hashes
// the presented bearer token and looks it up by hash, so a leaked
// monitor_agents row cannot be replayed to impersonate a device.
const monitorRandomCode = generatePairingCode;
const monitorRandomToken = generateAgentToken;

async function getRequestingAgent(req) {
  return requireMonitorAgent(req);
}

// How long since a Monitor agent's last heartbeat before we stop calling it
// running. It heartbeats every 60s, so this is 15 missed beats -- generous
// enough for a sleeping laptop, far short of the two weeks that went unnoticed.
export const MONITOR_AGENT_ALIVE_MINUTES = 15;

// The four resources the HiveLogic Monitor desktop agent posts to
// (hivelogic-monitor-agent/src/main.js). They carry the agent's own hashed
// bearer token rather than a Supabase session, so they must be exempt from
// BOTH gates: the edge middleware (guard.js PUBLIC_RESOURCE_PATHS) and this
// file's handler-level requireApiAuth. Exempting only one leaves the agent
// dead -- which is exactly what happened between #262 and #2xx on 2026-08-16.
// Keep this list, the guard allowlist, and the agent's own fetches in step.
export const MONITOR_AGENT_RESOURCES = [
  'monitor_pair',
  'monitor_heartbeat',
  'monitor_consent',
  'monitor_screenshot_upload',
  // Phase 5 (2026-08-25): the agent reads the app whitelist here to
  // classify the active app locally. handleMonitorAppRules still gates
  // writes to an admin session itself (see requester check inside it) --
  // this exemption only lets a GET carry an agent token instead of a
  // Supabase session, same as the four resources above.
  'monitor_app_rules',
];

// One roster row per PERSON, never per device (2026-08-26). Re-pairing used
// to insert a brand-new monitor_agents row and simply leave the previous
// 'active' one in place -- "Unpair this device" in the tray menu only ever
// cleared the desktop app's local config, it never told the server. Marvin
// re-pairing after unpairing left two 'Paired' rows for the same name in
// both the Monitor Settings roster and the dashboard's Activity & Screenshot
// Review table, with nothing distinguishing them. handleMonitorPair now
// revokes the old row the moment a new pairing completes (see below), so
// this only has historical duplicates left to collapse -- most-recently-
// paired active row wins, then most recent pending, then whatever's left.
function pickBestMonitorAgent(rows) {
  if (!rows || !rows.length) return null;
  const byPairedDesc = (a, b) => (b.paired_at || '').localeCompare(a.paired_at || '');
  const active = rows.filter((a) => a.status === 'active');
  if (active.length) return active.sort(byPairedDesc)[0];
  const pending = rows.filter((a) => a.status === 'pending');
  if (pending.length) return pending.sort(byPairedDesc)[0];
  return rows.slice().sort(byPairedDesc)[0];
}

async function handleMonitorStatus(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  const activeRes = await supabaseRequest(`monitor_agents?employee_id=eq.${requester.id}&status=eq.active&order=paired_at.desc&limit=1`);
  const active = activeRes.ok ? await activeRes.json() : [];
  if (active && active[0]) {
    // PAIRED IS NOT RUNNING (Chris, 2026-08-16). status='active' only means a
    // pairing was completed and never revoked -- it stays 'active' forever
    // whether or not the desktop app has run since. The frontend used to read
    // `paired` alone and announce "HiveLogic Monitor is active for this
    // session -- activity records while you're clocked in", which was flatly
    // untrue for two weeks while Chris's agent had not checked in once
    // (last_seen_at frozen at 2026-08-02). Same class as the Monitor tab
    // showing green: claiming a state nothing verified. Law 1.
    //
    // The agent heartbeats every 60s while running, so anything past a few
    // minutes means it is not running -- not that it is briefly busy. 15
    // minutes is generous enough to absorb a sleeping laptop or a slow
    // network without ever calling a dead agent alive.
    const lastSeenAt = active[0].last_seen_at || null;
    const staleMinutes = lastSeenAt
      ? Math.round((Date.now() - new Date(lastSeenAt).getTime()) / 60000)
      : null;
    const alive = staleMinutes !== null && staleMinutes <= MONITOR_AGENT_ALIVE_MINUTES;
    return res.status(200).json({
      ok: true,
      paired: true,
      alive,
      staleMinutes,
      agent: { deviceName: active[0].device_name, platform: active[0].platform, pairedAt: active[0].paired_at, lastSeenAt },
    });
  }
  return res.status(200).json({ ok: true, paired: false, alive: false, staleMinutes: null, agent: null });
}

async function handleMonitorPairingCode(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  const pendingRes = await supabaseRequest(`monitor_agents?employee_id=eq.${requester.id}&status=eq.pending`);
  if (pendingRes.ok) {
    const pending = await pendingRes.json();
    for (const p of (pending || [])) {
      await supabaseRequest(`monitor_agents?id=eq.${p.id}`, { method: 'DELETE' });
    }
  }
  const code = monitorRandomCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const insRes = await supabaseRequest('monitor_agents', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ employee_id: requester.id, pairing_code: code, pairing_code_expires_at: expiresAt, status: 'pending' }),
  });
  if (!insRes.ok) return res.status(500).json({ ok: false, error: 'Could not generate a pairing code: ' + (await insRes.text()) });
  return res.status(200).json({ ok: true, pairingCode: code, expiresAt });
}

async function handleMonitorPair(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });

  // Flat rate limit: no more than 15 pairing attempts from the same IP in
  // 10 minutes, independent of which email/code is being tried.
  const ipHeader = req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown';
  const ip = String(ipHeader).split(',')[0].trim();
  const windowStart = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const attemptsRes = await supabaseRequest(`monitor_pair_attempts?ip=eq.${encodeURIComponent(ip)}&attempted_at=gte.${windowStart}&select=id`);
  const priorAttempts = attemptsRes.ok ? await attemptsRes.json() : [];
  if (priorAttempts && priorAttempts.length >= 15) {
    return res.status(429).json({ ok: false, error: 'Too many pairing attempts from this network -- try again in a few minutes.' });
  }
  await supabaseRequest('monitor_pair_attempts', { method: 'POST', body: JSON.stringify({ ip }) });

  const { pairingCode, email, deviceName, platform, agentVersion } = req.body || {};
  if (!pairingCode || !email) return res.status(400).json({ ok: false, error: 'pairingCode and email are required.' });
  if (!['windows', 'mac'].includes(platform)) return res.status(400).json({ ok: false, error: 'platform must be "windows" or "mac".' });
  const profRes = await supabaseRequest(`profiles?email=eq.${encodeURIComponent(String(email).trim().toLowerCase())}&select=id,email`);
  if (!profRes.ok) return res.status(500).json({ ok: false, error: 'Could not look up that account.' });
  const profRows = await profRes.json();
  if (!profRows || !profRows[0]) return res.status(404).json({ ok: false, error: 'No HiveLogic account found for that email.' });
  const employeeId = profRows[0].id;

  // Look up this employee's current pending code regardless of whether the
  // submitted code matches yet -- that's what lets a wrong guess count
  // against it below, capping brute-force attempts at 5 per code instead of
  // leaving a 6-digit code guessable for the whole 15-minute window.
  const pendingRes = await supabaseRequest(`monitor_agents?employee_id=eq.${employeeId}&status=eq.pending&order=created_at.desc&limit=1`);
  if (!pendingRes.ok) return res.status(500).json({ ok: false, error: 'Could not verify the pairing code.' });
  const pendingRows = await pendingRes.json();
  const pendingRow = pendingRows && pendingRows[0];
  if (!pendingRow) return res.status(400).json({ ok: false, error: 'That pairing code is invalid or already used.' });

  if (new Date(pendingRow.pairing_code_expires_at).getTime() < Date.now()) {
    return res.status(400).json({ ok: false, error: 'That pairing code expired -- generate a new one in HiveLogic and try again.' });
  }

  if (String(pendingRow.pairing_code) !== String(pairingCode).trim()) {
    const newAttempts = (pendingRow.pair_attempts || 0) + 1;
    if (newAttempts >= 5) {
      await supabaseRequest(`monitor_agents?id=eq.${pendingRow.id}`, { method: 'DELETE' });
      return res.status(400).json({ ok: false, error: 'Too many wrong codes -- generate a new pairing code in HiveLogic and try again.' });
    }
    await supabaseRequest(`monitor_agents?id=eq.${pendingRow.id}`, { method: 'PATCH', body: JSON.stringify({ pair_attempts: newAttempts }) });
    return res.status(400).json({ ok: false, error: 'That pairing code is incorrect.' });
  }

  // Revoke any OTHER already-active agent this employee has before this one
  // takes over -- one device is meant to be "the" paired device per person.
  // Without this, unpairing locally (which never tells the server, see the
  // tray menu's "Unpair this device") followed by re-pairing left the old
  // row 'active' forever, showing up as a second, permanently-offline
  // "Paired" row next to the real one. Fire-and-forget: this pairing must
  // not fail because the cleanup of an old row did.
  supabaseRequest(`monitor_agents?employee_id=eq.${employeeId}&status=eq.active&id=neq.${pendingRow.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'revoked' }),
  }).catch(() => {});

  const token = monitorRandomToken();
  const updRes = await supabaseRequest(`monitor_agents?id=eq.${pendingRow.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'active',
      platform,
      device_name: deviceName || null,
      agent_version: agentVersion || null,
      // Store only the SHA-256 hash; clear any legacy plaintext token column.
      agent_token_hash: hashAgentToken(token),
      agent_token: null,
      paired_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      pairing_code: null,
      pairing_code_expires_at: null,
      pair_attempts: 0,
    }),
  });
  if (!updRes.ok) return res.status(500).json({ ok: false, error: 'Could not complete pairing: ' + (await updRes.text()) });
  return res.status(200).json({ ok: true, agentToken: token });
}

async function handleMonitorHeartbeat(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const agent = await getRequestingAgent(req);
  if (!agent) return res.status(401).json({ ok: false, error: 'Unknown or revoked agent token.' });
  // The version rides the PATCH that already runs on every heartbeat, so this
  // costs nothing extra. Only recorded when it looks like a build we would have
  // shipped -- a malformed or forged value must not overwrite a real
  // observation, and an agent too old to report one leaves the column NULL,
  // which reads as 'unknown' rather than being guessed at.
  const heartbeatPatch = { last_seen_at: new Date().toISOString() };
  const reportedVersion = req.body && req.body.agentVersion;
  // What the SERVER actually received, echoed back verbatim. On 2026-08-18 a
  // confirmed-installed 1.2.5 agent -- sending app.getVersion() on every
  // heartbeat, with the server code to store it demonstrably correct -- left
  // the column NULL for hours. Every link checked out on paper, which is
  // exactly when you stop reasoning and make the wire say what it carried.
  // Distinguishes "the agent never sent one" from "the write did not land":
  // null here means the body arrived without it.
  const agentVersionSeen = typeof reportedVersion === 'string' ? reportedVersion : null;
  if (isWellFormedAgentVersion(reportedVersion) && reportedVersion !== agent.agent_version) {
    heartbeatPatch.agent_version = reportedVersion;
  }
  // The result of this write is CHECKED. It used to be a bare await, and a
  // PostgREST rejection -- a column that is not there, a type mismatch, a
  // policy -- returned a 4xx that nothing read, so the heartbeat answered 200
  // and the row silently did not move. On 2026-08-18 Chris's agent was on
  // 1.2.5, sending its version every 60 seconds, and the roster still said
  // "version unknown": the agent was right, the server was right, and the one
  // step between them could fail without leaving a mark anywhere.
  //
  // Reported in the response rather than thrown, because a failed bookkeeping
  // write must not take down a heartbeat that is otherwise fine -- but it must
  // not pass for success either. The agent surfaces it in the tray.
  const patchRes = await supabaseRequest(`monitor_agents?id=eq.${agent.id}`, { method: 'PATCH', body: JSON.stringify(heartbeatPatch) });
  const heartbeatWriteError = patchRes && patchRes.ok
    ? null
    : `monitor_agents PATCH failed (${(patchRes && patchRes.status) || 'no response'}): ${patchRes ? await patchRes.text().catch(() => '') : ''}`.slice(0, 300);

  // Timezone auto-detection (2026-08-26): "make it flexible so anyone who
  // will be monitored regardless of the location and timezone... the
  // system must automatically detect my location and timezone." The agent
  // reports its OS's real IANA zone on every heartbeat; kept on
  // profiles.settings (the one per-user preferences blob, api/user-settings.js
  // -- follows the PERSON, not the device, per CLAUDE.md). Always
  // overwritten with the latest report rather than set once, so it stays
  // correct if someone travels. isValidTimeZone guards against a garbled or
  // forged value ever reaching Intl elsewhere. Best-effort: this must never
  // take down an otherwise-fine heartbeat.
  const reportedTimezone = req.body && req.body.timezone;
  if (isValidTimeZone(reportedTimezone)) {
    try {
      const profRes = await supabaseRequest(`profiles?id=eq.${agent.employee_id}&select=settings`);
      const profRows = profRes.ok ? await profRes.json() : [];
      const currentSettings = (profRows[0] && profRows[0].settings) || {};
      if (currentSettings.timezone !== reportedTimezone) {
        await supabaseRequest(`profiles?id=eq.${agent.employee_id}`, {
          method: 'PATCH',
          body: JSON.stringify({ settings: mergeSettings(currentSettings, { timezone: reportedTimezone }) }),
        });
      }
    } catch (e) { /* best-effort -- never blocks the heartbeat */ }
  }

  const activeRes = await supabaseRequest(`workforce_time_sessions?employee_id=eq.${agent.employee_id}&status=eq.active&order=clock_in.desc&limit=1`);
  const activeRows = activeRes.ok ? await activeRes.json() : [];
  const workforceSession = (activeRows && activeRows[0]) || null;

  const openMonRes = await supabaseRequest(`monitor_sessions?agent_id=eq.${agent.id}&ended_at=is.null&order=started_at.desc&limit=1`);
  const openMonRows = openMonRes.ok ? await openMonRes.json() : [];
  let monitorSession = (openMonRows && openMonRows[0]) || null;

  if (!workforceSession) {
    if (monitorSession) {
      await supabaseRequest(`monitor_sessions?id=eq.${monitorSession.id}`, { method: 'PATCH', body: JSON.stringify({ ended_at: new Date().toISOString() }) });
    }
    return res.status(200).json({ ok: true, clockedIn: false, shouldCapture: false, heartbeatWriteError, agentVersionSeen });
  }

  if (!monitorSession || monitorSession.workforce_session_id !== workforceSession.id) {
    if (monitorSession) {
      await supabaseRequest(`monitor_sessions?id=eq.${monitorSession.id}`, { method: 'PATCH', body: JSON.stringify({ ended_at: new Date().toISOString() }) });
    }
    const insRes = await supabaseRequest('monitor_sessions', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ employee_id: agent.employee_id, agent_id: agent.id, workforce_session_id: workforceSession.id }),
    });
    const insRows = insRes.ok ? await insRes.json() : [];
    monitorSession = (insRows && insRows[0]) || null;
  }
  if (!monitorSession) return res.status(500).json({ ok: false, error: 'Could not open a monitor session.' });

  const body = req.body || {};

  // Chris: "when you clock in it HAS to notify you and you should also be
  // allowed to deny it access each time." Capture only happens once the
  // agent has gotten an explicit 'allowed' answer for THIS clock-in's
  // monitor session (see handleMonitorConsent below) -- a fresh clock-in
  // always opens a new monitor_sessions row that starts 'pending', so this
  // prompt fires every time, not just once ever.
  const consent = monitorSession.consent || 'pending';

  // Both per-user permissions, read BEFORE anything is written. The order
  // matters and used to be the other way round: activity samples were inserted
  // above this lookup, so they recorded regardless of the answer. Declining
  // stopped the screenshots and nothing else, and the admin off-switch was just
  // as hollow -- Chris's 2026-08-17 06:33 session was declined and still logged
  // 176 samples over three hours. See api/_lib/monitor-consent.js.
  const empRes = await supabaseRequest(`profiles?id=eq.${agent.employee_id}&select=monitoring_enabled`);
  const empRows = empRes.ok ? await empRes.json() : [];
  const decision = monitoringDecision(empRows[0], consent);
  const monitoringEnabled = decision.enabled;

  // Declined by someone whose account requires it: the clock-in ends here.
  // Handled in handleMonitorConsent the instant they answer; repeated here
  // because a heartbeat can arrive first if that write raced or failed, and a
  // session left open in this state would be exactly the silent gap between
  // policy and reality this change exists to close.
  if (decision.clockOut) {
    await endClockInForDeclinedMonitoring(agent.employee_id, monitorSession.id);
    return res.status(200).json({ ok: true, clockedIn: false, shouldCapture: false, consent, clockedOutForDecline: true, heartbeatWriteError, agentVersionSeen });
  }

  // Nothing is recorded without an explicit yes. 'pending' records nothing
  // either -- the dialog is still on screen, and treating silence as agreement
  // is the same broken promise in a smaller window.
  if (decision.recordActivity) {
    await supabaseRequest('monitor_activity_samples', {
      method: 'POST',
      body: JSON.stringify({
        monitor_session_id: monitorSession.id,
        activity_level: Math.max(0, Math.min(100, Number(body.activityLevel) || 0)),
        idle_seconds: Math.max(0, Number(body.idleSeconds) || 0),
        active_app: body.activeApp ? String(body.activeApp).slice(0, 200) : null,
        display_count: Number.isFinite(Number(body.displayCount)) ? Number(body.displayCount) : null,
      }),
    });
  }

  const mSettingsRes = await supabaseRequest('workforce_settings?limit=1');
  const mSettingsRows = mSettingsRes.ok ? await mSettingsRes.json() : [];
  const mSettingsRow = mSettingsRows[0] || {};
  const screenshotIntervalMinutes = Number.isFinite(mSettingsRow.monitor_screenshot_interval_minutes) ? mSettingsRow.monitor_screenshot_interval_minutes : 5;
  const blurScreenshots = mSettingsRow.monitor_blur_screenshots === true;

  return res.status(200).json({
    ok: true,
    clockedIn: true,
    shouldCapture: decision.captureScreenshots,
    consent: consent,
    monitorSessionId: monitorSession.id,
    monitoringEnabled: monitoringEnabled,
    // Lets the agent say what declining will actually cost before it asks.
    monitoringRequired: decision.required,
    screenshotIntervalMinutes: screenshotIntervalMinutes,
    blurScreenshots: blurScreenshots,
    heartbeatWriteError,
    agentVersionSeen,
  });
}

// Ends a clock-in because the employee declined monitoring and their account
// requires it. Closes the monitor session too, so nothing is left looking live.
//
// Written as its own function because two paths reach it -- the consent answer
// itself, and a heartbeat that finds the session already declined -- and both
// must do exactly the same thing. close_reason keeps a decline distinguishable
// from an idle timeout or a browser close when someone reads the timesheet.
async function endClockInForDeclinedMonitoring(employeeId, monitorSessionId) {
  const nowIso = new Date().toISOString();
  if (monitorSessionId) {
    await supabaseRequest(`monitor_sessions?id=eq.${monitorSessionId}&ended_at=is.null`, {
      method: 'PATCH',
      body: JSON.stringify({ ended_at: nowIso }),
    });
  }
  const openRes = await supabaseRequest(`workforce_time_sessions?employee_id=eq.${employeeId}&status=eq.active&order=clock_in.desc&limit=1`);
  const open = openRes.ok ? await openRes.json() : [];
  if (!open || !open[0]) return false;
  await supabaseRequest(`workforce_time_sessions?id=eq.${open[0].id}`, {
    method: 'PATCH',
    body: JSON.stringify({ clock_out: nowIso, status: 'completed', close_reason: CLOSE_REASON_DECLINED }),
  });
  return true;
}

// Records the employee's allow/deny answer to the per-clock-in monitoring
// consent prompt shown by the desktop agent. Only the paired agent itself
// can call this (agent_token auth), and only for a monitor session that is
// still open and belongs to it -- never lets one device answer for another.
async function handleMonitorConsent(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const agent = await getRequestingAgent(req);
  if (!agent) return res.status(401).json({ ok: false, error: 'Unknown or revoked agent token.' });
  const { monitorSessionId, allow } = req.body || {};
  if (!monitorSessionId) return res.status(400).json({ ok: false, error: 'monitorSessionId is required.' });
  const sessRes = await supabaseRequest(`monitor_sessions?id=eq.${monitorSessionId}&agent_id=eq.${agent.id}&ended_at=is.null&limit=1`);
  const sessRows = sessRes.ok ? await sessRes.json() : [];
  if (!sessRows || !sessRows[0]) return res.status(403).json({ ok: false, error: 'That monitor session is not open for this agent.' });
  const consent = allow ? 'allowed' : 'denied';
  const updRes = await supabaseRequest(`monitor_sessions?id=eq.${monitorSessionId}`, { method: 'PATCH', body: JSON.stringify({ consent }) });
  if (!updRes.ok) return res.status(500).json({ ok: false, error: 'Could not record consent: ' + (await updRes.text()) });

  // Chris, 2026-08-17: "if an employee is clocked in they must approve
  // monitoring or it can't clock in." Enforced as "cannot stay clocked in" --
  // consent is asked after the clock-in exists, and blocking the clock-in
  // itself would stop anyone working while the desktop app was closed or
  // updating, turning a monitoring outage into a payroll one. Per-user, via
  // profiles.monitoring_enabled; see api/_lib/monitor-consent.js.
  if (!allow) {
    const empRes = await supabaseRequest(`profiles?id=eq.${agent.employee_id}&select=monitoring_enabled`);
    const empRows = empRes.ok ? await empRes.json() : [];
    const { required } = monitoringPolicy(empRows[0]);
    if (required) {
      const clockedOut = await endClockInForDeclinedMonitoring(agent.employee_id, monitorSessionId);
      return res.status(200).json({ ok: true, consent, clockedOut, monitoringRequired: true });
    }
  }
  return res.status(200).json({ ok: true, consent, clockedOut: false, monitoringRequired: false });
}

// Company-wide workforce settings (end-of-day clock-out prompt time, idle
// auto-clockout thresholds). Any signed-in employee can read this -- it
// only drives client-side timers in the browser, nothing sensitive in it.
async function handleWorkforceSettings(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  const settingsRes = await supabaseRequest('workforce_settings?limit=1');
  const settingsRows = settingsRes.ok ? await settingsRes.json() : [];
  const row = (settingsRows && settingsRows[0]) || {};
  return res.status(200).json({
    ok: true,
    // Monitored workday window: 7:00 AM - 3:30 PM. One shared wall-clock
    // schedule (2026-08-26: "make it flexible... regardless of the location
    // and timezone"), applied in EACH EMPLOYEE'S OWN timezone, not a single
    // hardcoded America/New_York -- see api/_lib/workday.js and
    // hlWfNowInTz() (public/index.html), which now take a zone parameter
    // instead of assuming one.
    workdayStartHour: Number.isFinite(row.workday_start_hour) ? row.workday_start_hour : 7,
    workdayStartMinute: Number.isFinite(row.workday_start_minute) ? row.workday_start_minute : 0,
    workdayEndHour: Number.isFinite(row.workday_end_hour) ? row.workday_end_hour : 15,
    workdayEndMinute: Number.isFinite(row.workday_end_minute) ? row.workday_end_minute : 30,
    idleWarningMinutes: Number.isFinite(row.idle_warning_minutes) ? row.idle_warning_minutes : 30,
    idleAutoClockoutGraceMinutes: Number.isFinite(row.idle_autoclockout_grace_minutes) ? row.idle_autoclockout_grace_minutes : 15,
  });
}

// Admin-only: Monitor settings (screenshot interval, blur) + per-employee
// monitoring on/off roster. Chris: "the monitor needs settings -- how often
// the screenshots are, if they get blurred, toggle monitoring on/off for
// users."
async function handleMonitorSettings(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  if (requester.role !== 'admin' && requester.role !== 'superadmin') return res.status(403).json({ ok: false, error: 'Only an admin/manager can manage Monitor settings.' });

  if (req.method === 'POST') {
    const { screenshotIntervalMinutes, blurScreenshots } = req.body || {};
    const patch = {};
    if (screenshotIntervalMinutes !== undefined) {
      const n = Number(screenshotIntervalMinutes);
      if (!Number.isFinite(n) || n < 1 || n > 120) return res.status(400).json({ ok: false, error: 'screenshotIntervalMinutes must be between 1 and 120.' });
      patch.monitor_screenshot_interval_minutes = Math.round(n);
    }
    if (blurScreenshots !== undefined) patch.monitor_blur_screenshots = !!blurScreenshots;
    if (Object.keys(patch).length) {
      const existingRes = await supabaseRequest('workforce_settings?select=id&limit=1');
      const existingRows = existingRes.ok ? await existingRes.json() : [];
      if (existingRows && existingRows[0]) {
        await supabaseRequest(`workforce_settings?id=eq.${existingRows[0].id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      } else {
        await supabaseRequest('workforce_settings', { method: 'POST', body: JSON.stringify(patch) });
      }
    }
  }

  const settingsRes = await supabaseRequest('workforce_settings?limit=1');
  const settingsRows = settingsRes.ok ? await settingsRes.json() : [];
  const row = (settingsRows && settingsRows[0]) || {};

  // Roster source (2026-08-25): every employee, not only ones who have
  // already paired a device. The toggle itself (handleMonitorUserToggle)
  // only ever PATCHes profiles.monitoring_enabled -- it never required a
  // monitor_agents row to exist -- so the old agents-first roster could
  // show the setting but never let anyone turn it on for a person before
  // they'd installed the app. Now every profile gets a row; someone with
  // no paired device shows status 'not_installed' instead of being
  // omitted, and the toggle still works immediately -- the moment they
  // install and clock in, monitoring_enabled is already what was set here.
  const [agentsRes, profilesRes] = await Promise.all([
    supabaseRequest('monitor_agents?select=id,employee_id,device_name,platform,status,paired_at,last_seen_at,agent_version&order=last_seen_at.desc'),
    supabaseRequest('profiles?select=id,full_name,email,monitoring_enabled&order=full_name.asc'),
  ]);
  const agents = agentsRes.ok ? await agentsRes.json() : [];
  const profiles = profilesRes.ok ? await profilesRes.json() : [];
  const agentsByEmployee = {};
  for (const a of agents || []) {
    (agentsByEmployee[a.employee_id] = agentsByEmployee[a.employee_id] || []).push(a);
  }
  const aliveCutoff = new Date(Date.now() - MONITOR_AGENT_ALIVE_MINUTES * 60 * 1000).toISOString();
  const roster = [];
  for (const p of profiles || []) {
    const name = p.full_name || p.email || 'Unknown';
    const monitoringEnabled = p.monitoring_enabled !== false;
    // One row per PERSON, not per device (see pickBestMonitorAgent) -- a
    // roster of "every agent that ever paired" is what showed Marvin twice.
    const a = pickBestMonitorAgent(agentsByEmployee[p.id]);
    if (a) {
      roster.push({
        employeeId: p.id, name,
        deviceName: a.device_name, platform: a.platform, status: a.status,
        lastSeenAt: a.last_seen_at, agentVersion: a.agent_version || null,
        agentVersionState: agentVersionState(a.agent_version),
        // Agent Status (2026-08-25): whether the agent has actually
        // checked in recently, distinct from `status` (pairing/consent
        // state) -- same "last heartbeat within the alive window" real
        // signal handleMonitorReview's roster uses.
        online: a.last_seen_at ? a.last_seen_at >= aliveCutoff : false,
        monitoringEnabled,
      });
    } else {
      roster.push({
        employeeId: p.id, name,
        deviceName: null, platform: null, status: 'not_installed',
        lastSeenAt: null, agentVersion: null, agentVersionState: null,
        online: false,
        monitoringEnabled,
      });
    }
  }

  return res.status(200).json({
    ok: true,
    screenshotIntervalMinutes: Number.isFinite(row.monitor_screenshot_interval_minutes) ? row.monitor_screenshot_interval_minutes : 5,
    blurScreenshots: row.monitor_blur_screenshots === true,
    // What a 'stale' badge on the roster is stale RELATIVE TO. Sending the
    // number rather than letting the page hardcode it means the two cannot
    // drift -- a roster that says "update pending" against a version nobody
    // remembers is the same unfounded claim in a nicer colour.
    expectedAgentVersion: EXPECTED_AGENT_VERSION,
    roster,
  });
}

// Admin-only: flip monitoring on/off for one employee. Takes effect on
// their agent's next heartbeat (within ~60s) -- it stops/starts capture
// and, when turned back on, the consent prompt fires fresh next clock-in.
async function handleMonitorUserToggle(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  if (requester.role !== 'admin' && requester.role !== 'superadmin') return res.status(403).json({ ok: false, error: 'Only an admin/manager can change this.' });
  const { employeeId, monitoringEnabled } = req.body || {};
  if (!employeeId) return res.status(400).json({ ok: false, error: 'employeeId is required.' });

  // One permission. There was a second, monitoring_required, and the state it
  // made reachable -- clocked in, monitored, declined -- is what produced three
  // false idle clock-outs on 2026-08-18. See api/_lib/monitor-consent.js.
  if (monitoringEnabled === undefined) {
    return res.status(400).json({ ok: false, error: 'Nothing to change -- send monitoringEnabled.' });
  }
  const patch = { monitoring_enabled: !!monitoringEnabled };

  const updRes = await supabaseRequest(`profiles?id=eq.${employeeId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!updRes.ok) return res.status(500).json({ ok: false, error: 'Could not update that employee: ' + (await updRes.text()) });
  const updRows = await updRes.json().catch(() => []);
  const row = (updRows && updRows[0]) || {};
  return res.status(200).json({
    ok: true,
    monitoringEnabled: row.monitoring_enabled !== false,
  });
}

// Any signed-in employee: "am I being recorded right now?" -- drives the
// small recording-indicator button next to the Reina/Chirp buttons.
async function handleMonitorMyStatus(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  const sessRes = await supabaseRequest(`monitor_sessions?employee_id=eq.${requester.id}&ended_at=is.null&order=started_at.desc&limit=1`);
  const sessRows = sessRes.ok ? await sessRes.json() : [];
  const session = (sessRows && sessRows[0]) || null;
  const monitoringEnabled = requester.monitoring_enabled !== false;
  const recording = !!(session && session.consent === 'allowed' && monitoringEnabled);

  // How long since this person last actually touched their machine, as
  // witnessed by the desktop agent rather than by the HiveLogic browser tab.
  //
  // The browser's idle timer only sees input inside its own tab, so someone
  // working all morning in Outlook, a terminal, or an editor looks perfectly
  // idle to it. On 2026-08-16 that clocked Chris out at 11:19:03 for
  // "idle_timeout" while the agent was recording activity_level 100 /
  // idle_seconds 0 at 11:18:11 -- he was working the entire session. The
  // agent is the better witness, so the client merges the two rather than
  // trusting the tab alone (hlWfIdleSinceMs in public/index.html).
  //
  // Each sample carries the idle_seconds observed AT sampled_at, so the
  // moment of last real input is sampled_at MINUS that -- not sampled_at
  // itself, which would read a sample taken in the middle of a long idle
  // stretch as fresh activity. Null whenever we cannot answer (no agent, no
  // open session, query failed); the client then falls back to its own timer
  // instead of assuming anyone is present. Law 1.
  let deskIdleSeconds = null;
  if (session) {
    const sampleRes = await supabaseRequest(
      `monitor_activity_samples?monitor_session_id=eq.${session.id}&select=sampled_at,idle_seconds&order=sampled_at.desc&limit=1`
    );
    if (sampleRes.ok) {
      const rows = await sampleRes.json();
      const s = rows && rows[0];
      if (s && s.sampled_at) {
        const lastInputMs = new Date(s.sampled_at).getTime() - (Math.max(0, Number(s.idle_seconds) || 0) * 1000);
        deskIdleSeconds = Math.max(0, Math.round((Date.now() - lastInputMs) / 1000));
      }
    }
  }

  // Which build of the page is asking. A tab can run last week's JavaScript
  // against today's API indefinitely, and on 2026-08-16 exactly that made an
  // hour of production testing worthless -- the server was visibly new, so the
  // page was assumed new too. Recorded on the profile so "who is running old
  // code right now" is a query rather than an inference, and reported back so
  // the tab can say so to the person using it. See api/_lib/page-build.js.
  //
  // Written back only when the answer CHANGES or has gone stale (see
  // shouldRecordPageBuild), so a 30s poll does not become a write every 30s.
  // Best-effort: a failure here must never break the status the client came
  // for. An unreported build is 'unknown', never 'stale' -- clients older than
  // this mechanism cannot say what they are, and guessing would be the same
  // unfounded claim this exists to prevent.
  const reportedBuild = req.query && req.query.build ? String(req.query.build) : null;
  const buildState = pageBuildState(reportedBuild);
  if (shouldRecordPageBuild(requester.page_build, requester.page_build_seen_at, reportedBuild)) {
    try {
      await supabaseRequest(`profiles?id=eq.${requester.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ page_build: reportedBuild, page_build_seen_at: new Date().toISOString() }),
      });
    } catch (e) { /* never let bookkeeping break the poll */ }
  }

  return res.status(200).json({
    ok: true,
    clockedIn: !!session,
    recording,
    deskIdleSeconds,
    pageBuild: PAGE_BUILD,
    pageStale: buildState === 'stale',
  });
}

async function handleMonitorScreenshotUpload(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const agent = await getRequestingAgent(req);
  if (!agent) return res.status(401).json({ ok: false, error: 'Unknown or revoked agent token.' });
  const { monitorSessionId, displayIndex, imageBase64, width, height } = req.body || {};
  if (!monitorSessionId || !imageBase64) return res.status(400).json({ ok: false, error: 'monitorSessionId and imageBase64 are required.' });

  const sessRes = await supabaseRequest(`monitor_sessions?id=eq.${monitorSessionId}&agent_id=eq.${agent.id}&ended_at=is.null&limit=1`);
  const sessRows = sessRes.ok ? await sessRes.json() : [];
  if (!sessRows || !sessRows[0]) return res.status(403).json({ ok: false, error: 'That monitor session is not open for this agent -- the employee may have clocked out.' });

  // Validate the DECODED CONTENTS (magic-byte PNG/JPEG sniff + size), never the
  // client-declared content-type -- a forged agent could claim image/jpeg while
  // uploading anything.
  const shot = validateScreenshotBase64(imageBase64);
  if (!shot.ok) return res.status(shot.status).json({ ok: false, error: shot.error });
  const buf = shot.buffer;

  const objPath = `${agent.employee_id}/${monitorSessionId}/${Date.now()}_d${Number(displayIndex) || 0}.${shot.ext}`;
  const upRes = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/monitor-screenshots/${objPath}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': shot.contentType,
    },
    body: buf,
  });
  if (!upRes.ok) return res.status(502).json({ ok: false, error: 'Could not store the screenshot: ' + (await upRes.text()) });

  const insRes = await supabaseRequest('monitor_screenshots', {
    method: 'POST',
    body: JSON.stringify({
      monitor_session_id: monitorSessionId,
      display_index: Number(displayIndex) || 0,
      storage_path: objPath,
      width: Number.isFinite(Number(width)) ? Number(width) : null,
      height: Number.isFinite(Number(height)) ? Number(height) : null,
    }),
  });
  if (!insRes.ok) return res.status(500).json({ ok: false, error: 'Screenshot stored but could not record it: ' + (await insRes.text()) });

  return res.status(200).json({ ok: true });
}

// GET /api/track1?resource=monitor_prune -- Vercel Cron only (daily, see
// vercel.json). Enforces the monitor retention policy (sql/052): deletes
// screenshot blobs + rows, activity samples, pairing-attempt logs, and ended
// sessions older than MONITOR_RETENTION_DAYS. CRON_SECRET-gated, same pattern
// as handleCheckNewLeadsGet. Idempotent -- safe to re-run.
async function handleMonitorPrune(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const q = req.query || {};
  if (!cronSecret || (authHeader !== `Bearer ${cronSecret}` && q.key !== cronSecret)) {
    return res.status(401).json({ ok: false, error: 'This endpoint is for Vercel Cron only. Manual test: ?resource=monitor_prune&key=<CRON_SECRET>' });
  }
  const result = await pruneMonitorData({ retentionDays: MONITOR_RETENTION_DAYS });
  return res.status(200).json({ ok: true, resource: 'monitor_prune', retentionDays: MONITOR_RETENTION_DAYS, ...result });
}

async function handleMonitorReview(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  if (requester.role !== 'admin' && requester.role !== 'superadmin') return res.status(403).json({ ok: false, error: 'Only an admin/manager can view Monitor data.' });

  const employeeId = req.query.employeeId || null;

  if (!employeeId) {
    const agentsRes = await supabaseRequest('monitor_agents?select=id,employee_id,device_name,platform,status,paired_at,last_seen_at,agent_version&order=last_seen_at.desc');
    const agents = agentsRes.ok ? await agentsRes.json() : [];
    const empIds = [...new Set((agents || []).map((a) => a.employee_id))];
    let profiles = [];
    if (empIds.length) {
      const profRes = await supabaseRequest(`profiles?id=in.(${empIds.join(',')})&select=id,full_name,email`);
      profiles = profRes.ok ? await profRes.json() : [];
    }
    const byId = Object.fromEntries((profiles || []).map((p) => [p.id, p]));
    const aliveCutoff = new Date(Date.now() - MONITOR_AGENT_ALIVE_MINUTES * 60 * 1000).toISOString();
    // Real, bounded activity-level indicator (2026-08-25): only computed for
    // agents that are actually online right now (last_seen within the alive
    // window) -- an offline agent has no "current" activity to report, and
    // fetching this for every agent that has EVER paired would be an
    // unbounded query for no one still looking at their screen. Averages the
    // 5 most recent samples of their currently-open session; honestly null
    // (not 0) when there is no open session or no samples yet.
    const onlineAgents = (agents || []).filter((a) => a.last_seen_at && a.last_seen_at >= aliveCutoff);
    const activityByEmployee = {};
    if (onlineAgents.length) {
      const onlineIds = [...new Set(onlineAgents.map((a) => a.employee_id))];
      const openSessRes = await supabaseRequest(`monitor_sessions?employee_id=in.(${onlineIds.join(',')})&ended_at=is.null&select=id,employee_id&order=started_at.desc`);
      const openSessions = openSessRes.ok ? await openSessRes.json() : [];
      const sessionByEmployee = {};
      for (const s of openSessions || []) if (!sessionByEmployee[s.employee_id]) sessionByEmployee[s.employee_id] = s.id;
      const sessionIds = Object.values(sessionByEmployee);
      if (sessionIds.length) {
        const actRes = await supabaseRequest(`monitor_activity_samples?monitor_session_id=in.(${sessionIds.join(',')})&select=monitor_session_id,activity_level,sampled_at&order=sampled_at.desc&limit=${sessionIds.length * 5}`);
        const actRows = actRes.ok ? await actRes.json() : [];
        const bySession = {};
        for (const s of actRows || []) (bySession[s.monitor_session_id] = bySession[s.monitor_session_id] || []).push(s.activity_level);
        for (const [empId, sessId] of Object.entries(sessionByEmployee)) {
          const levels = (bySession[sessId] || []).slice(0, 5).filter((v) => typeof v === 'number');
          if (levels.length) activityByEmployee[empId] = Math.round(levels.reduce((a, b) => a + b, 0) / levels.length);
        }
      }
    }
    // One row per PERSON, not per device (see pickBestMonitorAgent) -- a
    // roster of "every agent that ever paired" is what showed Marvin twice.
    const agentsByEmployee2 = {};
    for (const a of agents || []) (agentsByEmployee2[a.employee_id] = agentsByEmployee2[a.employee_id] || []).push(a);
    const roster = Object.keys(agentsByEmployee2).map((empId) => {
      const a = pickBestMonitorAgent(agentsByEmployee2[empId]);
      return {
        employeeId: empId,
        name: (byId[empId] && byId[empId].full_name) || (byId[empId] && byId[empId].email) || 'Unknown',
        deviceName: a.device_name,
        platform: a.platform,
        status: a.status,
        pairedAt: a.paired_at,
        lastSeenAt: a.last_seen_at,
        agentVersion: a.agent_version || null,
        online: a.last_seen_at ? a.last_seen_at >= aliveCutoff : false,
        activityLevel: Object.prototype.hasOwnProperty.call(activityByEmployee, empId) ? activityByEmployee[empId] : null,
      };
    });
    return res.status(200).json({ ok: true, resource: 'monitor_review', roster });
  }

  // Screenshots are more sensitive than the roster above (real images of
  // someone's screen, not just an online/offline dot and an activity
  // number), so this one branch -- and only this one -- gets a tighter bar
  // than the rest of Monitor's admin/superadmin gate: Superadmin or Owner
  // only (2026-08-26, "Only System Admin/Owner must be able to view the
  // screenshots"). A plain 'admin' (an office manager, a project manager)
  // can still see who's online and how active they are; they just can't
  // open the gallery. isOwner() reused from ./_lib/owner.js -- the same
  // source that already answers "is this person exempt from the
  // timeclock," now also answering "can this person see everyone else's
  // screen."
  if (requester.role !== 'superadmin' && !(await isOwner(requester))) {
    return res.status(403).json({ ok: false, error: 'Screenshots are restricted to Superadmin/Owner.' });
  }

  const sessRes = await supabaseRequest(`monitor_sessions?employee_id=eq.${employeeId}&order=started_at.desc&limit=20`);
  const sessions = sessRes.ok ? await sessRes.json() : [];
  const sessionIds = (sessions || []).map((s) => s.id);

  let screenshots = [];
  if (sessionIds.length) {
    const shotRes = await supabaseRequest(`monitor_screenshots?monitor_session_id=in.(${sessionIds.join(',')})&order=captured_at.desc&limit=60`);
    const shotRows = shotRes.ok ? await shotRes.json() : [];
    screenshots = await Promise.all((shotRows || []).map(async (s) => {
      const signRes = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/sign/monitor-screenshots/${s.storage_path}`, {
        method: 'POST',
        headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 300 }),
      });
      const signData = signRes.ok ? await signRes.json() : null;
      return {
        id: s.id,
        capturedAt: s.captured_at,
        displayIndex: s.display_index,
        monitorSessionId: s.monitor_session_id,
        url: signData && signData.signedURL ? `${process.env.SUPABASE_URL}/storage/v1${signData.signedURL}` : null,
      };
    }));
  }

  let activitySamples = [];
  if (sessionIds.length) {
    const actRes = await supabaseRequest(`monitor_activity_samples?monitor_session_id=in.(${sessionIds.join(',')})&order=sampled_at.desc&limit=200`);
    activitySamples = actRes.ok ? await actRes.json() : [];
  }

  return res.status(200).json({ ok: true, resource: 'monitor_review', sessions, screenshots, activitySamples });
}

// ---------------------------------------------------------------------
// Phase 5 (2026-08-25): App whitelist / productivity classification.
// monitor_app_rules holds one row per foreground-app name -> category
// (productive/neutral/unproductive), admin-managed. The desktop agent
// (hivelogic-monitor-agent) reads this same list with its own bearer
// token to classify the active app LOCALLY and decide when to show its
// own "not productive" notification -- classification has to happen on
// the employee's machine in real time, not only in a server aggregate.
// ---------------------------------------------------------------------
const MONITOR_APP_CATEGORIES = ['productive', 'neutral', 'unproductive'];

async function handleMonitorAppRules(req, res) {
  // Two kinds of caller: an admin browser session (full CRUD), or a
  // paired desktop agent's own bearer token (read-only -- it only needs
  // the list to classify locally, never to change it).
  const agent = await requireMonitorAgent(req);
  let requester = null;
  if (!agent) {
    requester = await getRequestingProfile(req);
    if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  }

  if (req.method === 'GET') {
    const r = await supabaseRequest('monitor_app_rules?select=id,app_name,category,updated_at&order=app_name.asc');
    if (!r.ok) return res.status(200).json({ ok: true, tablesReady: false, rules: [] });
    const rows = await r.json();
    return res.status(200).json({
      ok: true, tablesReady: true,
      rules: (rows || []).map((row) => ({ id: row.id, appName: row.app_name, category: row.category, updatedAt: row.updated_at })),
    });
  }

  // Writes are admin-only -- an agent token alone (or no session) cannot
  // reach this branch.
  if (!requester || (requester.role !== 'admin' && requester.role !== 'superadmin')) {
    return res.status(403).json({ ok: false, error: 'Only an admin/manager can manage the app whitelist.' });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const appName = String(b.appName || '').trim();
    const category = String(b.category || '').trim();
    if (!appName) return res.status(400).json({ ok: false, error: 'appName is required.' });
    if (!MONITOR_APP_CATEGORIES.includes(category)) {
      return res.status(400).json({ ok: false, error: `category must be one of: ${MONITOR_APP_CATEGORIES.join(', ')}.` });
    }
    const r = await supabaseRequest('monitor_app_rules?on_conflict=app_name', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ app_name: appName, category, created_by: requester.id, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not save the rule: ' + (await r.text()) });
    const rows = await r.json();
    const row = rows[0];
    return res.status(200).json({ ok: true, rule: { id: row.id, appName: row.app_name, category: row.category, updatedAt: row.updated_at } });
  }

  if (req.method === 'DELETE') {
    const id = (req.query && req.query.id) || (req.body && req.body.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id is required.' });
    const r = await supabaseRequest(`monitor_app_rules?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not delete the rule.' });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
}

// GET /api/track1?resource=monitor_app_usage -- the signed-in employee's
// own today app-usage breakdown + a real productivity %, derived from
// monitor_activity_samples.active_app joined against monitor_app_rules.
// Each sample is treated as one heartbeat interval's worth of time (the
// agent's default is 60s; genuinely approximate, labeled as such -- this
// is sample-count based, not a wall-clock duration log). An app with no
// matching rule is honestly reported as 'unclassified', never guessed
// into a category, and does not count toward the productivity %.
async function handleMonitorAppUsage(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  // "Today" in the EMPLOYEE'S OWN timezone (2026-08-26), not a hardcoded
  // America/New_York -- this is a personal dashboard stat about their own
  // day, unlike Command Center's Jobber-schedule views (which correctly
  // stay ET, the business's own timezone). Falls back to DEFAULT_TIMEZONE
  // until a heartbeat/session report has set profiles.settings.timezone.
  const requesterTz = (requester.settings && isValidTimeZone(requester.settings.timezone))
    ? requester.settings.timezone : DEFAULT_TIMEZONE;
  const { startISO } = todayRangeInTz(requesterTz);

  const sessRes = await supabaseRequest(`monitor_sessions?employee_id=eq.${requester.id}&started_at=gte.${encodeURIComponent(startISO)}&select=id`);
  if (!sessRes.ok) return res.status(200).json({ ok: true, tablesReady: false, apps: [], productivityPercent: null, sampleCount: 0 });
  const sessions = await sessRes.json();
  const sessionIds = (sessions || []).map((s) => s.id);
  if (!sessionIds.length) return res.status(200).json({ ok: true, tablesReady: true, apps: [], productivityPercent: null, sampleCount: 0 });

  const [actRes, rulesRes] = await Promise.all([
    supabaseRequest(`monitor_activity_samples?monitor_session_id=in.(${sessionIds.join(',')})&select=active_app&active_app=not.is.null`),
    supabaseRequest('monitor_app_rules?select=app_name,category'),
  ]);
  const samples = actRes.ok ? await actRes.json() : [];
  const rules = rulesRes.ok ? await rulesRes.json() : [];
  const categoryByApp = Object.fromEntries((rules || []).map((r) => [r.app_name, r.category]));

  const counts = {}; // app_name -> sample count
  for (const s of samples || []) {
    if (!s.active_app) continue;
    counts[s.active_app] = (counts[s.active_app] || 0) + 1;
  }
  const apps = Object.entries(counts)
    .map(([appName, sampleCount]) => ({ appName, sampleCount, category: categoryByApp[appName] || 'unclassified' }))
    .sort((a, b) => b.sampleCount - a.sampleCount);

  const classified = apps.filter((a) => a.category === 'productive' || a.category === 'unproductive');
  const classifiedTotal = classified.reduce((sum, a) => sum + a.sampleCount, 0);
  const productiveTotal = classified.filter((a) => a.category === 'productive').reduce((sum, a) => sum + a.sampleCount, 0);
  const productivityPercent = classifiedTotal > 0 ? Math.round((productiveTotal / classifiedTotal) * 100) : null;

  return res.status(200).json({
    ok: true, tablesReady: true, apps,
    sampleCount: apps.reduce((sum, a) => sum + a.sampleCount, 0),
    productivityPercent, // null when nothing in today's samples matches a whitelist rule yet
  });
}

async function handleWorkforceSummary(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const today = todayStr();
  if (req.method === 'GET') {
    const r = await supabaseRequest(`workforce_daily_summaries?employee_id=eq.${requester.id}&summary_date=eq.${today}&limit=1`);
    if (!r.ok) return res.status(200).json({ ok: true, summary: null, tablesReady: false });
    const rows = await r.json();
    return res.status(200).json({ ok: true, summary: (rows && rows[0]) || null, tablesReady: true });
  }
  if (req.method === 'POST') {
    const b = req.body || {};
    const payload = {
      employee_id: requester.id,
      summary_date: today,
      tasks_completed: b.tasks_completed || '',
      plans_tomorrow: b.plans_tomorrow || '',
      blockers: b.blockers || '',
      support_needed: b.support_needed || '',
      hours_worked: b.hours_worked || '',
      submitted_at: new Date().toISOString(),
    };
    const r = await supabaseRequest('workforce_daily_summaries?on_conflict=employee_id,summary_date', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not save summary -- has Chris run the workforce tables SQL yet? Detail: ' + (await r.text()) });
    const rows = await r.json();
    return res.status(200).json({ ok: true, summary: rows[0] });
  }
  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
}

// Monday 00:00 in the same business timezone (America/New_York) todayRangeET
// uses -- so "this week" always means the same calendar week the office
// clock uses, not whatever timezone the browser happens to be in.
function weekStartISOET() {
  const { dateStr, startISO } = todayRangeET();
  const [y, mo, d] = dateStr.split('-').map(Number);
  // getUTCDay() is fine here -- dateStr/startISO already carry the ET offset,
  // constructing a Date from them and asking its UTC day back out the day
  // number without a second timezone conversion.
  const asUtcMidnight = new Date(Date.UTC(y, mo - 1, d));
  const dow = asUtcMidnight.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  const offset = startISO.slice(-6); // reuse the same "+HH:MM"/"-HH:MM" suffix
  const monday = new Date(asUtcMidnight.getTime() - daysSinceMonday * 86400000);
  const my = monday.getUTCFullYear(), mm = String(monday.getUTCMonth() + 1).padStart(2, '0'), md = String(monday.getUTCDate()).padStart(2, '0');
  return `${my}-${mm}-${md}T00:00:00${offset}`;
}

// GET /api/track1?resource=workforce_week_summary -- real Today/This-Week
// worked-seconds totals for the signed-in employee, computed from
// workforce_time_sessions (the same source of truth clock in/out already
// writes to) rather than the free-text hours_worked EOD field. Powers the
// Monitor dashboard's summary cards -- see handleWorkforceStatus for the
// companion "what's my session doing right now" call.
// Calendar date (YYYY-MM-DD) a UTC timestamp falls on in the business
// timezone. clock_in is stored as new Date().toISOString() (UTC); comparing
// its raw slice(0,10) against todayStr()'s ET date misclassifies any
// clock-in from the last ~4-5 hours of the ET business day (it's already
// "tomorrow" in UTC), dropping a real evening shift off "Today's Hours".
function etDateStr(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function handleWorkforceWeekSummary(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const today = todayStr();
  const weekStart = weekStartISOET();
  const sessRes = await supabaseRequest(
    `workforce_time_sessions?employee_id=eq.${requester.id}&clock_in=gte.${encodeURIComponent(weekStart)}`
    + `&order=clock_in.asc&select=clock_in,clock_out,total_break_seconds,on_break,break_started_at,status`
  );
  if (!sessRes.ok) return res.status(200).json({ ok: true, tablesReady: false, todaySeconds: 0, weekSeconds: 0 });
  const sessions = await sessRes.json();
  const nowMs = Date.now();
  let todaySeconds = 0, weekSeconds = 0;
  for (const s of sessions || []) {
    const startMs = new Date(s.clock_in).getTime();
    const endMs = s.clock_out ? new Date(s.clock_out).getTime() : nowMs;
    // total_break_seconds only finalizes when a break ENDS -- an in-progress
    // break's elapsed time isn't in it yet, so subtract it separately (same
    // "freeze at break start" accounting the frontend timer uses).
    const liveBreakSeconds = (s.on_break && s.break_started_at && !s.clock_out)
      ? Math.max(0, Math.round((nowMs - new Date(s.break_started_at).getTime()) / 1000))
      : 0;
    const worked = Math.max(0, Math.round((endMs - startMs) / 1000) - (s.total_break_seconds || 0) - liveBreakSeconds);
    weekSeconds += worked;
    if (etDateStr(s.clock_in) === today) todaySeconds += worked;
  }
  return res.status(200).json({ ok: true, tablesReady: true, todaySeconds, weekSeconds, weekStart });
}

async function handleWorkforceTeam(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (requester.role !== 'admin' && requester.role !== 'superadmin') return res.status(403).json({ ok: false, error: 'Only an admin/manager can view the team workforce dashboard.' });
  const today = todayStr();
  const profRes = await supabaseRequest('profiles?select=id,email,full_name,role&order=full_name.asc');
  const profiles = profRes.ok ? await profRes.json() : [];
  const sessRes = await supabaseRequest(`workforce_time_sessions?clock_in=gte.${today}&order=clock_in.desc`);
  const sumRes = await supabaseRequest(`workforce_daily_summaries?summary_date=eq.${today}`);
  if (!sessRes.ok || !sumRes.ok) {
    return res.status(200).json({ ok: true, team: [], tablesReady: false, note: 'Workforce tables are not set up yet in Supabase -- run the setup SQL, then this will populate automatically.' });
  }
  const sessionsRaw = await sessRes.json();
  const summaries = await sumRes.json();
  const team = profiles.map(p => {
    const mySessions = sessionsRaw.filter(s => s.employee_id === p.id);
    const active = mySessions.find(s => s.status === 'active');
    const completedToday = mySessions.filter(s => s.status === 'completed');
    const mySummary = summaries.find(s => s.employee_id === p.id);
    return {
      id: p.id, email: p.email, full_name: p.full_name, role: p.role,
      clockedInNow: !!active,
      onBreak: !!(active && active.on_break),
      clockInTime: active ? active.clock_in : null,
      // Availability status (2026-08-13, jomell/Chris ask): same status_flag/
      // status_emoji columns the self-service Team Status card already reads
      // (see handleWorkforceTeamStatus) -- only meaningful while clocked in.
      status: active ? (active.status_flag || 'available') : null,
      statusLabel: active ? (WF_STATUS_LABELS[active.status_flag] || 'Available') : null,
      statusEmoji: active ? (active.status_emoji || '✅') : null,
      statusUpdatedAt: active ? (active.status_updated_at || active.clock_in) : null,
      totalBreakSecondsToday: mySessions.reduce((sum, s) => sum + (s.total_break_seconds || 0), 0),
      lastClockOut: completedToday.length ? completedToday[completedToday.length - 1].clock_out : null,
      sessionsToday: mySessions.length,
      summarySubmitted: !!mySummary,
      summary: mySummary || null,
    };
  });
  return res.status(200).json({ ok: true, team, tablesReady: true });
}

// Real replacement for the fully-fabricated "Daily Production Tracker" on
// the Remote Work & Production page (2026-08-12) -- that table previously
// hardcoded invoice/PO/permit numbers with zero backing. Only two real,
// per-employee-attributable data points exist anywhere in this schema:
// purchase_orders carries a real requestedBy (the creating profile's id --
// see api/bookkeeping/purchase-orders/_actor.js), so "POs created today"
// can honestly be attributed per person. Invoices have NO employee/creator
// column at all (synced straight from Jobber -- see api/invoices.js's
// select list), so invoicesSentToday is deliberately a company-wide count,
// never attributed to any one person. Drawings-revised and permits-filed
// have no real table anywhere and are not included here.
async function handleProductionTracker(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (requester.role !== 'admin' && requester.role !== 'superadmin') return res.status(403).json({ ok: false, error: 'Only an admin/manager can view the production tracker.' });

  const today = todayStr();
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const invRes = await supabaseRequest(`invoices?select=invoice_number&issued_date=eq.${today}`);
  const invoicesSentToday = invRes.ok ? (await invRes.json()).length : 0;

  const poRes = await supabaseRequest(`purchase_orders?select=po_number,data,created_at&created_at=gte.${today}T00:00:00Z&created_at=lt.${tomorrow}T00:00:00Z`);
  const poRows = poRes.ok ? await poRes.json() : [];
  const byActor = {};
  for (const po of poRows) {
    const actorId = po.data && po.data.requestedBy;
    if (!actorId) continue;
    (byActor[actorId] = byActor[actorId] || []).push(po.po_number);
  }
  const actorIds = Object.keys(byActor);
  let profiles = [];
  if (actorIds.length) {
    const profRes = await supabaseRequest(`profiles?id=in.(${actorIds.join(',')})&select=id,full_name,email`);
    profiles = profRes.ok ? await profRes.json() : [];
  }
  const nameById = Object.fromEntries(profiles.map((p) => [p.id, p.full_name || p.email]));
  const poByEmployee = actorIds.map((id) => ({
    employeeId: id,
    employeeName: nameById[id] || 'Unknown',
    poNumbers: byActor[id],
    count: byActor[id].length,
  })).sort((a, b) => b.count - a.count);

  return res.status(200).json({ ok: true, resource: 'production_tracker', date: today, invoicesSentToday, poByEmployee });
}

// ---------- Inventory & Truck Stock (2026-08-12) ----------
// Real replacement for a fully-mock page that claimed a live, auto-
// decrementing truck-stock system and an AI ("Reina") banner that had
// already compared vendor pricing and drafted a real PO overnight -- none
// of it was backed by anything. Phase 1 only: a real stock-item catalog and
// a real on-hand ledger per location, adjusted by hand and logged (see
// sql/070_inventory_stock.sql for why this stays manual -- there is no
// "materials used on a job" concept anywhere in this schema to hook an
// automatic decrement into). Low-stock flagging is a real threshold check,
// not an AI narrative. "Trucks" are the existing real `vehicles` table, not
// a new locations table -- see that migration's header comment.
const INVENTORY_COMPANY_ID = process.env.HIVELOGIC_COMPANY_ID || 'greenwich-handyman';
async function canManageInventory(requester) {
  return !!requester && (requester.role === 'admin' || requester.role === 'superadmin');
}
function parseLocationKey(key) {
  if (key === 'warehouse') return { type: 'warehouse' };
  const m = /^truck:(.+)$/.exec(String(key || ''));
  if (m) return { type: 'truck', vehicleJobberId: m[1] };
  return null;
}

async function handleInventoryItems(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (!(await canManageInventory(requester))) return res.status(403).json({ ok: false, error: 'Only an admin can manage inventory items.' });

  if (req.method === 'GET') {
    const rows = await fiFetchAllRows('stock_items', '?select=*&order=name.asc');
    return res.status(200).json({ ok: true, resource: 'inventory_items', items: rows });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'name is required.' });
    const reorderThreshold = body.reorderThreshold != null && body.reorderThreshold !== '' ? Number(body.reorderThreshold) : null;
    if (reorderThreshold != null && (!Number.isFinite(reorderThreshold) || reorderThreshold < 0)) {
      return res.status(400).json({ ok: false, error: 'reorderThreshold must be a non-negative number.' });
    }
    const insertRes = await supabaseRequest('stock_items', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{
        name,
        sku: body.sku ? String(body.sku).trim() : null,
        category: body.category ? String(body.category).trim() : null,
        unit_of_measure: body.unitOfMeasure ? String(body.unitOfMeasure).trim() : null,
        reorder_threshold: reorderThreshold,
        created_by_email: requester.email,
      }]),
    });
    if (!insertRes.ok) return res.status(500).json({ ok: false, error: await insertRes.text() });
    const rows = await insertRes.json();
    return res.status(200).json({ ok: true, item: rows[0] });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
}

async function handleInventoryStock(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (!(await canManageInventory(requester))) return res.status(403).json({ ok: false, error: 'Only an admin can view inventory.' });

  const items = await fiFetchAllRows('stock_items', '?select=*&order=name.asc');
  const onHandRows = await fiFetchAllRows('stock_on_hand', '?select=stock_item_id,location_key,quantity');
  const vehiclesRes = await supabaseRequest('vehicles?select=jobber_id,name,status&order=name.asc');
  const vehicles = vehiclesRes.ok ? await vehiclesRes.json() : [];
  const assignedRes = await supabaseRequest('users?assigned_vehicle_id=not.is.null&select=name,assigned_vehicle_id');
  const assignedRows = assignedRes.ok ? await assignedRes.json() : [];

  const assignedByVehicle = {};
  for (const u of assignedRows) {
    (assignedByVehicle[u.assigned_vehicle_id] = assignedByVehicle[u.assigned_vehicle_id] || []).push(u.name);
  }
  const trucks = vehicles.map((v) => ({
    vehicleJobberId: v.jobber_id,
    name: v.name,
    assignedNames: assignedByVehicle[v.jobber_id] || [],
  }));

  const quantitiesByItem = {};
  for (const r of onHandRows) {
    (quantitiesByItem[r.stock_item_id] = quantitiesByItem[r.stock_item_id] || {})[r.location_key] = Number(r.quantity) || 0;
  }

  const outItems = items.map((it) => {
    const quantities = quantitiesByItem[it.id] || {};
    const totalQuantity = Object.values(quantities).reduce((sum, q) => sum + q, 0);
    const lowStock = it.reorder_threshold != null && totalQuantity <= Number(it.reorder_threshold);
    return {
      id: it.id,
      name: it.name,
      sku: it.sku,
      category: it.category,
      unitOfMeasure: it.unit_of_measure,
      reorderThreshold: it.reorder_threshold,
      quantities,
      totalQuantity,
      lowStock,
    };
  });

  const summary = {
    skuCount: outItems.length,
    totalUnits: outItems.reduce((sum, it) => sum + it.totalQuantity, 0),
    lowStockCount: outItems.filter((it) => it.lowStock).length,
  };

  return res.status(200).json({ ok: true, resource: 'inventory_stock', items: outItems, trucks, summary });
}

async function handleInventoryAdjust(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (!(await canManageInventory(requester))) return res.status(403).json({ ok: false, error: 'Only an admin can adjust inventory.' });

  const body = req.body || {};
  const stockItemId = String(body.stockItemId || '').trim();
  const locationKey = String(body.locationKey || '').trim();
  const delta = Number(body.delta);
  const reason = body.reason != null ? String(body.reason).trim() || null : null;
  if (!stockItemId) return res.status(400).json({ ok: false, error: 'stockItemId is required.' });
  if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ ok: false, error: 'delta must be a non-zero number.' });
  const parsedLocation = parseLocationKey(locationKey);
  if (!parsedLocation) return res.status(400).json({ ok: false, error: "locationKey must be 'warehouse' or 'truck:<vehicleId>'." });
  if (parsedLocation.type === 'truck') {
    const vRes = await supabaseRequest(`vehicles?jobber_id=eq.${encodeURIComponent(parsedLocation.vehicleJobberId)}&select=jobber_id&limit=1`);
    const vRows = vRes.ok ? await vRes.json() : [];
    if (!vRows.length) return res.status(400).json({ ok: false, error: 'That truck does not match a real vehicle record.' });
  }

  const currentRes = await supabaseRequest(`stock_on_hand?stock_item_id=eq.${encodeURIComponent(stockItemId)}&location_key=eq.${encodeURIComponent(locationKey)}&select=quantity&limit=1`);
  const currentRows = currentRes.ok ? await currentRes.json() : [];
  const currentQty = (currentRows[0] && Number(currentRows[0].quantity)) || 0;
  const newQty = currentQty + delta;
  if (newQty < 0) return res.status(400).json({ ok: false, error: `That would take this item below zero (currently ${currentQty}).` });

  const upsertRes = await supabaseRequest('stock_on_hand?on_conflict=stock_item_id,location_key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ stock_item_id: stockItemId, location_key: locationKey, quantity: newQty, updated_at: new Date().toISOString(), updated_by_email: requester.email }]),
  });
  if (!upsertRes.ok) return res.status(500).json({ ok: false, error: await upsertRes.text() });

  await supabaseRequest('stock_adjustments', {
    method: 'POST',
    body: JSON.stringify([{ stock_item_id: stockItemId, location_key: locationKey, delta, quantity_after: newQty, reason, adjusted_by_email: requester.email }]),
  });

  return res.status(200).json({ ok: true, stockItemId, locationKey, quantity: newQty });
}

async function handleInventoryAdjustments(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (!(await canManageInventory(requester))) return res.status(403).json({ ok: false, error: 'Only an admin can view the inventory usage history.' });

  const rows = await fiFetchAllRows('stock_adjustments', '?select=*&order=adjusted_at.desc&limit=200');
  const itemIds = [...new Set(rows.map((r) => r.stock_item_id))];
  let items = [];
  if (itemIds.length) {
    const itemsRes = await supabaseRequest(`stock_items?id=in.(${itemIds.join(',')})&select=id,name`);
    items = itemsRes.ok ? await itemsRes.json() : [];
  }
  const nameById = Object.fromEntries(items.map((i) => [i.id, i.name]));
  const adjustments = rows.map((r) => ({
    id: r.id,
    itemName: nameById[r.stock_item_id] || 'Unknown item',
    locationKey: r.location_key,
    delta: r.delta,
    quantityAfter: r.quantity_after,
    reason: r.reason,
    adjustedByEmail: r.adjusted_by_email,
    adjustedAt: r.adjusted_at,
  }));
  return res.status(200).json({ ok: true, resource: 'inventory_adjustments', adjustments });
}

async function handleInventoryPurchaseOrders(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (!(await canManageInventory(requester))) return res.status(403).json({ ok: false, error: 'Only an admin can view purchase orders here.' });

  // Per-request tenant slug (this subsystem keys company_id on the slug), with
  // the single-tenant constant as the fallback.
  const invCompany = (await companySlugForUser({ id: requester.id })) || INVENTORY_COMPANY_ID;
  const rows = await fiFetchAllRows('purchase_orders', `?select=id,po_number,lifecycle_status,data,created_at&company_id=eq.${encodeURIComponent(invCompany)}&order=created_at.desc&limit=50`);
  const purchaseOrders = rows.map((r) => {
    const lines = (r.data && r.data.lines) || [];
    const amount = lines.reduce((sum, l) => sum + (Number(l.estimatedQty) || 0) * (Number(l.estimatedUnitPrice) || 0), 0);
    return {
      id: r.id,
      poNumber: r.po_number,
      vendorName: (r.data && r.data.vendorName) || null,
      amount,
      lifecycleStatus: r.lifecycle_status,
      createdAt: r.created_at,
    };
  });
  // 'draft' is the real not-yet-approved state a PO starts in (approval moves
  // it to 'ordered' -- see server/bookkeeping/src/purchase-orders.js).
  const awaitingApprovalCount = purchaseOrders.filter((po) => po.lifecycleStatus === 'draft').length;
  return res.status(200).json({ ok: true, resource: 'inventory_purchase_orders', purchaseOrders, awaitingApprovalCount });
}

// ---- Material Catalog & Procurement (Vendor Catalog module) ----------
// Phase 0 per reina/material-catalog-procurement-prd-2026-07-19.md S11:
// read-only search + product detail + adapter status. Deliberately NO
// write paths yet (no upsert into products/vendor_offers, no
// product_snapshots creation) -- that's Phase 1. This matches the Phase 0
// exit condition stated in the PRD: "Search from the real page, see
// correctly-shaped results or an honest 'not connected', no write paths
// yet." Results here are live/ephemeral from the vendor adapter, not
// persisted.

// Nicknames are checked ahead of (and independently from) the live vendor
// search -- a saved nickname is a deliberate human signal ("this exact
// product is what I mean by 'the good GFCI'"), so it should surface even if
// the vendor adapter is slow, down, or the free-text match is weak. Never
// lets a nickname lookup hiccup break the underlying search response.
async function findNicknameMatches(q, vendorKey) {
  try {
    let filter = `nickname=ilike.*${encodeURIComponent(q)}*&select=*&order=created_at.desc&limit=10`;
    if (vendorKey) filter += `&vendor_key=eq.${encodeURIComponent(vendorKey)}`;
    const r = await supabaseRequest(`product_nicknames?${filter}`);
    if (!r.ok) return [];
    const rows = await r.json();
    return rows.map(row => ({
      vendor_key: row.vendor_key,
      vendor_sku: row.vendor_sku,
      vendor_title: row.vendor_title,
      brand: row.brand,
      unit_price: row.unit_price,
      image_url: row.image_url,
      product_url: row.product_url,
      matched_nickname: row.nickname,
      currency: 'USD',
      source: 'nickname',
    }));
  } catch (e) {
    return [];
  }
}

// "All Vendors" (2026-08-11): searches every adapter that actually supports
// live search (connectorType 'api' -- today homedepot and lowes). PunchOut
// (ferguson) and feed (ringsend) connectors have no live search endpoint at
// all -- see each adapter's own header comment -- so they're never part of
// this aggregate; there is nothing for them to return. One vendor being
// unconnected or erroring never blocks the others (Promise.allSettled),
// same per-source isolation the Jobber sync uses. perVendor in the response
// reports exactly which vendors were searched, connected, and how many
// results each returned, rather than silently merging or hiding gaps.
async function handleMaterialsSearchAllVendors(q, mode, opts) {
  const nicknameMatches = await findNicknameMatches(q, null);
  const searchableEntries = Object.entries(ADAPTERS).filter(([, e]) => e.connectorType === 'api');
  const settled = await Promise.allSettled(
    searchableEntries.map(([, entry]) => entry.module.search(q, mode, opts))
  );
  const perVendor = [];
  let combinedResults = [];
  settled.forEach((s, i) => {
    const [key, entry] = searchableEntries[i];
    if (s.status === 'fulfilled') {
      const result = s.value || {};
      perVendor.push({ vendor: key, label: entry.label, connected: result.connected !== false, error: result.error || null, count: (result.results || []).length });
      if (result.results && result.results.length) combinedResults = combinedResults.concat(result.results);
    } else {
      perVendor.push({ vendor: key, label: entry.label, connected: false, error: (s.reason && s.reason.message) || String(s.reason), count: 0 });
    }
  });
  return {
    ok: true,
    resource: 'materials_search',
    vendor: 'all',
    connectorType: 'aggregate',
    connected: perVendor.some((v) => v.connected),
    searchMode: mode,
    query: q,
    perVendor,
    results: [...nicknameMatches, ...combinedResults],
    nicknameMatchCount: nicknameMatches.length,
  };
}

async function handleMaterialsSearch(req, res) {
  const q = req.query.q || req.query.query;
  const mode = req.query.mode || 'keyword';
  const vendorKey = req.query.vendor || 'homedepot';
  if (!q) return res.status(400).json({ ok: false, error: 'resource=materials_search requires ?q=<search text>' });

  if (vendorKey === 'all') {
    const payload = await handleMaterialsSearchAllVendors(q, mode, { storeId: req.query.store_id, zip: req.query.zip });
    return res.status(200).json(payload);
  }

  const entry = getAdapter(vendorKey);
  if (!entry) {
    return res.status(400).json({
      ok: false,
      error: `Unknown vendor '${vendorKey}'. Available: ${Object.keys(ADAPTERS).join(', ')}`,
    });
  }

  const nicknameMatches = await findNicknameMatches(q, vendorKey);

  try {
    const result = await entry.module.search(q, mode, {
      storeId: req.query.store_id,
      zip: req.query.zip,
    });
    return res.status(200).json({
      ok: true,
      resource: 'materials_search',
      vendor: vendorKey,
      connectorType: entry.connectorType,
      ...result,
      results: [...nicknameMatches, ...(result.results || [])],
      nicknameMatchCount: nicknameMatches.length,
    });
  } catch (e) {
    // A live vendor search failure shouldn't swallow saved nicknames --
    // those are our own data, not dependent on the vendor being up.
    if (nicknameMatches.length) {
      return res.status(200).json({
        ok: true,
        resource: 'materials_search',
        vendor: vendorKey,
        connectorType: entry.connectorType,
        connected: true,
        searchMode: mode,
        query: q,
        results: nicknameMatches,
        nicknameMatchCount: nicknameMatches.length,
        liveSearchError: e.message,
      });
    }
    return res.status(502).json({ ok: false, error: `${entry.label} search failed: ${e.message}` });
  }
}

async function handleMaterialsGet(req, res) {
  const vendorKey = req.query.vendor || 'homedepot';
  const sku = req.query.sku;
  if (!sku) return res.status(400).json({ ok: false, error: 'resource=materials_get requires ?sku=<vendor sku> and ?vendor=<vendor key>' });

  const entry = getAdapter(vendorKey);
  if (!entry) return res.status(400).json({ ok: false, error: `Unknown vendor '${vendorKey}'.` });

  try {
    const result = await entry.module.getProduct(sku, { storeId: req.query.store_id, zip: req.query.zip });
    return res.status(200).json({ ok: true, resource: 'materials_get', vendor: vendorKey, ...result });
  } catch (e) {
    return res.status(502).json({ ok: false, error: `${entry.label} product lookup failed: ${e.message}` });
  }
}

// Backs the Vendor Adapters panel already drafted in the Vendor Catalog UI
// (Home Depot Pro / Ferguson / Lowe's Pro / Local supply houses, each with
// a LIVE/ADAPTER/TRANSITIONAL badge) -- this endpoint is what makes those
// badges real instead of hardcoded copy.
async function handleMaterialsAdapters(res) {
  return res.status(200).json({ ok: true, resource: 'materials_adapters', adapters: listAdapters() });
}

// Saves a personal nickname on a specific vendor search hit (sql/009).
// Requires the vendor_sku + vendor_title etc. of the exact product being
// tagged (the frontend already has this in memory from the search result
// that's rendering the tag button, so it's passed through as-is rather
// than re-fetched). No dedupe/uniqueness enforced -- a product can carry
// more than one nickname, and the same nickname text on two different
// products is allowed (both are legitimate: "the good GFCI" said once, or
// two different people's names for two different things).
async function handleMaterialsNicknameSave(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const body = req.body || {};
  const { vendor_key, vendor_sku, nickname, vendor_title } = body;
  if (!vendor_key || !vendor_sku || !nickname || !String(nickname).trim() || !vendor_title) {
    return res.status(400).json({ ok: false, error: 'vendor_key, vendor_sku, nickname, and vendor_title are required.' });
  }
  const row = {
    vendor_key,
    vendor_sku,
    nickname: String(nickname).trim(),
    vendor_title,
    brand: body.brand || null,
    unit_price: body.unit_price ?? null,
    image_url: body.image_url || null,
    product_url: body.product_url || null,
  };
  const r = await supabaseRequest('product_nicknames', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!r.ok) return res.status(502).json({ ok: false, error: `Failed to save nickname: ${await r.text()}` });
  const saved = await r.json();
  return res.status(200).json({ ok: true, resource: 'materials_nickname_save', nickname: saved[0] || row });
}

// ---- Project Cart (Phase 1 slice) -------------------------------------
// Per reina/material-catalog-procurement-prd-2026-07-19.md S11 Phase 1:
// "Add-to-record + snapshot + naming... Adding a product creates a real
// snapshot with a clean name; catalog edits never touch history." There is
// deliberately NO separate "cart" table -- a job's cart IS simply the set
// of product_snapshots rows with attached_to_type='JOB_MATERIAL_LIST' and
// attached_to_id=<jobber job id>. Reading the cart, adding to it, and
// removing a line are just CRUD against product_snapshots scoped to that
// job. This keeps Phase 1 honest: it's a real, persisted material list
// tied to a real job (via api/jobs.js's getJobsListData), not a mock.
//
// Dedup strategy is intentionally the SIMPLE version of PRD S3.4, not the
// full AI-normalized "manufacturer-first Product Master" pass (S3.5, out
// of scope tonight): a (vendor_key, vendor_sku) match reuses the existing
// products/vendor_offers rows (there's a unique index on that pair
// already, sql/008); anything new creates a fresh products row named
// directly from the vendor's raw title (name_reviewed=false,
// name_confidence=null, created_from='vendor-import') and a fresh
// vendor_offers row. No UPC-based or model-number+brand fuzzy matching --
// that's real, separate work for the S3.5 AI naming pass, not faked here.
async function upsertProductAndOffer(item) {
  const vendorKey = item.vendor_key || 'homedepot';
  const vendorSku = item.vendor_sku || null;

  if (vendorSku) {
    const existing = await supabaseRequest(
      `vendor_offers?vendor_key=eq.${encodeURIComponent(vendorKey)}&vendor_sku=eq.${encodeURIComponent(vendorSku)}&select=*&limit=1`
    );
    if (existing.ok) {
      const rows = await existing.json();
      if (rows.length) {
        const offer = rows[0];
        // Touch price/image/link + last_verified_at so the offer reflects
        // what the user actually saw and added just now, without creating a
        // duplicate row for the same vendor SKU.
        const patch = await supabaseRequest(`vendor_offers?id=eq.${offer.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            unit_price: item.unit_price ?? offer.unit_price,
            image_url: item.image_url || offer.image_url,
            product_url: item.product_url || offer.product_url,
            last_verified_at: new Date().toISOString(),
          }),
        });
        const patched = patch.ok ? (await patch.json())[0] : null;
        return { productId: offer.product_id, vendorOffer: patched || offer };
      }
    }
  }

  const productRow = {
    standard_name: item.vendor_title || 'Untitled product',
    name_confidence: null,
    name_reviewed: false,
    manufacturer: item.brand || null,
    category: null,
    unit_of_measure: null,
    spec_attributes: item.raw_specifications || {},
    image_primary: item.image_url || null,
    created_from: 'vendor-import',
    status: 'active',
  };
  const pRes = await supabaseRequest('products', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(productRow),
  });
  if (!pRes.ok) throw new Error(`Failed to create product: ${await pRes.text()}`);
  const product = (await pRes.json())[0];

  const offerRow = {
    product_id: product.id,
    vendor_key: vendorKey,
    connector_type: 'api',
    vendor_sku: vendorSku,
    store_sku: item.store_sku || null,
    vendor_title: item.vendor_title || '',
    manufacturer_model_number: item.manufacturer_model_number || null,
    brand: item.brand || null,
    package_qty: item.package_qty || null,
    unit_price: item.unit_price ?? null,
    bulk_price_tiers: item.bulk_price_tiers || null,
    product_url: item.product_url || null,
    image_url: item.image_url || null,
    currency: item.currency || 'USD',
    source: item.source || `${vendorKey}:manual`,
  };
  const oRes = await supabaseRequest('vendor_offers', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(offerRow),
  });
  if (!oRes.ok) throw new Error(`Failed to create vendor offer: ${await oRes.text()}`);
  const offer = (await oRes.json())[0];
  return { productId: product.id, vendorOffer: offer };
}

// Cart items attach to either a job's material list or a Jobber quote
// (Chris's "save it to an Estimate" ask, 2026-07-21). Both are real,
// already-synced records (api/jobs.js's jobs table / RESOURCE_CONFIG's
// quotes table) -- this does NOT let a snapshot attach to a specific
// line item/"activity" *inside* a quote, because Jobber's individual
// quote line items are never synced (api/jobber/sync-extended.js's
// QUOTES_QUERY/mapQuote only pull header-level quote fields -- no line
// items, no write-back capability to Jobber exists at all). Attaching to
// the quote as a whole (ESTIMATE_LINE_ITEM, attached_to_id = the quote's
// jobber_id) is the honest version of that ask with the data actually on
// hand; a true per-activity picker is real, separate work for whenever
// quote line items get synced.
const CART_TARGET_TYPES = ['JOB_MATERIAL_LIST', 'ESTIMATE_LINE_ITEM'];

// A cart line can be added two ways now (Chris's ask, 2026-07-21: "we
// should be able to build the cart and save it and then add job/estimate
// details"): with a real target_type/target_id (unchanged, original
// behavior), OR with only a draft_cart_id -- a client-generated id (see
// the vcx frontend) grouping items that haven't been linked to a job or
// estimate yet. Draft rows are real, saved product_snapshots rows (not
// client-memory-only) -- see sql/010_cart_draft_support.sql, which makes
// attached_to_type/attached_to_id nullable and adds draft_cart_id with a
// CHECK enforcing exactly one of (attached target) or (draft_cart_id) is
// set, never both, never neither.
async function handleMaterialsCartAdd(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const body = req.body || {};
  const targetId = body.target_id || body.job_id || null; // job_id kept as an alias for the original job-only shape
  const targetType = targetId ? (CART_TARGET_TYPES.includes(body.target_type) ? body.target_type : 'JOB_MATERIAL_LIST') : null;
  const draftCartId = body.draft_cart_id || null;
  const product = body.product;
  const quantity = Number(body.quantity) > 0 ? Number(body.quantity) : 1;
  if (!targetId && !draftCartId) {
    return res.status(400).json({ ok: false, error: 'Either target_id (job id or quote id) or draft_cart_id is required.' });
  }
  if (!product || !product.vendor_title) {
    return res.status(400).json({ ok: false, error: 'product (with at least vendor_title) is required.' });
  }

  try {
    const { productId, vendorOffer } = await upsertProductAndOffer(product);
    const snapshotRow = {
      product_id: productId,
      vendor_offer_id: vendorOffer.id,
      attached_to_type: targetId ? targetType : null,
      attached_to_id: targetId ? String(targetId) : null,
      draft_cart_id: targetId ? null : draftCartId,
      title: product.vendor_title,
      vendor_title: product.vendor_title,
      image_url: product.image_url || null,
      sku: product.vendor_sku || null,
      model_number: product.manufacturer_model_number || null,
      spec_attributes: product.raw_specifications || {},
      package_qty: product.package_qty || null,
      quantity,
      quoted_price: Number(product.unit_price) || 0,
      source_url: product.product_url || null,
    };
    const sRes = await supabaseRequest('product_snapshots', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(snapshotRow),
    });
    if (!sRes.ok) return res.status(502).json({ ok: false, error: `Failed to save snapshot: ${await sRes.text()}` });
    const saved = (await sRes.json())[0];
    return res.status(200).json({ ok: true, resource: 'materials_cart_add', snapshot: saved });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
}

async function handleMaterialsCartGet(req, res) {
  const draftCartId = req.query.draft_cart_id || null;
  let filter;
  if (draftCartId) {
    filter = `draft_cart_id=eq.${encodeURIComponent(draftCartId)}`;
  } else {
    const targetType = CART_TARGET_TYPES.includes(req.query.target_type) ? req.query.target_type : 'JOB_MATERIAL_LIST';
    const targetId = req.query.target_id || req.query.job_id; // job_id kept as an alias for the original job-only shape
    if (!targetId) return res.status(400).json({ ok: false, error: 'resource=materials_cart_get requires ?target_id=<job or quote id> or ?draft_cart_id=<id>' });
    filter = `attached_to_type=eq.${encodeURIComponent(targetType)}&attached_to_id=eq.${encodeURIComponent(String(targetId))}`;
  }
  const r = await supabaseRequest(`product_snapshots?${filter}&select=*&order=captured_at.asc`);
  if (!r.ok) return res.status(502).json({ ok: false, error: `Failed to load cart: ${await r.text()}` });
  const items = await r.json();
  const total = items.reduce((sum, i) => sum + (Number(i.quoted_price) || 0) * (Number(i.quantity) || 1), 0);
  return res.status(200).json({ ok: true, resource: 'materials_cart_get', draftCartId, items, total });
}

// Moves every item in a draft cart onto a real job/estimate in one shot --
// the "then add job/estimate details" half of Chris's ask. Safe to call
// even if the draft cart is already empty (0 rows matched is a no-op, not
// an error).
async function handleMaterialsCartAttach(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const body = req.body || {};
  const draftCartId = body.draft_cart_id;
  const targetType = CART_TARGET_TYPES.includes(body.target_type) ? body.target_type : null;
  const targetId = body.target_id;
  if (!draftCartId || !targetType || !targetId) {
    return res.status(400).json({ ok: false, error: 'draft_cart_id, target_type, and target_id are all required.' });
  }
  const r = await supabaseRequest(`product_snapshots?draft_cart_id=eq.${encodeURIComponent(draftCartId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ attached_to_type: targetType, attached_to_id: String(targetId), draft_cart_id: null }),
  });
  if (!r.ok) return res.status(502).json({ ok: false, error: `Failed to attach cart: ${await r.text()}` });
  const moved = await r.json();
  return res.status(200).json({ ok: true, resource: 'materials_cart_attach', attachedCount: moved.length, items: moved });
}

// A job's material list is a live working draft in Phase 1 -- not yet a
// locked PO (that's Phase 2+, per the PRD's phasing table) -- so removing a
// line here is a normal edit, not a rewrite of quoted history. Once a
// snapshot is actually referenced by an issued purchase_order, that's the
// point it becomes truly immutable; that guard belongs in the Phase 2 PO
// build, not invented here ahead of the table existing.
async function handleMaterialsCartRemove(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return res.status(405).json({ ok: false, error: 'POST or DELETE only' });
  const id = req.query.id || (req.body && req.body.id);
  if (!id) return res.status(400).json({ ok: false, error: 'resource=materials_cart_remove requires ?id=<snapshot id>' });
  const r = await supabaseRequest(`product_snapshots?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) return res.status(502).json({ ok: false, error: `Failed to remove line: ${await r.text()}` });
  return res.status(200).json({ ok: true, resource: 'materials_cart_remove', id });
}

// The master to-do (Chris's ask, 2026-07-21): "hourly auto refreshing to
// the hivelogic app... so everyone is working on the same thing." Until
// now this only existed as a Claude Cowork artifact / Google Doc, which
// Jovie's Team account can't see (different Claude.ai account = no
// visibility into Chris's Build Reina project or its artifacts). This is
// a single-row live snapshot (id='current', not history) written by the
// hourly "Reina Master To-Do Refresh" scheduled task and read by the
// Command Center "Team To-Do" card -- see sql/011_reina_todo.sql.
//
// 2026-08-16 (Team To-Do operational rewire): the Command Center card no
// longer reads this at all -- it now shows real HiveConnect tasks plus
// computed operational detections (resource=team_todo_detections below).
// reina_todo and its hourly reina_todo_set push are deliberately left intact;
// this read is now the backing store for the admin-only "Dev To-Do" view,
// which is where the engineering list lives from here on. Gated to admin /
// superadmin / owner accordingly -- it is an internal engineering backlog,
// not something every field account should be reading.
export const DEV_TODO_ALLOWED_PERMISSION_ROLES = ['owner'];

async function canManageDevTodo(requester) {
  if (!requester) return false;
  if (requester.role === 'admin' || requester.role === 'superadmin') return true;
  const permissionRoles = await getDispatchPermissionRoles(requester);
  return permissionRoles.some((r) => DEV_TODO_ALLOWED_PERMISSION_ROLES.indexOf(r) !== -1);
}

async function handleReinaTodoGet(req, res) {
  if (res && typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (!(await canManageDevTodo(requester))) return res.status(403).json({ ok: false, error: 'The Dev To-Do list is admin-only.' });
  const r = await supabaseRequest('reina_todo?id=eq.current&select=*');
  if (!r.ok) return res.status(502).json({ ok: false, error: `Failed to load to-do: ${await r.text()}` });
  const rows = await r.json();
  return res.status(200).json({ ok: true, resource: 'reina_todo_get', todo: rows[0] || null });
}

// Shared team status hub: raw sources stay traceable and every human triage
// decision is retained in app_status_events. This is intentionally separate
// from the historical reina_todo summary snapshot.
async function handleAppStatusFindings(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (!(await canManageDevTodo(requester))) return res.status(403).json({ ok: false, error: 'The team status hub is admin-only.' });
  try {
    const findings = await listFindings();
    const findingsWithAttachments = await attachSignedAttachments(findings);
    return res.status(200).json({ ok: true, resource: 'app_status_findings', findings: findingsWithAttachments });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
}

// Most findings (every automated selftest/daily_health one) never get an
// attached image, so this skips the per-row signing work entirely for them --
// only rows a human actually attached a picture to pay the extra round trip.
async function attachSignedAttachments(findings) {
  const rows = await listFindingAttachments((findings || []).map((f) => f.id));
  if (!rows.length) return (findings || []).map((f) => ({ ...f, attachments: [] }));
  const byFinding = new Map();
  for (const row of rows) {
    if (!byFinding.has(row.finding_id)) byFinding.set(row.finding_id, []);
    byFinding.get(row.finding_id).push(row);
  }
  return Promise.all((findings || []).map(async (f) => {
    const own = byFinding.get(f.id);
    if (!own || !own.length) return { ...f, attachments: [] };
    const signed = await Promise.all(own.map(async (a) => {
      const signRes = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/sign/devtodo-attachments/${a.storage_path}`, {
        method: 'POST',
        headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 300 }),
      });
      const signData = signRes.ok ? await signRes.json() : null;
      return { id: a.id, contentType: a.content_type, createdAt: a.created_at, url: signData && signData.signedURL ? `${process.env.SUPABASE_URL}/storage/v1${signData.signedURL}` : null };
    }));
    return { ...f, attachments: signed };
  }));
}

async function handleAppStatusUpdate(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (!(await canManageDevTodo(requester))) return res.status(403).json({ ok: false, error: 'Only an admin can triage findings.' });
  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch (e) { return {}; } })() : (req.body || {});
  const id = String(body.id || '').trim();
  const status = String(body.status || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ ok: false, error: 'A finding id is required.' });
  try {
    const finding = await setFindingStatus(id, status, body.note, requester.id);
    return res.status(200).json({ ok: true, resource: 'app_status_update', finding });
  } catch (e) {
    return res.status(/Invalid|not found/i.test(String(e.message || e)) ? 400 : 502).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
}

async function handleAppStatusCreate(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (!(await canManageDevTodo(requester))) return res.status(403).json({ ok: false, error: 'Only an admin can report a blocker.' });
  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch (e) { return {}; } })() : (req.body || {});
  try {
    const result = await createManualFinding(body, requester.id);
    let notification = { attempted: false, delivered: false };
    // High findings should reach the team where they already collaborate. Do
    // not turn a successfully recorded blocker into a false client error if
    // the independently configured bot/channel is temporarily unavailable.
    // 'critical' sorts ABOVE 'high' in the queue's own urgency order
    // ({critical:0,high:1,...}), so alerting on 'high' alone left the most
    // severe blocker as the only one that arrived silently.
    if (result.created && ['critical', 'high'].includes(result.finding.severity)) {
      notification.attempted = true;
      try {
        const channelId = process.env.REINA_BOT_DEFAULT_CHANNEL_ID;
        if (!channelId) throw new Error('HiveConnect alert channel is not configured.');
        const assignee = result.finding.assigned_to ? ` Assigned to: ${result.finding.assigned_to}.` : '';
        const due = result.finding.due_date ? ` Due: ${result.finding.due_date}.` : '';
        await postBotMessage(channelId, `🚨 HIGH DEV TO-DO BLOCKER: ${result.finding.title}.${assignee}${due}`);
        notification.delivered = true;
      } catch (notificationError) {
        notification.error = String(notificationError.message || notificationError).slice(0, 180);
      }
    }
    return res.status(200).json({ ok: true, resource: 'app_status_create', finding: result.finding, notification });
  } catch (e) {
    return res.status(/Invalid|required/i.test(String(e.message || e)) ? 400 : 502).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
}

// So whoever picks up a Dev To-Do finding has a clear picture of what's
// wrong, not just a text summary. Reuses the exact same magic-byte
// PNG/JPEG validation as the Monitor screenshot upload (validateScreenshotBase64)
// -- the client-declared content-type is never trusted either way.
async function handleAppStatusAttachmentUpload(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (!(await canManageDevTodo(requester))) return res.status(403).json({ ok: false, error: 'Only an admin can attach an image to a finding.' });
  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch (e) { return {}; } })() : (req.body || {});
  const findingId = String(body.finding_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(findingId)) return res.status(400).json({ ok: false, error: 'A finding id is required.' });
  const shot = validateScreenshotBase64(body.imageBase64);
  if (!shot.ok) return res.status(shot.status).json({ ok: false, error: shot.error });
  try {
    const attachment = await addFindingAttachment(findingId, shot, requester.id);
    return res.status(200).json({ ok: true, resource: 'app_status_attachment_upload', attachment });
  } catch (e) {
    return res.status(/not found|Too many/i.test(String(e.message || e)) ? 400 : 502).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
}

// ---------- Team To-Do "Needs attention" detections (2026-08-16) ----------
// Source B of the rewired Team To-Do card: operational work the business can
// SEE it owes, computed live, stored nowhere. Every row is read-only -- the
// card renders an icon, a count/amount and a deep link; clicking navigates,
// nothing here executes anything.
//
// Separation rule (Chris, 2026-08-16): Today's Decisions = anything needing
// Chris's approval / a yes-no. Team To-Do = anything needing execution. An
// item never appears in both, so every detection below is tagged
// category:'execution' and the frontend drops any row that isn't -- see
// teamTodoDedupe() in public/index.html.
//
// Honesty rule: a detection whose source is unavailable renders as an
// explicit "unavailable" row carrying the real reason. Never hidden, never a
// stale number shown as fresh, never a fabricated one.
export const TEAM_TODO_BUSINESS_TZ = 'America/New_York';
export const TEAM_TODO_BUSINESS_START_HOUR = 8;
export const TEAM_TODO_BUSINESS_END_HOUR = 17;
export const TEAM_TODO_EMAIL_BUSINESS_HOURS = 4;
export const TEAM_TODO_VENDOR_PAYMENT_WINDOW_DAYS = 7;
// How far back "past due" reaches. Chris's call (2026-08-16), after the first
// live render showed 102 past-due bills behind one number: a full year of AP
// aging reads as noise, not as a to-do. 90 days keeps the row actionable --
// anything older is an accounting problem for the Financial tab, not a
// this-week payment run.
export const TEAM_TODO_PAST_DUE_LOOKBACK_DAYS = 90;

function ttZonedParts(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
  };
}
// A "wall clock" value is Date.UTC() applied to the zone's local fields, i.e.
// the local time pretending to be UTC. Converting back to a real instant needs
// the zone's offset at (approximately) that moment -- resolved by one
// correction pass, which is exact except inside a DST transition hour.
function ttWallMs(instantMs, timeZone) {
  const p = ttZonedParts(instantMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}
function ttWallToInstant(wallMs, timeZone) {
  let guess = wallMs - (ttWallMs(wallMs, timeZone) - wallMs);
  guess = wallMs - (ttWallMs(guess, timeZone) - guess);
  return guess;
}

// Walks BACKWARDS `hours` business hours from `nowMs`, where a business hour
// is Mon-Fri 08:00-17:00 in TEAM_TODO_BUSINESS_TZ. Exported for tests: this is
// the whole definition of "awaiting reply", so it is worth pinning down.
export function teamTodoBusinessHoursAgo(nowMs, hours = TEAM_TODO_EMAIL_BUSINESS_HOURS, timeZone = TEAM_TODO_BUSINESS_TZ) {
  const MIN = 60000;
  const dayStart = (wall) => { const d = new Date(wall); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), TEAM_TODO_BUSINESS_START_HOUR); };
  const dayEnd = (wall) => { const d = new Date(wall); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), TEAM_TODO_BUSINESS_END_HOUR); };
  const isWeekend = (wall) => { const dow = new Date(wall).getUTCDay(); return dow === 0 || dow === 6; };
  const prevDayEnd = (wall) => dayEnd(wall - 24 * 60 * MIN);

  let cursor = ttWallMs(nowMs, timeZone);
  let remaining = Math.max(0, hours) * 60 * MIN;
  // Clamp into the most recent business moment at or before `cursor`.
  let guard = 0;
  while (guard++ < 400) {
    if (isWeekend(cursor)) { cursor = prevDayEnd(cursor); continue; }
    if (cursor > dayEnd(cursor)) { cursor = dayEnd(cursor); continue; }
    if (cursor < dayStart(cursor)) { cursor = prevDayEnd(cursor); continue; }
    break;
  }
  guard = 0;
  while (remaining > 0 && guard++ < 400) {
    const available = cursor - dayStart(cursor);
    if (remaining <= available) { cursor -= remaining; remaining = 0; break; }
    remaining -= available;
    cursor = prevDayEnd(cursor);
    while (isWeekend(cursor)) cursor = prevDayEnd(cursor);
  }
  return ttWallToInstant(cursor, timeZone);
}

function ttRow(extra) {
  return { category: 'execution', state: 'ok', count: null, amount: null, detail: null, reason: null, ...extra };
}

// 1. Emails awaiting reply -- unread inbox mail older than 4 business hours,
// in THE CALLER'S OWN mailboxes.
//
// FIXED 2026-08-17 (Chris: "fix the emails awaiting reply source"). This read
// the `integrations` key='microsoft' row -- a single shared org mailbox behind
// resource=mailconnect that nobody ever finished connecting. So it reported
// "Microsoft 365 is not connected" permanently, which was true of that row and
// meaningless to the person reading it, whose mail was connected the whole
// time. Everyone's real mailboxes live in hc_ms_tokens, connected through
// /api/msmail by HiveConnect Email -- one row per person per mailbox.
//
// Reading the caller's own rows also retires the admin gate that used to gate
// this row. That gate existed because the old source was a SHARED mailbox, and
// a count of someone else's mail is not something every role should get through
// a side door. Your own unread count carries no such problem, and telling an
// employee their own inbox is "admin-only" was the gate misfiring, not working.
const TEAM_TODO_INBOX_SCAN_LIMIT = 100;

async function ttMailboxesForOwner(ownerId) {
  const r = await supabaseRequest(
    `hc_ms_tokens?owner_id=eq.${encodeURIComponent(ownerId)}` +
    '&select=home_account_id,username,name,access_token,refresh_token,expires_at&order=updated_at.desc'
  );
  if (!r.ok) throw new Error((await r.text()).slice(0, 120));
  return (await r.json()) || [];
}

// Unread mail older than the cutoff in ONE mailbox. Throws on a dead mailbox so
// the caller can report exactly how much of the picture it managed to get.
async function ttMailboxUnreadOlderThan(row, ownerId, cutoffMs) {
  const minted = await mailboxAccessToken(row, {
    encryptSecret: _encSecret,
    decryptSecret: _decSecret,
    patchTokens: (patch) => supabaseRequest(
      `hc_ms_tokens?owner_id=eq.${encodeURIComponent(ownerId)}&home_account_id=eq.${encodeURIComponent(row.home_account_id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) }
    ),
  });
  const gRes = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=${TEAM_TODO_INBOX_SCAN_LIMIT}` +
    '&$filter=isRead eq false&$orderby=receivedDateTime desc&$select=id,receivedDateTime',
    { headers: { Authorization: 'Bearer ' + minted.accessToken } }
  );
  const data = await gRes.json().catch(() => ({}));
  if (!gRes.ok) throw new Error((data.error && data.error.message) || `inbox read failed (${gRes.status})`);
  const msgs = data.value || [];
  return {
    stale: msgs.filter((m) => m.receivedDateTime && new Date(m.receivedDateTime).getTime() <= cutoffMs).length,
    scanned: msgs.length,
  };
}

// The mail Reina has actually flagged as wanting something from you.
//
// Chris, 2026-08-17: "I want Reina to pick the priority emails and bring you a
// to-do notification to handle them."
//
// The three action labels are the priority ones; fyi and junk are by definition
// not. Anything he has already acted on drops out. Reads the stored verdicts
// only -- no Graph call, no model call, so putting this on the Command Center
// costs nothing per page load.
async function ttReinaPriorityEmails(ownerId) {
  const r = await supabaseRequest(
    `reina_mail_triage?owner_id=eq.${encodeURIComponent(ownerId)}&acted_at=is.null` +
    '&select=label,corrected_label&limit=500'
  );
  if (!r.ok) return null;
  const rows = (await r.json()) || [];
  const out = { needs_reply: 0, needs_scheduling: 0, needs_action: 0, total: 0 };
  for (const row of rows) {
    const label = row.corrected_label || row.label;   // his call outranks hers
    if (!(label in out)) continue;
    out[label]++; out.total++;
  }
  return out;
}

async function ttDetectEmailsAwaitingReply(requester, nowMs) {
  const base = { key: 'emails_awaiting_reply', icon: '✉️', label: 'Emails awaiting reply', view: 'hiveconnect_email' };
  const unavailable = (reason) => ttRow({ ...base, state: 'unavailable', reason });

  let mailboxes;
  try {
    mailboxes = await ttMailboxesForOwner(requester.id);
  } catch (e) {
    return unavailable('Email feed offline — ' + String(e.message || e).slice(0, 120));
  }
  if (!mailboxes.length) {
    return unavailable('No mailbox connected — connect one in HiveConnect Email.');
  }

  const cutoffMs = teamTodoBusinessHoursAgo(nowMs);
  const results = await Promise.all(mailboxes.map((m) =>
    ttMailboxUnreadOlderThan(m, requester.id, cutoffMs)
      .then((v) => ({ ok: true, ...v, box: m }))
      .catch((e) => ({ ok: false, box: m, error: e }))));

  const read = results.filter((r) => r.ok);
  if (!read.length) {
    // Every mailbox failed. "Sign in again" and "Microsoft is down" are
    // different problems for the person reading the row, so say which.
    if (results.every((r) => r.error && r.error.reauth)) {
      return unavailable('Mailbox needs reconnecting — open HiveConnect Email.');
    }
    const first = results.find((r) => r.error);
    return unavailable('Email feed offline — ' + String((first && first.error && first.error.message) || 'inbox read failed').slice(0, 120));
  }

  const count = read.reduce((s, r) => s + r.stale, 0);
  const failed = results.length - read.length;
  // A partial read is not a wrong number, but it IS an incomplete one, and a
  // count whose scope is invisible invites the wrong conclusion. Say so.
  const parts = [count ? `unread ${TEAM_TODO_EMAIL_BUSINESS_HOURS}+ business hours` : 'inbox is current'];
  if (failed) parts.push(`${read.length} of ${results.length} mailboxes read`);
  else if (read.length > 1) parts.push(`across ${read.length} mailboxes`);
  if (read.some((r) => r.scanned >= TEAM_TODO_INBOX_SCAN_LIMIT)) parts.push(`first ${TEAM_TODO_INBOX_SCAN_LIMIT} unread scanned`);

  // If Reina has actually triaged this mail, HER reading beats a raw unread
  // count -- Chris asked for "the priority emails" surfaced as a to-do, and
  // "unread for four hours" is a clock, not a judgement. Falls back to the
  // clock when there is no triage yet, so the row never goes blank waiting.
  const picked = await ttReinaPriorityEmails(requester.id).catch(() => null);
  if (picked && picked.total) {
    const bits = [];
    if (picked.needs_reply) bits.push(`${picked.needs_reply} to answer`);
    if (picked.needs_action) bits.push(`${picked.needs_action} to act on`);
    if (picked.needs_scheduling) bits.push(`${picked.needs_scheduling} to schedule`);
    return ttRow({
      ...base,
      label: 'Emails Reina flagged',
      count: picked.total,
      detail: bits.join(' · ') + ' · open Email to handle them',
      source: 'reina_triage',
      breakdown: picked,
    });
  }

  return ttRow({
    ...base,
    count,
    detail: parts.join(' · '),
    cutoff: new Date(cutoffMs).toISOString(),
    mailboxesRead: read.length,
    mailboxesTotal: results.length,
  });
}

// 2. Estimates to finalize -- quotes still in Jobber's own 'draft' status,
// from the existing Jobber-mirrored quotes table. Read-only: this repo never
// writes to Jobber. Distinct from the Decisions feed's "quotes awaiting a
// client RESPONSE" (quote_status=awaiting_response), which is a follow-up
// call, not unfinished paperwork.
async function ttDetectEstimatesToFinalize() {
  const base = { key: 'estimates_to_finalize', icon: '📝', label: 'Estimates to finalize', view: 'estimates' };
  try {
    const r = await supabaseRequest('quotes?select=jobber_id,total&quote_status=eq.draft&limit=500');
    if (!r.ok) throw new Error((await r.text()).slice(0, 120));
    const rows = await r.json();
    const total = (rows || []).reduce((s, q) => s + (Number(q.total) || 0), 0);
    return ttRow({
      ...base,
      count: (rows || []).length,
      amount: fiRound2(total),
      detail: (rows || []).length ? 'still in draft' : 'nothing in draft',
    });
  } catch (e) {
    return ttRow({ ...base, state: 'unavailable', reason: 'Estimates feed offline — ' + String(e.message || e).slice(0, 120) });
  }
}

// 3. Vendor payments due -- QuickBooks bills with a balance, due within 7
// days or already past due. The QBO read path accepts a signed-in financial
// role here; scheduled QBO status/financial reads separately accept the exact
// CRON_SECRET. Both paths fail closed for anonymous callers. No fallback
// numbers, ever.
async function ttDetectVendorPaymentsDue(requester, permissionRoles) {
  const base = { key: 'vendor_payments_due', icon: '💸', label: 'Vendor payments due', view: 'financial' };
  const financialAllowed = requester.role === 'admin' || requester.role === 'superadmin'
    || permissionRoles.some((r) => ['owner', 'office_ar'].indexOf(r) !== -1);
  if (!financialAllowed) {
    return ttRow({ ...base, state: 'unavailable', reason: 'Your role does not have access to financial data.' });
  }
  try {
    const data = await getFinancials('bills_due_range', {
      start_date: fiAddDaysISO(-TEAM_TODO_PAST_DUE_LOOKBACK_DAYS),
      end_date: fiAddDaysISO(TEAM_TODO_VENDOR_PAYMENT_WINDOW_DAYS),
    });
    if (!data || data.error) {
      const status = data && data.qboStatus ? ` (QuickBooks returned ${data.qboStatus})` : '';
      return ttRow({ ...base, label: 'Financial feed offline', state: 'unavailable', reason: 'Vendor payments unavailable' + status + '.' });
    }
    const bills = data.bills || [];
    const today = fiTodayISO();
    const pastDue = bills.filter((b) => b.due && b.due < today);
    return ttRow({
      ...base,
      count: bills.length,
      amount: fiRound2(bills.reduce((s, b) => s + (Number(b.balance) || 0), 0)),
      // The window is named in the row itself: a count whose scope is invisible
      // invites exactly the "why is that number so big?" question this bound
      // was added to answer.
      detail: bills.length
        ? `${pastDue.length} past due (last ${TEAM_TODO_PAST_DUE_LOOKBACK_DAYS} days) · rest due within ${TEAM_TODO_VENDOR_PAYMENT_WINDOW_DAYS} days`
        : `nothing due in the next ${TEAM_TODO_VENDOR_PAYMENT_WINDOW_DAYS} days`,
      pastDueCount: pastDue.length,
      pastDueLookbackDays: TEAM_TODO_PAST_DUE_LOOKBACK_DAYS,
    });
  } catch (e) {
    return ttRow({ ...base, label: 'Financial feed offline', state: 'unavailable', reason: 'Vendor payments unavailable — ' + String(e.message || e).slice(0, 120) });
  }
}

async function handleTeamTodoDetections(req, res) {
  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const permissionRoles = await getDispatchPermissionRoles(requester);
  const nowMs = Date.now();
  const detections = await Promise.all([
    ttDetectEmailsAwaitingReply(requester, nowMs).catch((e) => ttRow({ key: 'emails_awaiting_reply', icon: '✉️', label: 'Emails awaiting reply', view: 'hiveconnect_email', state: 'unavailable', reason: String(e.message || e).slice(0, 120) })),
    ttDetectEstimatesToFinalize().catch((e) => ttRow({ key: 'estimates_to_finalize', icon: '📝', label: 'Estimates to finalize', view: 'estimates', state: 'unavailable', reason: String(e.message || e).slice(0, 120) })),
    ttDetectVendorPaymentsDue(requester, permissionRoles).catch((e) => ttRow({ key: 'vendor_payments_due', icon: '💸', label: 'Financial feed offline', view: 'financial', state: 'unavailable', reason: String(e.message || e).slice(0, 120) })),
  ]);
  return res.status(200).json({ ok: true, resource: 'team_todo_detections', asOf: new Date(nowMs).toISOString(), detections });
}

async function handleReinaTodoSet(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const body = req.body || {};
  if (!Array.isArray(body.sections)) {
    return res.status(400).json({ ok: false, error: 'sections (array of {title, items:[{text, priority}]}) is required' });
  }
  const row = {
    id: 'current',
    sections: body.sections,
    flags: Array.isArray(body.flags) ? body.flags : [],
    content_md: body.content_md || null,
    source: body.source || 'unknown',
    generated_at: new Date().toISOString(),
  };
  const r = await supabaseRequest('reina_todo?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });
  if (!r.ok) return res.status(502).json({ ok: false, error: `Failed to save to-do: ${await r.text()}` });
  const saved = (await r.json())[0];
  return res.status(200).json({ ok: true, resource: 'reina_todo_set', todo: saved });
}


// Job Workflow (Chris's ask, 2026-07-21: "make everything live under Jobs,
// page by page"). The Jobs board has always shown 8 pipeline columns
// (Approved-Awaiting Deposit, Awaiting Job Setup, Waiting for Materials,
// etc.) but Jobber's real sync only gives 7 unrelated statuses (unscheduled/
// upcoming/today/late/action_required/requires_invoicing/archived) -- none
// of those map to "deposit paid" or "materials ordered". Rather than fake
// those columns, this is the real missing data: one row per job, staff-
// updated, that the frontend combines with the real Jobber status to bucket
// a job into a column. See sql/014_job_workflow.sql.
async function handleJobWorkflowList(req, res) {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const r = await supabaseRequest(`job_workflow?select=*&limit=${pageSize}&offset=${offset}`);
    if (!r.ok) return res.status(502).json({ ok: false, error: `Failed to load job workflow: ${await r.text()}` });
    const page = await r.json();
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return res.status(200).json({ ok: true, resource: 'job_workflow_list', rows });
}

// Fetch-then-upsert (not a blind upsert) so a boolean toggle like
// depositPaid:true only stamps deposit_paid_at the first time it flips --
// re-sending the same toggle doesn't reset an already-real timestamp, and
// depositPaid:false always clears it. Every other field falls back to
// whatever's already stored so a partial update (e.g. just moving the
// materials dropdown) never clobbers the rest of the row.
async function handleJobWorkflowSet(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const body = req.body || {};
  const jobRef = body.jobRef || body.job_ref;
  if (!jobRef) return res.status(400).json({ ok: false, error: 'jobRef (jobs.jobber_id) is required' });

  const existingR = await supabaseRequest(`job_workflow?job_ref=eq.${encodeURIComponent(jobRef)}&select=*`);
  if (!existingR.ok) return res.status(502).json({ ok: false, error: `Failed to load existing workflow row: ${await existingR.text()}` });
  const existingRows = await existingR.json();
  const existing = existingRows[0] || {};

  const now = new Date().toISOString();
  const row = {
    job_ref: jobRef,
    deposit_required: body.depositRequired != null ? Number(body.depositRequired) : (existing.deposit_required ?? null),
    deposit_amount: body.depositAmount != null ? Number(body.depositAmount) : (existing.deposit_amount ?? null),
    deposit_paid_at: typeof body.depositPaid === 'boolean'
      ? (body.depositPaid ? (existing.deposit_paid_at || now) : null)
      : (existing.deposit_paid_at ?? null),
    setup_complete_at: typeof body.setupComplete === 'boolean'
      ? (body.setupComplete ? (existing.setup_complete_at || now) : null)
      : (existing.setup_complete_at ?? null),
    materials_status: body.materialsStatus || existing.materials_status || 'not_ordered',
    materials_eta: body.materialsEta !== undefined ? (body.materialsEta || null) : (existing.materials_eta ?? null),
    on_hold_at: typeof body.onHold === 'boolean'
      ? (body.onHold ? (existing.on_hold_at || now) : null)
      : (existing.on_hold_at ?? null),
    on_hold_reason: body.onHoldReason !== undefined ? (body.onHoldReason || null) : (existing.on_hold_reason ?? null),
    notes: body.notes !== undefined ? (body.notes || null) : (existing.notes ?? null),
    updated_by: body.updatedBy || existing.updated_by || null,
    updated_at: now,
  };

  const r = await supabaseRequest('job_workflow?on_conflict=job_ref', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });
  if (!r.ok) return res.status(502).json({ ok: false, error: `Failed to save job workflow: ${await r.text()}` });
  const saved = (await r.json())[0];
  return res.status(200).json({ ok: true, resource: 'job_workflow_set', workflow: saved });
}



// Job Setup & Readiness gate (Chris's ask 2026-07-21, confirmed spec: the
// 5-gate/12-item checklist already sketched in the jsx page's own mockup
// script -- Client confirmed, Deposit collected, Materials & POs, Permits &
// documents, Crew assigned). Real per-item state lives in job_workflow's
// readiness_items jsonb column (sql/015). Every item is a human-checked
// checkbox with a real timestamp + who -- nothing here is auto-scored.
// Deposit's "Payment received & cleared" item is the one exception: the
// frontend reads it straight off the existing deposit_paid_at field instead
// of duplicating state, so there's a single source of truth.
async function handleJobReadinessSet(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const body = req.body || {};
  const jobRef = body.jobRef || body.job_ref;
  const itemKey = body.itemKey;
  if (!jobRef) return res.status(400).json({ ok: false, error: 'jobRef (jobs.jobber_id) is required' });
  if (!itemKey) return res.status(400).json({ ok: false, error: 'itemKey is required, e.g. client.start_date' });
  if (typeof body.done !== 'boolean') return res.status(400).json({ ok: false, error: 'done (boolean) is required' });

  const existingR = await supabaseRequest(`job_workflow?job_ref=eq.${encodeURIComponent(jobRef)}&select=*`);
  if (!existingR.ok) return res.status(502).json({ ok: false, error: `Failed to load existing workflow row: ${await existingR.text()}` });
  const existingRows = await existingR.json();
  const existing = existingRows[0] || {};
  const existingItems = existing.readiness_items || {};
  const existingItem = existingItems[itemKey] || {};

  const now = new Date().toISOString();
  const items = {
    ...existingItems,
    [itemKey]: body.done
      ? { done: true, at: existingItem.done ? (existingItem.at || now) : now, by: body.by || existingItem.by || null }
      : { done: false, at: null, by: body.by || null },
  };

  const row = { job_ref: jobRef, readiness_items: items, updated_at: now };
  const r = await supabaseRequest('job_workflow?on_conflict=job_ref', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });
  if (!r.ok) return res.status(502).json({ ok: false, error: `Failed to save readiness item: ${await r.text()}` });
  const saved = (await r.json())[0];
  return res.status(200).json({ ok: true, resource: 'job_readiness_set', workflow: saved });
}

// The gate refuses scheduling for a job with failing items -- the only way
// through is a logged override (name + reason), never a silent bypass.
// Sending { clear: true } removes an existing override (re-locks the gate).
async function handleJobReadinessOverride(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const body = req.body || {};
  const jobRef = body.jobRef || body.job_ref;
  if (!jobRef) return res.status(400).json({ ok: false, error: 'jobRef (jobs.jobber_id) is required' });

  const existingR = await supabaseRequest(`job_workflow?job_ref=eq.${encodeURIComponent(jobRef)}&select=*`);
  if (!existingR.ok) return res.status(502).json({ ok: false, error: `Failed to load existing workflow row: ${await existingR.text()}` });
  const existingRows = await existingR.json();
  const existing = existingRows[0] || {};

  const now = new Date().toISOString();
  let row;
  if (body.clear) {
    row = { job_ref: jobRef, readiness_override_at: null, readiness_override_by: null, readiness_override_reason: null, updated_at: now };
  } else {
    if (!body.by) return res.status(400).json({ ok: false, error: 'by (who is overriding) is required' });
    if (!body.reason) return res.status(400).json({ ok: false, error: 'reason is required -- the override is always logged with a reason' });
    row = {
      job_ref: jobRef,
      readiness_override_at: existing.readiness_override_at || now,
      readiness_override_by: body.by,
      readiness_override_reason: body.reason,
      updated_at: now,
    };
  }

  const r = await supabaseRequest('job_workflow?on_conflict=job_ref', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });
  if (!r.ok) return res.status(502).json({ ok: false, error: `Failed to save override: ${await r.text()}` });
  const saved = (await r.json())[0];
  return res.status(200).json({ ok: true, resource: 'job_readiness_override', workflow: saved });
}


// T&M overview for the Schedule page's T&M lens (Chris's ask: fold T&M into
// Schedule, not a separate sidebar page). Real data only: which jobs are
// flagged T&M, and every invoice generated for them so far, with a paid /
// pending total computed from real tm_invoices rows -- no invented numbers.
async function handleTmOverview(res) {
  const wfR = await supabaseRequest('job_workflow?is_tm=eq.true&select=job_ref,tm_service_type,tm_rate_hourly');
  if (!wfR.ok) return res.status(502).json({ ok: false, error: `Failed to load T&M jobs: ${await wfR.text()}` });
  const wfRows = await wfR.json();

  let jobsByRef = {};
  if (wfRows.length) {
    const inList = wfRows.map((w) => `"${w.job_ref}"`).join(',');
    const jobsR = await supabaseRequest(`jobs?jobber_id=in.(${inList})&select=jobber_id,title,client_id,job_status`);
    if (jobsR.ok) {
      const jobRows = await jobsR.json();
      jobsByRef = Object.fromEntries(jobRows.map((j) => [j.jobber_id, j]));
    }
  }

  const tmJobs = wfRows.map((w) => {
    const j = jobsByRef[w.job_ref] || {};
    return {
      jobRef: w.job_ref,
      title: j.title || null,
      status: j.job_status || null,
      rateHourly: w.tm_rate_hourly != null ? Number(w.tm_rate_hourly) : null,
    };
  });

  const invR = await supabaseRequest(
    'tm_invoices?select=id,invoice_number,job_ref,job_title,client_name,hours,rate_hourly,labor_amount,materials_amount,total_amount,status,created_at,paid_at&order=created_at.desc&limit=50'
  );
  if (!invR.ok) return res.status(502).json({ ok: false, error: `Failed to load invoices: ${await invR.text()}` });
  const invoices = await invR.json();

  const totals = invoices.reduce(
    (acc, inv) => {
      const amt = Number(inv.total_amount) || 0;
      acc.totalInvoiced += amt;
      if (inv.status === 'paid') acc.totalPaid += amt;
      else if (inv.status === 'pending') acc.totalPending += amt;
      return acc;
    },
    { totalInvoiced: 0, totalPaid: 0, totalPending: 0 }
  );

  return res.status(200).json({ ok: true, resource: 'tm_overview', tmJobCount: tmJobs.length, tmJobs, invoices, totals });
}

// Live T&M meter (Chris's ask, 2026-07-23): which T&M jobs are on the clock
// RIGHT NOW, for the T&M/Service Lane page's live meter card. Real data only
// -- an open (ended_at is null) job_time_entries row with kind='onsite',
// restricted to jobs job_workflow actually flags is_tm=true with a rate set.
// "onsite" entries exist for non-T&M jobs too (it's the general job timer),
// so the is_tm join is what keeps this meter honest instead of showing every
// tech currently on any job.
async function handleTmLive(res) {
  const openR = await supabaseRequest('job_time_entries?kind=eq.onsite&ended_at=is.null&select=id,tech_id,tech_name,job_ref,visit_ref,client_ref,started_at&order=started_at.asc');
  if (!openR.ok) return res.status(502).json({ ok: false, error: `Failed to load active clocks: ${await openR.text()}` });
  const openRows = await openR.json();
  if (!openRows.length) return res.status(200).json({ ok: true, resource: 'tm_live', active: [] });

  const jobRefs = Array.from(new Set(openRows.map((r) => r.job_ref).filter(Boolean)));
  if (!jobRefs.length) return res.status(200).json({ ok: true, resource: 'tm_live', active: [] });
  const inList = jobRefs.map((r) => `"${r}"`).join(',');

  const wfR = await supabaseRequest(`job_workflow?job_ref=in.(${inList})&is_tm=eq.true&select=job_ref,tm_rate_hourly,tm_service_type`);
  if (!wfR.ok) return res.status(502).json({ ok: false, error: `Failed to load T&M flags: ${await wfR.text()}` });
  const wfRows = await wfR.json();
  const tmByRef = Object.fromEntries(wfRows.map((w) => [w.job_ref, w]));

  const tmOpenRows = openRows.filter((r) => tmByRef[r.job_ref] && Number(tmByRef[r.job_ref].tm_rate_hourly) > 0);
  if (!tmOpenRows.length) return res.status(200).json({ ok: true, resource: 'tm_live', active: [] });

  const tmJobRefs = Array.from(new Set(tmOpenRows.map((r) => r.job_ref)));
  const inList2 = tmJobRefs.map((r) => `"${r}"`).join(',');
  let jobsByRef = {};
  try {
    const jobsR = await supabaseRequest(`jobs?jobber_id=in.(${inList2})&select=jobber_id,title,client_id`);
    if (jobsR.ok) {
      const jobRows = await jobsR.json();
      jobsByRef = Object.fromEntries(jobRows.map((j) => [j.jobber_id, j]));
    }
  } catch (e) { /* best-effort display info only */ }

  let clientsById = {};
  const clientIds = Array.from(new Set(Object.values(jobsByRef).map((j) => j.client_id).filter(Boolean)));
  if (clientIds.length) {
    try {
      const inList3 = clientIds.map((c) => `"${c}"`).join(',');
      const cR = await supabaseRequest(`clients?jobber_id=in.(${inList3})&select=jobber_id,name`);
      if (cR.ok) {
        const cRows = await cR.json();
        clientsById = Object.fromEntries(cRows.map((c) => [c.jobber_id, c.name]));
      }
    } catch (e) { /* best-effort */ }
  }

  const active = tmOpenRows.map((r) => {
    const wf = tmByRef[r.job_ref];
    const job = jobsByRef[r.job_ref] || {};
    return {
      techName: r.tech_name || 'Tech',
      jobRef: r.job_ref,
      jobTitle: job.title || null,
      clientName: (job.client_id && clientsById[job.client_id]) || null,
      startedAt: r.started_at,
      rateHourly: Number(wf.tm_rate_hourly),
      serviceType: wf.tm_service_type || null,
    };
  });

  return res.status(200).json({ ok: true, resource: 'tm_live', active });
}

// Materials overview for the Schedule page's Materials lens (Chris's ask,
// 2026-07-22: finish Schedule's remaining lens tabs). Backed by real
// job_workflow.materials_status/materials_eta (staff-set, sql/014) joined to
// real job titles/status -- only jobs where staff has actually flagged
// something as ordered or on-site show up here. Deliberately does NOT show
// vendor-reliability %, delivery-vendor names, or PO numbers -- that data
// (sql/010_purchase_orders.sql) lives in a separate purchase-orders engine
// that is built but not yet merged into this app. No score or percentage is
// ever invented to fill that gap (Law 1) -- it's listed as not-available.
async function handleMaterialsOverview(res) {
  const wfR = await supabaseRequest('job_workflow?materials_status=neq.not_ordered&select=job_ref,materials_status,materials_eta,updated_at');
  if (!wfR.ok) return res.status(502).json({ ok: false, error: `Failed to load materials workflow: ${await wfR.text()}` });
  const wfRows = await wfR.json();

  let jobsByRef = {};
  if (wfRows.length) {
    const inList = wfRows.map((w) => `"${w.job_ref}"`).join(',');
    const jobsR = await supabaseRequest(`jobs?jobber_id=in.(${inList})&select=jobber_id,title,client_id,job_status,job_number,project_seq`);
    if (jobsR.ok) {
      const jobRows = await jobsR.json();
      jobsByRef = Object.fromEntries(jobRows.map((j) => [j.jobber_id, j]));
    }
  }

  const items = wfRows.map((w) => {
    const j = jobsByRef[w.job_ref] || {};
    return {
      jobRef: w.job_ref,
      // The schedule board keys its materials lens by the job NUMBER printed
      // on a card; this endpoint is keyed by jobber_id. With no shared key the
      // lens could never join to a visit, which is why it rendered nothing.
      jobNo: j.project_seq ? jobRef(j.project_seq) : (j.job_number != null ? String(j.job_number) : null),
      title: j.title || null,
      status: j.job_status || null,
      materialsStatus: w.materials_status,
      materialsEta: w.materials_eta,
      updatedAt: w.updated_at,
    };
  });

  const ordered = items.filter((i) => i.materialsStatus === 'ordered');
  const onSite = items.filter((i) => i.materialsStatus === 'on_site');

  return res.status(200).json({
    ok: true,
    resource: 'materials_overview',
    counts: { ordered: ordered.length, onSite: onSite.length },
    ordered,
    onSite,
    notAvailable: {
      vendorReliability: 'Vendor on-time % is not tracked yet -- no real vendor-delivery data source is connected.',
      purchaseOrders: 'Full PO tracking (numbers, line items, ship dates) lives in a separate purchase-orders engine that is built but not yet merged into this app.',
    },
  });
}
// Dispatch alerts (Chris's ask, 2026-07-21: make the Jobs tab live, page by
// page -- Schedule was next). The old "Dispatch intelligence" card was 100%
// invented ("Gerry frees up at 11:15", "Sandro running 22 min behind") with
// zero backing data. This is the real replacement: three honest signals
// computed directly from today's real synced visits (same table
// handleCrewSchedule already reads) -- nothing inferred, nothing scored.
//   - running_behind: a visit's real scheduled end has passed and it has no
//     completed_at yet.
//   - gap: a crew member's real schedule has >= GAP_THRESHOLD_MIN idle
//     minutes between two of today's real visits.
//   - overlap: a crew member is double-booked -- two real visits whose real
//     times overlap.
//   - unassigned: a real visit today has no assigned_users at all.
// If none of these are true, the honest answer is "nothing needs a
// decision" -- this endpoint returns an empty alerts array rather than
// inventing one to fill the card.
const DISPATCH_GAP_THRESHOLD_MIN = 45;

async function handleDispatchAlerts(res) {
  const { dateStr, startISO, endISO, nowMs } = todayRangeET();
  const visits = await fiFetchAllRows(
    'visits',
    '?select=jobber_id,title,start_at,end_at,completed_at,assigned_users,client_id,job_id' +
      '&end_at=gte.' + encodeURIComponent(startISO) +
      '&start_at=lte.' + encodeURIComponent(endISO) +
      '&order=start_at.asc'
  );

  const clientIds = [...new Set(visits.map((v) => v.client_id).filter(Boolean))];
  let clientsById = {};
  if (clientIds.length) {
    const r = await supabaseRequest('clients?jobber_id=in.(' + clientIds.join(',') + ')&select=jobber_id,name');
    const list = r.ok ? await r.json() : [];
    clientsById = Object.fromEntries(list.map((c) => [c.jobber_id, c.name]));
  }

  const byCrew = {};
  const unassigned = [];
  for (const v of visits) {
    let assigned = [];
    try {
      assigned = typeof v.assigned_users === 'string' ? JSON.parse(v.assigned_users) : (v.assigned_users || []);
    } catch (e) { assigned = []; }
    const entry = {
      title: v.title,
      clientName: clientsById[v.client_id] || null,
      startAt: v.start_at,
      endAt: v.end_at,
      completedAt: v.completed_at,
      startMs: v.start_at ? new Date(v.start_at).getTime() : null,
      endMs: v.end_at ? new Date(v.end_at).getTime() : null,
    };
    if (!assigned.length) { unassigned.push(entry); continue; }
    for (const person of assigned) {
      const key = person.name || person.id;
      if (!key) continue;
      if (!byCrew[key]) byCrew[key] = [];
      byCrew[key].push(entry);
    }
  }

  const alerts = [];

  Object.keys(byCrew).forEach(function (crewName) {
    const list = byCrew[crewName].slice().sort(function (a, b) { return (a.startMs || 0) - (b.startMs || 0); });
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.endMs && nowMs > v.endMs && !v.completedAt) {
        alerts.push({
          type: 'running_behind', crewName: crewName,
          job: v.title, client: v.clientName,
          scheduledEnd: v.endAt,
          minutesBehind: Math.round((nowMs - v.endMs) / 60000),
        });
      }
      if (i < list.length - 1) {
        const next = list[i + 1];
        if (v.endMs && next.startMs) {
          if (next.startMs > v.endMs) {
            const gapMin = Math.round((next.startMs - v.endMs) / 60000);
            if (gapMin >= DISPATCH_GAP_THRESHOLD_MIN) {
              alerts.push({
                type: 'gap', crewName: crewName,
                freeAt: v.endAt, until: next.startAt, minutes: gapMin,
                afterJob: v.title, beforeJob: next.title,
              });
            }
          } else if (next.startMs < v.endMs) {
            alerts.push({
              type: 'overlap', crewName: crewName,
              jobA: v.title, jobB: next.title,
              aEnd: v.endAt, bStart: next.startAt,
            });
          }
        }
      }
    }
  });

  unassigned.forEach(function (v) {
    alerts.push({ type: 'unassigned', job: v.title, client: v.clientName, startAt: v.startAt, endAt: v.endAt });
  });

  return res.status(200).json({
    ok: true,
    resource: 'dispatch_alerts',
    date: dateStr,
    alertCount: alerts.length,
    alerts: alerts,
    note: 'Computed directly from real synced visit times and crew assignments -- gap/overlap/behind-schedule thresholds only, nothing inferred or guessed.',
  });
}

// Exported for in-process reuse by api/chat.js's get_business_data tool --
// same "call the real function directly instead of a self-HTTP-fetch"
// pattern already used by clients.js/jobs.js/invoices.js's exported
// getClientsData()/getJobsListData()/getInvoicesData(). Deliberately
// ADDITIVE rather than a refactor of the RESOURCE_CONFIG dispatch block
// inside the HTTP handler below: that block also serves this file's other
// ~40 resources and has no test coverage in this repo, so duplicating this
// ~15-line read here is far lower risk than touching it. Read-only, exactly
// mirrors the HTTP handler's own tail dispatch (same table, same order,
// same shape, same not-synced detection) -- if that block's behavior ever
// changes, this should be updated to match.
export async function getTrackResourceData(resource, opts = {}) {
  const cfg = RESOURCE_CONFIG[resource];
  if (!cfg) return { error: `Unknown resource: ${resource}. Must be one of: ${Object.keys(RESOURCE_CONFIG).join(', ')}` };
  const limit = Math.min(Number(opts.limit) || cfg.defaultLimit, 10000);
  const r = await supabaseRequest(`${cfg.table}?select=*&order=${cfg.order}&limit=${limit}`, {
    headers: { Prefer: 'count=exact' }
  });
  if (!r.ok) {
    const text = await r.text();
    const notSynced = /relation .* does not exist/i.test(text);
    return { error: notSynced ? cfg.notSyncedMsg : text };
  }
  const rows = await r.json();
  const shaped = rows.map(cfg.shape);
  const extra = cfg.extra ? cfg.extra(rows) : {};
  return { resource, records: shaped, ...extra };
}

async function hlReadBody(req) {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return req.body;
  if (typeof req.body === 'string' && req.body.length) { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  if (req.method === 'GET' || req.method === 'HEAD') return (req.body && typeof req.body === 'object') ? req.body : {};
  if (req.readableEnded || req.complete) return (req.body && typeof req.body === 'object') ? req.body : {};
  return await new Promise((resolve) => {
    let data = ''; let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const to = setTimeout(() => finish({}), 2000);
    req.on('data', (c) => { data += c; });
    req.on('end', () => { clearTimeout(to); try { finish(data ? JSON.parse(data) : {}); } catch (e) { finish({}); } });
    req.on('error', () => { clearTimeout(to); finish({}); });
  });
}
async function hlEnsureBody(req) { try { const b = await hlReadBody(req); if (b && typeof b === 'object') req.body = b; } catch (e) {} }
function ccCaptureJson(fn) {
  return new Promise((resolve) => {
    const fakeRes = {
      _status: 200,
      status(code) { this._status = code; return this; },
      json(body) { resolve({ status: this._status, body }); },
    };
    Promise.resolve().then(() => fn(fakeRes)).catch((e) => {
      resolve({ status: 500, body: { ok: false, error: e.message } });
    });
  });
}

// Command Center bundle -- combines 5 of the Command Center's independent
// track1 resource calls (maplocations, job_workflow_list,
// watching_bridge_status, dispatch_alerts, today_schedule) into one HTTP
// round trip. Added 2026-08-02 to reduce the "56+ API calls per Command
// Center load" known issue -- these 5 all fire together on initial page
// load (see public/index.html's big synchronous load*() call chain).
// Deliberately ADDITIVE: calls the exact same handler functions the
// standalone resource=maplocations / etc requests already use, via a
// fake res that captures what they would have sent instead of writing to
// the real response -- their internal logic is completely untouched.
async function handleCcBundle(req, res) {
  // Phase 2 (2026-08-04): grew the bundle from 5 to 7 Command Center
  // resources. Added leads and crew_schedule -- each is a track1 resource
  // whose Command Center load*() caller fired its own standalone request on
  // page load (loadLeadsLive, loadTechLocationsLive). Same additive rule as
  // Phase 1: call the exact same handler the standalone resource=leads / etc
  // request uses, via ccCaptureJson's fake res, so each handler's internal
  // logic is completely untouched. handleLeads takes (req, res) -- pass the
  // real req through, exactly like handleJobWorkflowList; handleCrewSchedule
  // takes (res) only.
  //
  // Deliberately NOT bundled -- watching_unscheduled + watching_margin_fade:
  // these were split into independent fetches on 2026-07-31 on purpose. The
  // whole point of the bundle is that ccBundleFetch('<key>') only resolves
  // once this single Promise.all resolves, i.e. after the SLOWEST member.
  // handleWatchingUnscheduled is a fast Jobber-via-Supabase read;
  // handleWatchingMarginFade cross-references QBO job costing (its own comment
  // records the 10-15s cold-start QuickBooks pagination that the 7/31 perf fix
  // was about). Folding both into this bundle would make the fast unscheduled
  // count (loadWatchingLive, loadJobsAttention) render behind the slow
  // margin-fade call again -- re-introducing the exact regression the 7/31
  // split fixed. They stay standalone by design. (See status doc.)
  //
  // Also NOT bundled: /api/jobs, /api/snapshot, /api/qbo and /api/clients are
  // separate endpoints, not track1 resources; quotes/visits carry per-caller
  // limit params. Those stay standalone too.
  const [mapR, wfR, watchR, dispatchR, todayR, leadsR, crewR] = await Promise.all([
    ccCaptureJson((r) => handleMapLocations(r)),
    ccCaptureJson((r) => handleJobWorkflowList(req, r)),
    ccCaptureJson((r) => handleWatchingBridgeStatus(r)),
    ccCaptureJson((r) => handleDispatchAlerts(r)),
    ccCaptureJson((r) => handleTodaySchedule(r)),
    ccCaptureJson((r) => handleLeads(req, r)),
    ccCaptureJson((r) => handleCrewSchedule(r)),
  ]);
  return res.status(200).json({
    ok: true,
    resource: 'cc_bundle',
    maplocations: mapR.body,
    job_workflow_list: wfR.body,
    watching_bridge_status: watchR.body,
    dispatch_alerts: dispatchR.body,
    today_schedule: todayR.body,
    leads: leadsR.body,
    crew_schedule: crewR.body,
  });
}

// ---- Command Center saved layouts (2026-08-16, Chris's layout-editor fix) ----
// Per-user custom Command Center layouts. Backed by
// sql/085_command_center_layouts.sql (NOT yet applied to production -- until it
// is, every call here 502s and the client falls back to localStorage, which is
// exactly where layouts lived before this change).
//
// Templates are NOT stored: they live in code as JS constants in
// public/index.html (CC_LAYOUT_TEMPLATES) and are read-only presets. Only a
// user's own customs are rows here, so a template can never be mutated or
// deleted through this endpoint.
const CC_LAYOUT_TABLE = 'command_center_layouts';
const CC_LAYOUT_SELECT = 'id,name,layout,is_active,created_at,updated_at';
// Today's Decisions can be moved and resized, but never removed from any
// layout. The client refuses to render a ✕ for it and re-injects it on load;
// this is the server half -- a crafted payload that dropped it is rejected
// outright rather than quietly persisted.
const CC_REQUIRED_WIDGET = 'cc-brief';

function ccLayoutValidationError(layout) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    return 'layout must be an object like { widgets: [{ id, x, y, w, h }] }.';
  }
  if (!Array.isArray(layout.widgets)) return 'layout.widgets must be an array.';
  for (const w of layout.widgets) {
    if (!w || typeof w !== 'object' || typeof w.id !== 'string' || !w.id) {
      return 'every entry in layout.widgets needs a string id.';
    }
    for (const k of ['x', 'y', 'w', 'h']) {
      if (w[k] !== undefined && !Number.isFinite(Number(w[k]))) return `layout.widgets[${w.id}].${k} must be a number.`;
    }
  }
  const decisions = layout.widgets.find((w) => w.id === CC_REQUIRED_WIDGET);
  if (!decisions || decisions.hidden === true) {
    return "Today's Decisions can be moved and resized, but it can't be removed from a Command Center layout.";
  }
  return null;
}

async function ccLayoutRows(userId, extra = '') {
  const r = await supabaseRequest(`${CC_LAYOUT_TABLE}?user_id=eq.${encodeURIComponent(userId)}&select=${CC_LAYOUT_SELECT}${extra}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
// One active layout per user. The table has a partial unique index as the
// backstop; this clears the old active row first so the index never trips on a
// normal save.
async function ccClearActive(userId, exceptId) {
  let path = `${CC_LAYOUT_TABLE}?user_id=eq.${encodeURIComponent(userId)}&is_active=is.true`;
  if (exceptId) path += `&id=neq.${encodeURIComponent(exceptId)}`;
  await supabaseRequest(path, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ is_active: false }) });
}

async function handleCcLayouts(req, res, gate) {
  const userId = gate && gate.user && gate.user.id;
  if (!userId) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  const body = req.body || {};

  try {
    if (req.method === 'GET') {
      const rows = await ccLayoutRows(userId, '&order=created_at.asc');
      return res.status(200).json({ ok: true, resource: 'cc_layouts', layouts: rows });
    }

    if (req.method === 'POST') {
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ ok: false, error: 'name is required.' });
      const invalid = ccLayoutValidationError(body.layout);
      if (invalid) return res.status(400).json({ ok: false, error: invalid });
      const makeActive = body.is_active !== false;
      if (makeActive) await ccClearActive(userId);
      const r = await supabaseRequest(CC_LAYOUT_TABLE, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ user_id: userId, name, layout: body.layout, is_active: makeActive }),
      });
      if (!r.ok) return res.status(502).json({ ok: false, error: `Failed to save layout: ${await r.text()}` });
      const saved = (await r.json())[0];
      return res.status(200).json({ ok: true, resource: 'cc_layouts', layout: saved });
    }

    if (req.method === 'PATCH') {
      const id = body.id || req.query.id;
      if (!id) return res.status(400).json({ ok: false, error: 'id is required.' });
      const patch = {};
      if (body.name !== undefined) {
        const name = String(body.name || '').trim();
        if (!name) return res.status(400).json({ ok: false, error: 'name cannot be empty.' });
        patch.name = name;
      }
      if (body.layout !== undefined) {
        const invalid = ccLayoutValidationError(body.layout);
        if (invalid) return res.status(400).json({ ok: false, error: invalid });
        patch.layout = body.layout;
      }
      if (body.is_active !== undefined) patch.is_active = !!body.is_active;
      if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'nothing to update.' });
      if (patch.is_active === true) await ccClearActive(userId, id);
      // user_id=eq.<caller> is what scopes this to the caller's own rows: this
      // handler talks to PostgREST with the service key, which bypasses RLS.
      const r = await supabaseRequest(
        `${CC_LAYOUT_TABLE}?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=${CC_LAYOUT_SELECT}`,
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) },
      );
      if (!r.ok) return res.status(502).json({ ok: false, error: `Failed to update layout: ${await r.text()}` });
      const rows = await r.json();
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Layout not found.' });
      return res.status(200).json({ ok: true, resource: 'cc_layouts', layout: rows[0] });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id || body.id;
      if (!id) return res.status(400).json({ ok: false, error: 'id is required.' });
      const r = await supabaseRequest(
        `${CC_LAYOUT_TABLE}?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=id`,
        { method: 'DELETE', headers: { Prefer: 'return=representation' } },
      );
      if (!r.ok) return res.status(502).json({ ok: false, error: `Failed to delete layout: ${await r.text()}` });
      const rows = await r.json();
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Layout not found.' });
      return res.status(200).json({ ok: true, resource: 'cc_layouts', id });
    }

    return res.status(405).json({ ok: false, error: 'GET, POST, PATCH or DELETE only' });
  } catch (e) {
    return res.status(502).json({ ok: false, error: `Command Center layouts unavailable: ${e.message}` });
  }
}

export default async function handler(req, res) {
  const resource = req.query.resource;
  await hlEnsureBody(req);

  // Item 3 (2026-08-01): global auth gate. Every track1 resource returns real
  // company data (financials, team, schedules, leads, subs, mail, ...), and
  // several read handlers (handleFiCash/handleFiLeaks/handleFiOverhead and the
  // other resource=* readers) previously ran with NO auth — anyone with the
  // URL could pull financials. Require a signed-in employee for every resource
  // except the check_new_leads cron path (authenticated by CRON_SECRET at the
  // middleware layer). The in-app SPA attaches the Supabase token to every
  // /api call via its global fetch shim, so this is transparent to signed-in
  // users. Belt-and-braces with the global /api middleware guard.
  let gate = null;
  if (resource === 'reina_lab_read' && req.method === 'GET') {
    // Self-authenticates with REINA_LAB_READ_TOKEN inside its handler.
  } else if (resource === 'workforce_sweep_gone') {
    // Cron-only; handleWorkforceSweepGone does its own timing-safe
    // CRON_SECRET check. requireApiAuth would also accept the cron secret,
    // but routing it here keeps the sweep's single source of truth in its
    // own handler.
  } else if (resource === 'workforce_auto_clockout' && req.method === 'POST') {
    // The browser-close beacon. navigator.sendBeacon CANNOT set an
    // Authorization header, so the Supabase token travels in the request body
    // and getRequestingProfile() reads it from there (it has a documented
    // fallback for exactly this caller). requireApiAuth only ever looks at the
    // header, so leaving this gate in place would 401 the beacon here even
    // after the middleware allowlist let it through -- precisely the
    // "silently re-block what the middleware just allowed" trap the comment
    // below warns about, and how this feature stayed broken for two weeks.
    //
    // NOT unauthenticated: handleWorkforceAutoClockout immediately calls
    // getRequestingProfile(), which verifies the presented token against
    // Supabase's own /auth/v1/user and 401s without a valid one. It can only
    // ever act on the session belonging to that token.
  } else if (MONITOR_AGENT_RESOURCES.includes(resource) && req.method === 'POST') {
    // The HiveLogic Monitor desktop agent. It authenticates with its OWN
    // hashed bearer token, not a Supabase session -- requireApiAuth only knows
    // how to verify a Supabase JWT, so it sends the agent token to
    // /auth/v1/user, gets a 403, and 401s the agent with "Not signed in".
    //
    // This is why monitoring was STILL dead after the edge guard was fixed
    // (#262, 2026-08-16). Opening the middleware was necessary and not
    // sufficient: the request got past the edge and was then refused HERE, by
    // the very "silently re-block what the middleware just allowed" trap the
    // comment below warns about -- the same trap that had already caught the
    // browser-close beacon a few hours earlier in this same block. Chris's
    // tray icon read "HiveLogic Monitor — Heartbeat error" the whole time, and
    // production showed a steady stream of 403s on /auth/v1/user roughly every
    // 30 seconds: the agent knocking, and being turned away.
    //
    // NOT unauthenticated. Each of these self-authenticates in its handler:
    // heartbeat, consent and screenshot_upload all call getRequestingAgent()
    // -> requireMonitorAgent(), which SHA-hashes the presented bearer and
    // requires a matching status='active' agent row; monitor_pair is the
    // enrollment exchange (no token exists yet, by definition) and is hardened
    // by a 15-minute 6-digit code, 5 wrong guesses per code, and 15 attempts
    // per IP per 10 minutes. POST-pinned, matching the middleware allowlist.
  } else if (resource !== 'check_new_leads') {
    // The Dev To-Do writer used to be exempted here and at the middleware.
    // That made it publicly overwriteable and let an out-of-date third-party
    // hourly task re-publish stale engineering status. It now uses the normal
    // user-or-CRON_SECRET gate like every other mutable Track 1 resource.
    gate = await requireApiAuth(req);
    if (!gate.ok) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  }

  // Role gate, phase 1 (2026-08-05): these five resources are the raw
  // financial reads (bank balance, AR/cash-leak radar, overhead, cash
  // forecast, job-costing margin fade) -- previously "signed in" was the
  // only bar, so any employee account (field crew, marketing, ...) could
  // read them directly by URL even though the nav already hides the
  // money/insights groups from those roles (index.html's
  // hlApplyRolePermissions ALLOWED_GROUPS, ~line 18491). This enforces that
  // SAME already-decided policy server-side instead of inventing a new one.
  // Skipped for the cron-secret path (gate.via === 'cron'): that's the
  // automated leaks/watching_margin_fade health-check caller added earlier,
  // not a person, and it's already narrowly allowlisted at the middleware
  // layer by resource. dailybrief is deliberately NOT in this list -- the
  // Command Center's Business Pulse tile is intentionally visible to every
  // role per that same ALLOWED_GROUPS table (nav-cc is in every role's
  // ALLOWED_STANDALONE), so gating it here would fight the app's own intent.
  // jobs_margin_list added 2026-08-15: same per-job margin data as
  // watching_margin_fade, just surfaced on the Jobs page's Margin list tab
  // instead of a Command Center watching card -- gated the same way so a PM
  // can't see it through this door instead (see the rule this whole array
  // enforces, above).
  const FINANCIAL_RESOURCES = ['cash', 'leaks', 'overhead', 'forecast', 'watching_margin_fade', 'jobs_margin_list'];
  // Stage 2 permission redesign: only owner and office_ar (accounts
  // receivable/accounting) see raw financial data now -- jomell + Chris's
  // rule was explicitly "Project manager - no financials tab" and this is
  // the one place that actually enforces it (Command Center's Pulse tiles
  // pull from these same resources, so hiding the nav tab alone wasn't
  // enough -- see the fail-open nav bug fixed in the same deploy).
  const FINANCIAL_ALLOWED_ROLES = ['owner', 'office_ar'];
  if (FINANCIAL_RESOURCES.includes(resource) && !(gate && gate.via === 'cron')) {
    const requester = await getRequestingProfile(req);
    const permissionRoles = requester ? await getDispatchPermissionRoles(requester) : [];
    const allowed = !!requester && (requester.role === 'admin' || requester.role === 'superadmin' || permissionRoles.some((r) => FINANCIAL_ALLOWED_ROLES.indexOf(r) !== -1));
    if (!allowed) return res.status(403).json({ ok: false, error: 'Your role does not have access to financial data. Ask an owner or office manager if you need this.' });
  }

  if (resource === 'cc_bundle') return handleCcBundle(req, res);
  if (resource === 'cc_layouts') return handleCcLayouts(req, res, gate);
  if (resource === 'materials_search') return handleMaterialsSearch(req, res);
  if (resource === 'materials_get') return handleMaterialsGet(req, res);
  if (resource === 'materials_adapters') return handleMaterialsAdapters(res);
  if (resource === 'materials_nickname_save') return handleMaterialsNicknameSave(req, res);
  if (resource === 'materials_cart_add') return handleMaterialsCartAdd(req, res);
  if (resource === 'materials_cart_get') return handleMaterialsCartGet(req, res);
  if (resource === 'materials_cart_remove') return handleMaterialsCartRemove(req, res);
  if (resource === 'materials_cart_attach') return handleMaterialsCartAttach(req, res);
  if (resource === 'reina_todo_get') return handleReinaTodoGet(req, res);
  if (resource === 'reina_todo_set') return handleReinaTodoSet(req, res);
  if (resource === 'app_status_findings') return handleAppStatusFindings(req, res);
  if (resource === 'app_status_update') return handleAppStatusUpdate(req, res);
  if (resource === 'app_status_create') return handleAppStatusCreate(req, res);
  if (resource === 'app_status_attachment_upload') return handleAppStatusAttachmentUpload(req, res);
  if (resource === 'team_todo_detections') {
    try { return await handleTeamTodoDetections(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'job_workflow_list') return handleJobWorkflowList(req, res);
  if (resource === 'job_workflow_set') return handleJobWorkflowSet(req, res);
  if (resource === 'job_readiness_set') return handleJobReadinessSet(req, res);
  if (resource === 'job_readiness_override') return handleJobReadinessOverride(req, res);
  if (resource === 'maplocations') return handleMapLocations(res);
  if (resource === 'cash') {
    try { return await handleFiCash(res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'leaks') {
    try { return await handleFiLeaks(res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'overhead') {
    try { return await handleFiOverhead(res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'forecast') {
    try { return await handleFiForecast(res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
if (resource === 'dailybrief') {
      try { return await handleFiDailyBrief(res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
  if (resource === 'team') {
    try { return await handleTeam(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
  if (resource === 'employee_roster') {
    try { return await handleEmployeeRoster(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
  if (resource === 'tech_live_status') {
    try { return await handleTechLiveStatus(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
  if (resource === 'subcontractors') {
    try { return await handleSubcontractors(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
  if (resource === 'my_role') {
    try { return await handleMyRole(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
  if (resource === 'manager_gh_updates') {
    try { return await handleManagerGhUpdates(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
  if (resource === 'manager_materials_pnl') {
    try { return await handleManagerMaterialsPnl(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
if (resource === 'hiveconnect_backfill') {
    try { return await handleHiveConnectBackfill(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
if (resource === 'mailconnect') {
    return handleMailConnect(req, res);
}
  if (resource === 'mailcallback') {
    try { return await handleMailCallback(req, res); } catch (e) { return res.status(500).send('Mail callback error: ' + e.message); }
}
  if (resource === 'mailstatus') {
    try { return await handleMailStatus(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
  if (resource === 'mail') {
    try { return await handleMail(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
  if (resource === 'workforce_set_status') {
    try { return await handleWorkforceSetStatus(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'workforce_team_status') {
    try { return await handleWorkforceTeamStatus(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'workforce_status') {
    try { return await handleWorkforceStatus(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
  if (resource === 'workforce_clock') {
    try { return await handleWorkforceClock(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
  if (resource === 'workforce_break') {
    try { return await handleWorkforceBreak(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'workforce_auto_clockout') {
    try { return await handleWorkforceAutoClockout(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'workforce_sweep_gone') {
    try { return await handleWorkforceSweepGone(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'workforce_settings') {
    try { return await handleWorkforceSettings(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'monitor_status') {
    try { return await handleMonitorStatus(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'monitor_pairing_code') {
    try { return await handleMonitorPairingCode(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'monitor_pair') {
    try { return await handleMonitorPair(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'monitor_heartbeat') {
    try { return await handleMonitorHeartbeat(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'monitor_consent') {
    try { return await handleMonitorConsent(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'monitor_screenshot_upload') {
    try { return await handleMonitorScreenshotUpload(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'monitor_review') {
    try { return await handleMonitorReview(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'monitor_app_rules') {
    try { return await handleMonitorAppRules(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'monitor_app_usage') {
    try { return await handleMonitorAppUsage(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'monitor_settings') {
    try { return await handleMonitorSettings(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'monitor_user_toggle') {
    try { return await handleMonitorUserToggle(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'monitor_my_status') {
    try { return await handleMonitorMyStatus(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'monitor_prune') {
    try { return await handleMonitorPrune(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'dispatch_settings') {
    try { return await handleDispatchSettings(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'workforce_summary') {
    try { return await handleWorkforceSummary(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
  if (resource === 'workforce_team') {
    try { return await handleWorkforceTeam(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
  if (resource === 'workforce_week_summary') {
    try { return await handleWorkforceWeekSummary(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
}
  if (resource === 'production_tracker') {
    try { return await handleProductionTracker(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'inventory_items') {
    try { return await handleInventoryItems(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'inventory_stock') {
    try { return await handleInventoryStock(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'inventory_adjust') {
    try { return await handleInventoryAdjust(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'inventory_adjustments') {
    try { return await handleInventoryAdjustments(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'inventory_purchase_orders') {
    try { return await handleInventoryPurchaseOrders(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'watching_bridge_status') {
    try { return await handleWatchingBridgeStatus(res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'watching_unscheduled') {
    try { return await handleWatchingUnscheduled(res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'watching_margin_fade') {
    try { return await handleWatchingMarginFade(res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'jobs_margin_list') {
    try { return await handleJobsMarginList(res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'today_schedule') {
    try { return await handleTodaySchedule(res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'dispatch_alerts') {
    try { return await handleDispatchAlerts(res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'tm_overview') {
    try { return await handleTmOverview(res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'tm_live') {
    try { return await handleTmLive(res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'materials_overview') {
    try { return await handleMaterialsOverview(res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'crew_schedule') {
    try { return await handleCrewSchedule(res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'capacity_crew_hours') {
    try { return await handleCapacityCrewHours(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'capacity_backlog_by_month') {
    try { return await handleCapacityBacklogByMonth(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'pto_requests') {
    try { return await handlePtoRequests(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'pto_decide') {
    try { return await handlePtoDecide(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'pto_balances') {
    try { return await handlePtoBalances(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'pto_allowance_set') {
    try { return await handlePtoAllowanceSet(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'pto_coverage') {
    try { return await handlePtoCoverage(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'reina_lab_read') {
    try { return await handleReinaLabRead(req, res); } catch (e) { return res.status(500).json({ ok: false, error: 'Read bridge unavailable.' }); }
  }
  if (resource === 'weather') {
    try { return await handleWeather(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'watching_all') {
    try { return await handleWatchingAll(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'notifications') {
    try { return await handleNotifications(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'check_new_leads' && req.method === 'GET') {
    try { return await handleCheckNewLeadsGet(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'create_client') {
    try { return await handleCreateClient(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'update_client_contact') {
    try { return await handleUpdateClientContact(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'set_job_closed') {
    try { return await handleSetJobClosed(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'client_location') {
    try { return await handleClientLocation(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'schedule_unscheduled' && req.method === 'GET') {
    try { return await handleScheduleUnscheduled(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'address_suggest' && req.method === 'GET') {
    try { return await handleAddressSuggest(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'create_job') {
    try { return await handleCreateJob(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'tm_rate_types_list') {
    try { return await handleTmRateTypesList(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'create_invoice') {
    try { return await handleCreateInvoice(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'job_line_items') {
    try { return await handleJobLineItems(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'create_invoice_from_job') {
    try { return await handleCreateInvoiceFromJob(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'send_invoice_email') {
    try { return await handleSendInvoiceEmail(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'mark_invoice_paid') {
    try { return await handleMarkInvoicePaid(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'update_invoice') {
    try { return await handleUpdateInvoice(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'timesheet_week') {
    try { return await handleTimesheetWeek(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'create_timesheet_entry') {
    try { return await handleCreateTimesheetEntry(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'update_timesheet_entry') {
    try { return await handleUpdateTimesheetEntry(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'delete_timesheet_entry') {
    try { return await handleDeleteTimesheetEntry(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'my_jobs_today') {
    try { return await handleMyJobsToday(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'schedule_range') {
    try { return await handleScheduleRange(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (resource === 'leads') {
    try { return await handleLeads(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  // lead_drafts kept as an alias: a page cached in someone's browser from
  // before the rename would otherwise start 400ing on a form they had open.
  if (resource === 'form_drafts' || resource === 'lead_drafts') {
    try { return await handleFormDrafts(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
const cfg = RESOURCE_CONFIG[resource];
  if (!cfg) {
    return res.status(400).json({ ok: false, error: `resource must be one of: ${Object.keys(RESOURCE_CONFIG).join(', ')}, maplocations, cash, leaks, overhead, forecast` });
  }
  try {
    const limit = Math.min(Number(req.query.limit) || cfg.defaultLimit, 10000);
    const r = await supabaseRequest(`${cfg.table}?select=*&order=${cfg.order}&limit=${limit}`, {
      headers: { Prefer: 'count=exact' }
    });
    if (!r.ok) {
      const text = await r.text();
      const notSynced = /relation .* does not exist/i.test(text);
      return res.status(notSynced ? 200 : 500).json({
        ok: false,
        error: notSynced ? cfg.notSyncedMsg : text
      });
    }
    const rows = await r.json();
    const range = r.headers.get('content-range');
    const totalCount = range && range.includes('/') && range.split('/')[1] !== '*'
      ? Number(range.split('/')[1]) : rows.length;

    const shaped = rows.map(cfg.shape);
    const extra = cfg.extra ? cfg.extra(rows) : {};

    res.status(200).json({ ok: true, source: 'Jobber via Supabase', resource, totalCount, returned: shaped.length, [resource]: shaped, ...extra });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
