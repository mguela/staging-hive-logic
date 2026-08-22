// api/snapshot.js - Vercel serverless function
// Aggregate counts + AR outstanding across ALL synced Jobber records.
//
// 2026-07-30 root-cause rework (Gate 1, same series as api/jobs.js): the
// aggregates are now computed IN THE DATABASE by public.snapshot_aggregates()
// (sql/040_snapshot_aggregates_fn.sql, applied live). The old code downloaded
// every row of clients (~8.7k), jobs (~2.7k) and invoices (~2.8k) — ~15
// paginated PostgREST requests per call — just to count and sum them in Node.
// Now: one RPC round-trip. The function is a 1:1 transcription of the old
// reductions (verified against independent SQL cross-checks: openInvoices 43,
// outstanding 323244.12, activeClients 8633 on 2026-07-30 data) and includes
// the same AR policy: only awaiting_payment/past_due count as collectable
// (Chris's 2026-07-29 call), with the same transparent `excluded` breakdown.
// Read-only; response shape unchanged.
import { supabaseRequest } from './_lib/jobber.js';
import { requireUser } from './_lib/auth.js';
import { checkCronSecret } from './_lib/guard.js';

// Extracted so api/chat.js can call this directly in-process instead of making
// an HTTP round-trip to this file's own /api/snapshot route -- that used to mean
// one serverless function cold-starting another one on every "snapshot" tool
// call, even though it's the exact same deployment. The HTTP route below is
// byte-for-byte unchanged for every other caller (frontend, curl, etc).
export async function getSnapshotData() {
  const r = await supabaseRequest('rpc/snapshot_aggregates', {
    method: 'POST',
    body: '{}',
  });
  if (!r.ok) throw new Error(`snapshot_aggregates RPC failed: ${await r.text()}`);
  return await r.json();
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
    const snapshot = await getSnapshotData();
    res.status(200).json({ ok: true, source: 'Jobber via Supabase', snapshot });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
