// api/bookkeeping/vendors.js — Vercel serverless function.
// Intended to read the existing live QBO vendor/subcontractor directory
// (read-only) so the expense-entry vendor field autocompletes against real
// vendors. NOT wired to a live QBO connection yet in this preview — returns
// an honest empty list rather than fabricated vendor names.

import { guardBookkeepingRequest } from './_security.js';

export default async function handler(_req, res) {
  if (!guardBookkeepingRequest(_req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false, vendors: [] }); return; }
  res.status(200).json({
    ok: true,
    enabled: true,
    vendors: [],
    note: 'QBO vendor read connection is not wired in this preview. The vendor field falls back to free text until that connection is authorized.'
  });
}
