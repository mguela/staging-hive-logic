// api/registries.js — Vercel serverless function.
// Overhead Registries + Payroll Integration — Slice 1.
//
// One resource per registry (list / create / update / archive) plus two
// read-only rollups (overhead, calendar). Same shape as api/cost-model.js:
// service-role Supabase via _lib/jobber.js, self-gated with the shared auth
// guard, and every MUTATION returns the recalculated company_rates row so the
// UI never computes anything itself.
//
// Registries -> tables:
//   insurance     insurance_policies
//   licenses      licenses_credentials
//   loans         loans_obligations
//   leases        leases
//   vehicles      vehicle_costs
//   subscriptions subscriptions          (NOT company-scoped — no company_id col)
//
// Reads: overhead -> registry_overhead (grouped by section, annual total)
//        calendar -> compliance_calendar (soonest first, optional within_days)
//
// "Archive" is a soft delete: status is set to the table's terminal value; the
// list hides archived rows (and the registry_overhead / compliance_calendar
// views already ignore anything not 'active').

import { supabaseRequest } from './_lib/jobber.js';
import { requireApiAuth } from './_lib/guard.js';
import { resolveCompany } from './_lib/tenant.js';
import { proposalTargetPatch } from './_lib/reina-proposals.js';

// Per-registry config: table, company-scoped?, terminal "archived" status, and
// the whitelist of writable columns (never trust arbitrary keys).
export const REGISTRIES = {
  insurance: {
    table: 'insurance_policies', companyScoped: true, archiveStatus: 'cancelled',
    fields: ['policy_type', 'carrier', 'broker', 'policy_number', 'coverage_limit_each', 'coverage_limit_aggregate',
      'deductible', 'premium_amount', 'premium_frequency', 'wc_class_code', 'wc_rate_per_100', 'experience_mod',
      'effective_date', 'expiration_date', 'additional_insured', 'waiver_of_subrogation', 'document_url', 'status', 'source', 'notes'],
    required: ['policy_type'],
  },
  licenses: {
    table: 'licenses_credentials', companyScoped: true, archiveStatus: 'suspended',
    fields: ['scope', 'holder_profile_id', 'holder_name', 'credential_type', 'credential_number', 'issuing_body',
      'jurisdiction', 'classifications', 'issue_date', 'expiration_date', 'renewal_fee', 'renewal_frequency',
      'blocks_work', 'document_url', 'status', 'source'],
    required: ['credential_type'],
  },
  loans: {
    table: 'loans_obligations', companyScoped: true, archiveStatus: 'paid_off',
    fields: ['obligation_type', 'lender', 'account_last4', 'description', 'collateral', 'vehicle_jobber_id',
      'original_amount', 'current_balance', 'payment_amount', 'payment_frequency', 'interest_rate', 'payment_due_day',
      'maturity_date', 'balloon_amount', 'status', 'source', 'notes'],
    required: [],
  },
  leases: {
    table: 'leases', companyScoped: true, archiveStatus: 'terminated',
    fields: ['lease_type', 'landlord', 'premises', 'base_rent', 'cam_charges', 'rent_frequency', 'escalation_pct',
      'escalation_date', 'term_start', 'term_end', 'renewal_option', 'option_notice_deadline', 'security_deposit',
      'insurance_required', 'document_url', 'status', 'source'],
    required: [],
  },
  vehicles: {
    table: 'vehicle_costs', companyScoped: true, archiveStatus: 'out_of_service',
    fields: ['vehicle_jobber_id', 'vehicle_name', 'vin', 'license_plate', 'registration_expires', 'inspection_due',
      'odometer', 'odometer_updated', 'annual_miles', 'service_interval_miles', 'next_service_miles', 'loan_id',
      'insurance_policy_id', 'fuel_cost_per_mile', 'maintenance_cost_per_mile', 'replacement_reserve_per_mile',
      'assigned_profile_id', 'division_id', 'status'],
    required: [],
  },
  subscriptions: {
    table: 'subscriptions', companyScoped: false, archiveStatus: 'canceled',
    fields: ['name', 'category', 'what_it_does', 'relationship_owner', 'monthly_cost', 'cost_source',
      'billing_cycle', 'renewal_date', 'status', 'notes'],
    required: ['name'],
  },
};

// Annualize a registry premium/fee/payment by its frequency: mo ×12, wk ×52,
// yr ×1. Exported for unit tests (the registry_overhead view does the same).
export function annualizeRegistry(amount, frequency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  switch (frequency) {
    case 'mo': return n * 12;
    case 'wk': return n * 52;
    case 'yr': return n;
    default: return n; // views treat any non-mo/wk value as already annual
  }
}

// Resolve a vehicle_costs row's fleet obligation via its loan link. Given a
// vehicle and the set of loans, returns the linked loan (or null). Exported so
// the vehicle_costs -> loans_obligations link is unit-testable.
export function linkVehicleLoan(vehicle, loans) {
  if (!vehicle || !vehicle.loan_id) return null;
  return (Array.isArray(loans) ? loans : []).find((l) => l && l.id === vehicle.loan_id) || null;
}

// Pure mirror of the sql/079 per-section double-count fix, exported so the
// suppression rule is unit-testable without a database. Given already-annualized
// overhead cost_lines and the active registry rows: a cost line is dropped from
// overhead ONLY when it is source='benchmark' AND its section has a registry
// row; the registry total is then added. Confirmed/imported/manual lines and
// sections without registry rows are untouched.
export function overheadWithRegistryDedup(costLines, registryRows) {
  const regSections = new Set((registryRows || []).map((r) => r.section));
  const regTotal = (registryRows || []).reduce((a, r) => a + (Number(r.annual_amount) || 0), 0);
  let linesOverhead = 0;
  for (const l of costLines || []) {
    if (!(l.cost_type === 'fixed' || l.cost_type === 'variable')) continue;
    if (l.frequency === 'target_net') continue;
    if (l.source === 'benchmark' && regSections.has(l.section)) continue; // suppressed
    linesOverhead += Number(l.annualized) || 0;
  }
  return {
    overhead_total: linesOverhead + regTotal,
    overhead_from_registry: regTotal,
    suppressed_sections: [...regSections],
  };
}

// Resolve the tenant from the signed-in user (was a hardcoded slug + a
// module-global cache that would leak one company's id into another company's
// request on a warm serverless instance).
async function getCompanyId(user, deps = {}) {
  const t = await resolveCompany(user, deps);
  if (!t) throw new Error('No company for this account.');
  return t.company_id;
}

// Recalculated rates after every mutation. Reads company_rates; augments with
// overhead_from_registry (sum of registry_overhead annual_amount) so the UI can
// show how much overhead is now real. Once sql/079 lands, the view supplies
// overhead_from_registry natively and this fallback simply matches it.
async function getRates(companyId, deps = {}) {
  const request = deps.supabaseRequest || supabaseRequest;
  let rates = null;
  try {
    const r = await request(`company_rates?company_id=eq.${companyId}&limit=1`);
    if (r.ok) { const rows = await r.json(); rates = rows && rows[0] ? rows[0] : null; }
  } catch { /* view may be absent pre-migration */ }
  if (!rates) rates = { company_id: companyId };
  if (rates.overhead_from_registry == null) {
    try {
      const rr = await request(`registry_overhead?company_id=eq.${companyId}&select=annual_amount`);
      if (rr.ok) {
        const rows = await rr.json();
        rates.overhead_from_registry = rows.reduce((a, x) => a + (Number(x.annual_amount) || 0), 0);
      }
    } catch { /* view absent */ }
  }
  return rates;
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj && obj[f] !== undefined) out[f] = obj[f];
  return out;
}

async function listRegistry(cfg, companyId) {
  let path = `${cfg.table}?order=created_at.desc`;
  if (cfg.companyScoped) path += `&company_id=eq.${companyId}`;
  path += `&status=neq.${cfg.archiveStatus}`;
  const r = await supabaseRequest(path);
  if (!r.ok) throw new Error(`${cfg.table} list failed: ` + (await r.text()));
  return r.json();
}

export default async function handler(req, res) {
  const auth = await requireApiAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Not signed in.' });

  const resource = (req.query && req.query.resource) || '';
  const method = (req.method || 'GET').toUpperCase();

  try {
    const companyId = await getCompanyId(auth.user);

    // ---- overhead rollup -------------------------------------------------
    if (resource === 'overhead') {
      if (method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
      const r = await supabaseRequest(`registry_overhead?company_id=eq.${companyId}&order=section.asc`);
      if (!r.ok) throw new Error('registry_overhead read failed: ' + (await r.text()));
      const rows = await r.json();
      const bySection = [];
      const idx = new Map();
      let annual_total = 0;
      for (const row of rows) {
        const amt = Number(row.annual_amount) || 0;
        annual_total += amt;
        if (!idx.has(row.section)) { idx.set(row.section, bySection.length); bySection.push({ section: row.section, annual_total: 0, items: [] }); }
        const s = bySection[idx.get(row.section)];
        s.annual_total += amt;
        s.items.push(row);
      }
      return res.status(200).json({ ok: true, sections: bySection, annual_total });
    }

    // ---- compliance calendar --------------------------------------------
    if (resource === 'calendar') {
      if (method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
      const within = Number(req.query && req.query.within_days);
      let path = `compliance_calendar?company_id=eq.${companyId}&order=days_out.asc`;
      if (Number.isFinite(within)) path += `&days_out=lte.${within}`;
      const r = await supabaseRequest(path);
      if (!r.ok) throw new Error('compliance_calendar read failed: ' + (await r.text()));
      return res.status(200).json({ ok: true, items: await r.json() });
    }

    // ---- Reina proposals: list + bulk approve/reject ---------------------
    // Governance contract: approving APPLIES the proposed value to the target
    // (and flips that row's source to 'confirmed'); rejecting writes nothing to
    // the target, only marks the proposal rejected so it is never re-proposed.
    if (resource === 'proposals') {
      if (method === 'GET') {
        const status = (req.query && req.query.status) || 'pending';
        const r = await supabaseRequest(`reina_cost_proposals?company_id=eq.${companyId}&status=eq.${status}&order=created_at.desc`);
        if (!r.ok) throw new Error('proposals read failed: ' + (await r.text()));
        return res.status(200).json({ ok: true, proposals: await r.json() });
      }
      if (method === 'POST') {
        const body = req.body || {};
        const action = body.action;
        const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
        if (!['approve', 'reject'].includes(action) || ids.length === 0) {
          return res.status(400).json({ ok: false, error: 'action (approve|reject) and ids[] are required.' });
        }
        const nowIso = new Date().toISOString();
        let applied = 0, rejected = 0;
        for (const id of ids) {
          const cur = await supabaseRequest(`reina_cost_proposals?id=eq.${id}&company_id=eq.${companyId}&status=eq.pending&limit=1`);
          const proposal = cur.ok ? (await cur.json())[0] : null;
          if (!proposal) continue; // gone or already reviewed

          if (action === 'reject') {
            await supabaseRequest(`reina_cost_proposals?id=eq.${id}`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ status: 'rejected', reviewed_at: nowIso }),
            });
            rejected += 1;
            continue;
          }

          // approve -> write the value through to the target, then confirm it
          const target = proposalTargetPatch(proposal);
          if (target) {
            const w = await supabaseRequest(`${target.table}?id=eq.${target.id}&company_id=eq.${companyId}`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(target.patch),
            });
            if (!w.ok) throw new Error(`applying proposal ${id} to ${target.table} failed: ` + (await w.text()));
          }
          await supabaseRequest(`reina_cost_proposals?id=eq.${id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'approved', reviewed_at: nowIso, applied_at: nowIso }),
          });
          applied += 1;
        }
        return res.status(200).json({ ok: true, applied, rejected, rates: await getRates(companyId) });
      }
      return res.status(405).json({ ok: false, error: 'Method not allowed.' });
    }

    // ---- registries ------------------------------------------------------
    const cfg = REGISTRIES[resource];
    if (!cfg) return res.status(404).json({ ok: false, error: `Unknown resource: ${resource || '(none)'}` });

    if (method === 'GET') {
      const items = await listRegistry(cfg, companyId);
      return res.status(200).json({ ok: true, items, rates: await getRates(companyId) });
    }

    if (method === 'POST') {
      const body = req.body || {};
      for (const req_f of cfg.required) {
        if (body[req_f] == null || body[req_f] === '') return res.status(400).json({ ok: false, error: `${req_f} is required.` });
      }
      const row = pick(body, cfg.fields);
      if (cfg.companyScoped) row.company_id = companyId;
      if (cfg.fields.includes('source') && !row.source) row.source = 'manual';
      const ins = await supabaseRequest(cfg.table, {
        method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([row]),
      });
      if (!ins.ok) throw new Error(`${cfg.table} insert failed: ` + (await ins.text()));
      const item = (await ins.json())[0];
      return res.status(200).json({ ok: true, item, rates: await getRates(companyId) });
    }

    if (method === 'PATCH') {
      const body = req.body || {};
      const id = body.id || (req.query && req.query.id);
      if (!id) return res.status(400).json({ ok: false, error: 'id is required.' });
      const patch = pick(body, cfg.fields);
      let path = `${cfg.table}?id=eq.${id}`;
      if (cfg.companyScoped) path += `&company_id=eq.${companyId}`;
      const upd = await supabaseRequest(path, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      if (!upd.ok) throw new Error(`${cfg.table} update failed: ` + (await upd.text()));
      const item = (await upd.json())[0] || null;
      if (!item) return res.status(404).json({ ok: false, error: 'Row not found.' });
      return res.status(200).json({ ok: true, item, rates: await getRates(companyId) });
    }

    if (method === 'DELETE') {
      const id = (req.body && req.body.id) || (req.query && req.query.id);
      if (!id) return res.status(400).json({ ok: false, error: 'id is required.' });
      let path = `${cfg.table}?id=eq.${id}`;
      if (cfg.companyScoped) path += `&company_id=eq.${companyId}`;
      const upd = await supabaseRequest(path, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: cfg.archiveStatus }),
      });
      if (!upd.ok) throw new Error(`${cfg.table} archive failed: ` + (await upd.text()));
      const item = (await upd.json())[0] || null;
      return res.status(200).json({ ok: true, archived: true, item, rates: await getRates(companyId) });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
