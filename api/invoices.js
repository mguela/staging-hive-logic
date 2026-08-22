// api/invoices.js - Vercel serverless function
// Read-only pull of synced Jobber invoices from Supabase, reshaped for the frontend.
// balance is computed as total - payments - deposit - discount (Law 1: computed,
// not invented). Found during the 8/17 Dev To-Do triage: this used to be just
// total - payments, which overstated the balance on any invoice with a deposit
// applied -- the same "deposit-aware money-math" fix track1.js's Financial
// Intelligence past-due aggregation already got on 7/31 (see fiNum(r.total) -
// fiNum(r.payments) - fiNum(r.deposit) - fiNum(r.discount) there), but that
// fix never made it to this endpoint or its client-portal sibling
// (api/clientportal.js's mapInvoice, fixed alongside this one).
import { supabaseRequest } from './_lib/jobber.js';
import { requireUser } from './_lib/auth.js';
import { checkCronSecret } from './_lib/guard.js';
import { deriveInvoiceBalance } from './_lib/invoice-balance.js';

const PAGE_SIZE = 50;

// Extracted so api/chat.js can call this directly in-process instead of
// self-fetching this file's own /api/invoices route over HTTP.
//
// Paginated in chunks of 1000 (2026-08-06 fix): PostgREST's own default row
// cap silently truncates a single request there regardless of a higher
// ?limit=, same issue already documented/fixed in track1.js's
// fiFetchAllRows for this same table (~2,700+ rows). Before this fix,
// callers asking for more than 1000 (including api/chat.js and any
// ?limit=10000 caller) silently got only the most recent 1000 back with no
// indication -- totalCount (from content-range) still reported the true
// count, so the mismatch was invisible unless someone compared the two.
export async function getInvoicesData({ limit } = {}) {
  const cappedLimit = Math.min(Number(limit) || PAGE_SIZE, 10000);
  const CHUNK = 1000;
  let rows = [];
  let totalCount = 0;
  for (let offset = 0; offset < cappedLimit; offset += CHUNK) {
    const pageLimit = Math.min(CHUNK, cappedLimit - offset);
    const r = await supabaseRequest(`invoices?select=*&order=issued_date.desc&limit=${pageLimit}&offset=${offset}`, {
      headers: { Prefer: 'count=exact' }
    });
    if (!r.ok) throw new Error(await r.text());
    const page = await r.json();
    const range = r.headers.get('content-range');
    if (range && range.includes('/') && range.split('/')[1] !== '*') totalCount = Number(range.split('/')[1]);
    rows = rows.concat(page);
    if (page.length < pageLimit) break; // short page -- no more rows to fetch
  }
  if (!totalCount) totalCount = rows.length;

  const invoices = rows.map(i => {
    const total = Number(i.total) || 0;
    const payments = Number(i.payments) || 0;
    const deposit = Number(i.deposit) || 0;
    const discount = Number(i.discount) || 0;
    // Derived here on purpose, not read from invoices.balance: this is what a
    // person and a client are shown, and it must keep matching the figures
    // beside it on the same screen. api/_lib/invoice-balance.js owns the sum
    // so the four copies of it cannot drift apart again.
    const balance = deriveInvoiceBalance({ total, payments, deposit, discount });
    return {
      id: i.jobber_id,
      clientId: i.client_id,
      invoiceNumber: i.invoice_number,
      status: i.invoice_status,
      subject: i.subject,
      total,
      payments,
      deposit,
      discount,
      balance,
      dueDate: i.due_date,
      issuedDate: i.issued_date,
      jobberUrl: i.jobber_web_uri
    };
  });

  return { totalCount, returned: invoices.length, invoices };
}

export default async function handler(req, res) {
  // Service reads (e.g. the daily AR/job-costing/pricing-hygiene checks) carry
  // no Supabase user session -- accept the same CRON_SECRET bearer already
  // used by the Jobber sync crons and track1.js's requireApiAuth, so those
  // read-only checks stop 401ing without reopening this to the public.
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!checkCronSecret(authHeader)) {
    const _authedUser = await requireUser(req);
    if (!_authedUser) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  }
  try {
    const data = await getInvoicesData({ limit: req.query.limit });
    res.status(200).json({ ok: true, source: 'Jobber via Supabase', ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}