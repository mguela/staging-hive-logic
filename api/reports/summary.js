// api/reports/summary.js — Vercel serverless function.
//
// Computes Revenue MTD from real, synced Jobber invoices (the same
// `invoices` table api/invoices.js reads, populated by the existing
// api/jobber/sync.js?resource=invoices cron). Revenue MTD = sum of
// invoice totals with issued_date in the current calendar month
// (an "invoiced this month" reading — matches how Jobber itself defines
// the figure, and needs no new data pipeline).
//
// This is the ONLY metric on the Reports page backed by real data today.
// Gross Margin needs job labor cost (Time & Timesheets has no live data
// yet), Utilization needs crew scheduling data, Lead Conversion depends on
// whether the team is actively entering rows into lead_pipeline (sql/013),
// and Callback Rate / Review Score have no data source anywhere in this
// app yet. Rather than invent numbers for those, this endpoint reports
// only what it can actually compute (Law 1) — the Reports page marks the
// rest as sample data until each has a real source.
import { supabaseRequest } from '../_lib/jobber.js';

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

import { requireUser } from '../_lib/auth.js';

// Exported alongside the HTTP handler (same pattern as api/chat.js's
// get_business_data tool reusing api/jobs.js etc. in-process) so other real
// features -- e.g. api/reports/anomalies.js's revenue-swing check -- can
// reuse this exact computation instead of re-querying invoices themselves.
export async function computeRevenueMTD() {
  const now = new Date();
  const curMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // Same day-of-month cutoff one month back, so "prior period" is a fair
  // MTD-vs-MTD comparison rather than a full-month-vs-partial-month one.
  const priorPeriodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, now.getUTCDate()));
  const priorMonthStart = new Date(Date.UTC(priorPeriodEnd.getUTCFullYear(), priorPeriodEnd.getUTCMonth(), 1));

  const rangeStart = toISODate(priorMonthStart);
  const rangeEnd = toISODate(now);

  const r = await supabaseRequest(
    `invoices?select=total,issued_date&issued_date=gte.${rangeStart}&issued_date=lte.${rangeEnd}&limit=10000`
  );
  if (!r.ok) throw new Error(await r.text());
  const rows = await r.json();

  const sumBetween = (startISO, endISO) => rows
    .filter(row => row.issued_date && row.issued_date >= startISO && row.issued_date <= endISO)
    .reduce((sum, row) => sum + (Number(row.total) || 0), 0);

  const currentValue = Math.round(sumBetween(toISODate(curMonthStart), toISODate(now)) * 100) / 100;
  const priorValue = Math.round(sumBetween(toISODate(priorMonthStart), toISODate(priorPeriodEnd)) * 100) / 100;
  const trendPct = priorValue > 0
    ? Math.round(((currentValue - priorValue) / priorValue) * 1000) / 10
    : null;

  return {
    value: currentValue,
    asOfDate: toISODate(now),
    priorPeriodValue: priorValue,
    priorPeriodLabel: 'same days, prior month',
    trendPct
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Only GET is supported.' });
    return;
  }
  const _authedUser = await requireUser(req);
  if (!_authedUser) return res.status(401).json({ ok: false, error: 'Not signed in.' });

  try {
    const revenueMTD = await computeRevenueMTD();
    res.status(200).json({
      ok: true,
      revenueMTD,
      source: 'Jobber invoices via Supabase (issued_date)',
      note: 'Only Revenue MTD is computed from real data today. Gross Margin, Utilization, Lead Conversion, Callback Rate, and Review Score have no live data source yet and remain sample figures on the Reports page.'
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Could not compute Revenue MTD.' });
  }
}
