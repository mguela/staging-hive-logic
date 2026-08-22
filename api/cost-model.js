// api/cost-model.js — Vercel serverless function (Company Setup + Cost Model V1).
//
// The ledger behind the cost model: loaded labor, overhead recovery, break-even.
// Follows the existing api/ pattern — one route, dispatched on ?resource=,
// service-role Supabase access via _lib/jobber.js, self-gated with the shared
// auth guard (_lib/guard.js) on top of the edge middleware.
//
// SINGLE SOURCE OF TRUTH: the SQL view public.company_rates (sql/071). This
// file's computeRates() is a byte-for-byte mirror of those formulas, used (a)
// as the tested reference and (b) as a fallback so the endpoint works before
// Chris applies the migration. Once the view exists, getRates() reads it and
// the JS mirror only serves the pre-migration window. The BROWSER never
// computes anything — it reads rates from here.
//
// Resources:
//   assumptions        GET  -> current company's row (created from defaults if absent)
//                      PUT  -> update, returns recomputed rates
//   lines              GET  -> non-archived lines grouped by section, w/ annualized value
//                      POST -> add a line (source='manual'), returns rates
//                      PATCH-> update one line (benchmark->confirmed on human edit), returns rates
//                      DELETE-> soft delete (archived=true), returns rates
//   rates              GET  -> read company_rates
//   seed_from_benchmark POST-> copy benchmark rows into cost_lines (idempotent unless force)
//   import_qbo         POST -> QuickBooks chart-of-accounts import (Slice 3; dry-run capable)

import { supabaseRequest } from './_lib/jobber.js';
import { requireApiAuth } from './_lib/guard.js';
import { resolveCompany } from './_lib/tenant.js';
import { runQboImport } from './_lib/qbo-cost-import.js';

// ---------------------------------------------------------------------------
// Pure cost math — exported for unit tests. Mirrors sql/071 company_rates.
// ---------------------------------------------------------------------------

// Numbers only; treat null/undefined/NaN as 0 so a half-filled ledger still
// produces a coherent (if partial) figure instead of NaN spilling everywhere.
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Assumption-derived scalars needed to annualize the rate-based frequencies.
// field_wages is passed in separately because it must be summed BEFORE any
// pct_field_wages line can resolve (the ordering dependency the tests pin).
export function deriveContext(assumptions = {}) {
  const paid_hours_per_year = assumptions.paid_hours_per_year == null ? 2080 : num(assumptions.paid_hours_per_year);
  const pto_days = assumptions.pto_days == null ? 15 : num(assumptions.pto_days);
  const nonbillable_pct = assumptions.nonbillable_pct == null ? 18 : num(assumptions.nonbillable_pct);
  const workdays_per_year = assumptions.workdays_per_year == null ? 250 : num(assumptions.workdays_per_year);
  const target_net_pct = assumptions.target_net_pct == null ? 10 : num(assumptions.target_net_pct);

  const field_headcount = num(assumptions.field_headcount);
  const office_headcount = num(assumptions.office_headcount);
  const owner_headcount = num(assumptions.owner_headcount);

  const base_hours = paid_hours_per_year - pto_days * 8;
  const field_paid_hours = field_headcount * base_hours;
  const billable_hours = field_paid_hours * (1 - nonbillable_pct / 100);

  return {
    revenue: num(assumptions.annual_revenue),
    field_headcount, office_headcount, owner_headcount,
    total_headcount: field_headcount + office_headcount + owner_headcount,
    vehicle_count: num(assumptions.vehicle_count),
    fleet_miles: num(assumptions.fleet_miles_per_year),
    workdays_per_year,
    target_net_pct,
    base_hours,
    field_paid_hours,
    billable_hours,
  };
}

// Annualize ONE line. ctx must carry field_wages for pct_field_wages to
// resolve — callers compute field_wages first. Exhaustive over all 11
// frequency codes; an unknown code annualizes to 0 (never NaN).
export function annualizeLine(line, ctx) {
  const amount = num(line && line.amount);
  const c = ctx || {};
  switch (line && line.frequency) {
    case 'mo':                return amount * 12;
    case 'yr':                return amount;
    case 'wk':                return amount * 52;
    case 'per_employee_mo':   return amount * num(c.total_headcount) * 12;
    case 'per_vehicle_mo':    return amount * num(c.vehicle_count) * 12;
    case 'pct_revenue':       return (amount / 100) * num(c.revenue);
    case 'per_mile':          return amount * num(c.fleet_miles);
    case 'per_billable_hour': return amount * num(c.billable_hours);
    case 'per_field_hour':    return amount * num(c.field_paid_hours);
    case 'pct_field_wages':   return (amount / 100) * num(c.field_wages);
    case 'target_net':        return (num(c.target_net_pct) / 100) * num(c.revenue);
    default:                  return 0;
  }
}

// Divide guarding against 0/negative denominators -> null (mirrors the view's
// CASE WHEN ... guards, which yield SQL NULL).
function safeDiv(n, d) {
  return d > 0 ? n / d : null;
}

// Full rate roll-up. Returns exactly the columns public.company_rates exposes.
export function computeRates(assumptions, lines) {
  const ctx = deriveContext(assumptions || {});
  const active = (Array.isArray(lines) ? lines : []).filter((l) => l && !l.archived);

  // 1) field_wages first (per_field_hour), so pct_field_wages can resolve.
  let field_wages = 0;
  for (const l of active) {
    if (l.frequency === 'per_field_hour') field_wages += num(l.amount) * ctx.field_paid_hours;
  }
  const ctx2 = { ...ctx, field_wages };

  // 2) field_burden (pct_field_wages) + section/type roll-ups.
  let field_burden = 0;
  let profit_target = 0;
  let direct_total = 0;
  let reserve_total = 0;
  let overhead_total = 0;
  let fleet_cost_total = 0;

  for (const l of active) {
    const ann = annualizeLine(l, ctx2);
    if (l.frequency === 'pct_field_wages') field_burden += (num(l.amount) / 100) * field_wages;
    if (l.frequency === 'target_net') { profit_target += ann; continue; } // excluded from direct/reserve
    if (l.cost_type === 'direct') direct_total += ann;
    else if (l.cost_type === 'reserve') reserve_total += ann;
    else if (l.cost_type === 'fixed' || l.cost_type === 'variable') overhead_total += ann;
    // Fleet cost = ALL annualized cost in a fleet/vehicle section (not just the
    // two per_mile/per_vehicle_mo frequencies) — mirrors the corrected sql/071
    // company_rates view. target_net lines already `continue` above.
    if (l.section && /fleet|vehicle/i.test(l.section)) fleet_cost_total += ann;
  }

  const revenue = ctx.revenue;
  const billable_hours = ctx.billable_hours;
  const gross_margin_pct = revenue > 0 ? (revenue - direct_total) / revenue : null;
  const loaded_labor_rate = safeDiv(field_wages + field_burden, billable_hours);
  const overhead_per_billable_hour = safeDiv(overhead_total, billable_hours);

  return {
    billable_hours,
    field_wages,
    field_burden,
    loaded_labor_rate,
    direct_total,
    overhead_total,
    reserve_total,
    profit_target,
    gross_margin_pct,
    net_pct: revenue > 0 ? (revenue - direct_total - overhead_total) / revenue : null,
    breakeven_revenue: gross_margin_pct && gross_margin_pct > 0 ? overhead_total / gross_margin_pct : null,
    overhead_per_billable_hour,
    breakeven_hourly_rate:
      loaded_labor_rate != null && overhead_per_billable_hour != null
        ? loaded_labor_rate + overhead_per_billable_hour
        : null,
    min_markup_pct: direct_total > 0 ? (overhead_total / direct_total) * 100 : null,
    overhead_per_workday: safeDiv(overhead_total, ctx.workdays_per_year),
    fleet_cost_per_mile: safeDiv(fleet_cost_total, ctx.fleet_miles),
  };
}

// ---------------------------------------------------------------------------
// Supabase helpers (service-role via _lib/jobber.js supabaseRequest)
// ---------------------------------------------------------------------------

const ASSUMPTION_DEFAULTS = {
  paid_hours_per_year: 2080,
  pto_days: 15,
  nonbillable_pct: 18,
  workdays_per_year: 250,
  target_net_pct: 10,
};

// Editable assumption columns (whitelist — never trust arbitrary keys).
const ASSUMPTION_FIELDS = [
  'annual_revenue', 'field_headcount', 'office_headcount', 'owner_headcount',
  'paid_hours_per_year', 'pto_days', 'nonbillable_pct', 'vehicle_count',
  'fleet_miles_per_year', 'workdays_per_year', 'target_net_pct',
];

const LINE_FIELDS = ['section', 'name', 'note', 'amount', 'frequency', 'cost_type', 'source', 'confidence', 'sort_order'];

// Resolve the tenant from the signed-in user (was a hardcoded slug + a
// module-global cache — the cache is gone because a warm serverless instance
// would otherwise serve one company's id to the next company's request).
async function getCompanyId(user, deps = {}) {
  const t = await resolveCompany(user, deps);
  if (!t) throw new Error('No company for this account.');
  return t.company_id;
}

async function getAssumptions(companyId, deps = {}) {
  const request = deps.supabaseRequest || supabaseRequest;
  const r = await request(`cost_assumptions?company_id=eq.${companyId}&limit=1`);
  if (!r.ok) throw new Error('assumptions read failed: ' + (await r.text()));
  const rows = await r.json();
  if (rows && rows[0]) return rows[0];
  // create-from-defaults
  const ins = await request('cost_assumptions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{ company_id: companyId, ...ASSUMPTION_DEFAULTS }]),
  });
  if (!ins.ok) throw new Error('assumptions create failed: ' + (await ins.text()));
  const created = await ins.json();
  return created[0];
}

async function getLines(companyId, deps = {}, { includeArchived = false } = {}) {
  const request = deps.supabaseRequest || supabaseRequest;
  const filter = includeArchived ? '' : '&archived=eq.false';
  const r = await request(`cost_lines?company_id=eq.${companyId}${filter}&order=section.asc,sort_order.asc`);
  if (!r.ok) throw new Error('lines read failed: ' + (await r.text()));
  return r.json();
}

// Rates: prefer the SQL view (source of truth). If it's not there yet
// (pre-migration) or returns nothing, fall back to the tested JS mirror.
async function getRates(companyId, deps = {}) {
  const request = deps.supabaseRequest || supabaseRequest;
  try {
    const r = await request(`company_rates?company_id=eq.${companyId}&limit=1`);
    if (r.ok) {
      const rows = await r.json();
      if (rows && rows[0]) return { ...rows[0], _source: 'view' };
    }
  } catch {
    /* view not present yet — fall through to JS mirror */
  }
  const [assumptions, lines] = await Promise.all([
    getAssumptions(companyId, deps),
    getLines(companyId, deps),
  ]);
  return { company_id: companyId, ...computeRates(assumptions, lines), _source: 'computed' };
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj && obj[f] !== undefined) out[f] = obj[f];
  return out;
}

function groupBySection(lines, ctx) {
  const sections = {};
  for (const l of lines) {
    const withAnn = { ...l, annualized: annualizeLine(l, ctx) };
    (sections[l.section] = sections[l.section] || []).push(withAnn);
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  // Self-gate (defense in depth on top of the edge middleware).
  const auth = await requireApiAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Not signed in.' });

  const resource = (req.query && req.query.resource) || '';
  const method = (req.method || 'GET').toUpperCase();

  try {
    const companyId = await getCompanyId(auth.user);

    // ---- assumptions -----------------------------------------------------
    if (resource === 'assumptions') {
      if (method === 'GET') {
        const assumptions = await getAssumptions(companyId);
        const rates = await getRates(companyId);
        return res.status(200).json({ ok: true, assumptions, rates });
      }
      if (method === 'PUT') {
        const patch = pick(req.body || {}, ASSUMPTION_FIELDS);
        await getAssumptions(companyId); // ensure row exists
        const upd = await supabaseRequest(
          `cost_assumptions?company_id=eq.${companyId}`,
          { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) },
        );
        if (!upd.ok) throw new Error('assumptions update failed: ' + (await upd.text()));
        const assumptions = (await upd.json())[0];
        const rates = await getRates(companyId);
        return res.status(200).json({ ok: true, assumptions, rates });
      }
      return res.status(405).json({ ok: false, error: 'Method not allowed.' });
    }

    // ---- lines -----------------------------------------------------------
    if (resource === 'lines') {
      if (method === 'GET') {
        const [assumptions, lines] = await Promise.all([getAssumptions(companyId), getLines(companyId)]);
        const ctx = deriveContext(assumptions);
        // field_wages needed for pct_field_wages annualization display
        let field_wages = 0;
        for (const l of lines) if (l.frequency === 'per_field_hour') field_wages += num(l.amount) * ctx.field_paid_hours;
        const sections = groupBySection(lines, { ...ctx, field_wages });
        const rates = await getRates(companyId);
        return res.status(200).json({ ok: true, sections, count: lines.length, rates });
      }
      if (method === 'POST') {
        const body = req.body || {};
        if (!body.section || !body.name || !body.frequency || !body.cost_type) {
          return res.status(400).json({ ok: false, error: 'section, name, frequency, cost_type are required.' });
        }
        const row = { ...pick(body, LINE_FIELDS), company_id: companyId, source: 'manual' };
        if (row.amount == null) row.amount = 0;
        const ins = await supabaseRequest('cost_lines', {
          method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([row]),
        });
        if (!ins.ok) throw new Error('line insert failed: ' + (await ins.text()));
        const line = (await ins.json())[0];
        const rates = await getRates(companyId);
        return res.status(200).json({ ok: true, line, rates });
      }
      if (method === 'PATCH') {
        const body = req.body || {};
        const id = body.id || (req.query && req.query.id);
        if (!id) return res.status(400).json({ ok: false, error: 'id is required.' });
        // Read current row to decide the benchmark->confirmed flip and to scope
        // the update to THIS company (never cross-tenant).
        const cur = await supabaseRequest(`cost_lines?id=eq.${id}&company_id=eq.${companyId}&limit=1`);
        if (!cur.ok) throw new Error('line read failed: ' + (await cur.text()));
        const existing = (await cur.json())[0];
        if (!existing) return res.status(404).json({ ok: false, error: 'Line not found.' });
        const patch = pick(body, LINE_FIELDS);
        // A human editing a benchmark line confirms it.
        if (existing.source === 'benchmark' && !body.source) patch.source = 'confirmed';
        const upd = await supabaseRequest(
          `cost_lines?id=eq.${id}&company_id=eq.${companyId}`,
          { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) },
        );
        if (!upd.ok) throw new Error('line update failed: ' + (await upd.text()));
        const line = (await upd.json())[0];
        const rates = await getRates(companyId);
        return res.status(200).json({ ok: true, line, rates });
      }
      if (method === 'DELETE') {
        const id = (req.body && req.body.id) || (req.query && req.query.id);
        if (!id) return res.status(400).json({ ok: false, error: 'id is required.' });
        const upd = await supabaseRequest(
          `cost_lines?id=eq.${id}&company_id=eq.${companyId}`,
          { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ archived: true }) },
        );
        if (!upd.ok) throw new Error('line soft-delete failed: ' + (await upd.text()));
        const line = (await upd.json())[0] || null;
        const rates = await getRates(companyId);
        return res.status(200).json({ ok: true, archived: true, line, rates });
      }
      return res.status(405).json({ ok: false, error: 'Method not allowed.' });
    }

    // ---- rates -----------------------------------------------------------
    if (resource === 'rates') {
      if (method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
      const rates = await getRates(companyId);
      return res.status(200).json({ ok: true, rates });
    }

    // ---- seed_from_benchmark --------------------------------------------
    if (resource === 'seed_from_benchmark') {
      if (method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
      const body = req.body || {};
      const trade = body.trade || 'design_build';
      const size_band = body.size_band || '2m_5m';
      const region = body.region || 'northeast';
      const force = body.force === true;

      const existing = await getLines(companyId, {}, { includeArchived: true });
      if (existing.length > 0 && !force) {
        return res.status(409).json({
          ok: false, error: 'Company already has cost lines. Pass force=true to re-seed.', existing: existing.length,
        });
      }
      const bench = await supabaseRequest(
        `cost_benchmarks?trade=eq.${trade}&size_band=eq.${size_band}&region=eq.${region}&order=sort_order.asc`,
      );
      if (!bench.ok) throw new Error('benchmark read failed: ' + (await bench.text()));
      const rows = (await bench.json()).map((b) => ({
        company_id: companyId,
        section: b.section, name: b.name, note: b.note, amount: b.amount,
        frequency: b.frequency, cost_type: b.cost_type,
        source: 'benchmark', confidence: 30, sort_order: b.sort_order,
      }));
      if (rows.length === 0) {
        return res.status(200).json({ ok: true, seeded: 0, note: 'No benchmarks matched.', rates: await getRates(companyId) });
      }
      const ins = await supabaseRequest('cost_lines', {
        method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(rows),
      });
      if (!ins.ok) throw new Error('seed insert failed: ' + (await ins.text()));
      const inserted = await ins.json();
      const rates = await getRates(companyId);
      return res.status(200).json({ ok: true, seeded: inserted.length, rates });
    }

    // ---- import_qbo (Slice 3) -------------------------------------------
    if (resource === 'import_qbo') {
      if (method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
      const dryRun = !(req.body && req.body.commit === true); // default DRY-RUN
      const result = await runQboImport({ companyId, dryRun, supabaseRequest });
      return res.status(result.ok ? 200 : 502).json(result);
    }

    return res.status(404).json({ ok: false, error: `Unknown resource: ${resource || '(none)'}` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
