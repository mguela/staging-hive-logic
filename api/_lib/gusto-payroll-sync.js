// api/_lib/gusto-payroll-sync.js
// Overhead Registries + Payroll Integration — Slice 5.
//
// READ-ONLY payroll sync from Gusto into employee_pay + payroll_period_costs.
// Never writes back to Gusto. Dry-run by default: it prints/returns exactly what
// it WOULD write (with counts by pay type and field/office split) and touches no
// database. A committing run (dryRun:false) writes, but NEVER overwrites a row
// whose source='confirmed'.
//
// PRIVACY (Law 10): SSN and bank details are dropped at the boundary. Employee
// records are passed through sanitizeEmployee() which whitelists only non-
// sensitive fields, so an SSN or routing/account number can never reach a log
// or a database column. We also never call Gusto's bank_accounts endpoint.
//
// Pulls, in order:
//   1. /v1/companies/{id}/employees
//   2. /v1/companies/{id}/employees/{id}/jobs         (title, rate, payment unit)
//   3. /v1/companies/{id}/payrolls?processed=true      (last four processed runs)

import { gustoGet as realGustoGet, getGustoCompanyId as realGetCompanyId, gustoConnected as realConnected } from '../gusto/index.js';
import { supabaseRequest as realSupabaseRequest } from './jobber.js';
import { buildBurdenProposals } from './reina-proposals.js';

// Job titles that read as field (billable) work. is_field is ALWAYS a guess and
// every synced person lands needing confirmation (source='imported').
const FIELD_WORDS = /(carpenter|laborer|labourer|foreman|installer|tech|technician|plumber|electric|mechanic|framer|mason|roofer|painter|apprentice|helper|driver|crew|field|hvac|welder|operator|fitter)/i;
const OFFICE_WORDS = /(manager|admin|estimator|bookkeep|account|office|sales|coordinator|owner|president|controller|dispatcher|receptionist|hr\b|marketing|clerk)/i;

export function inferIsField(title) {
  const t = String(title || '');
  if (OFFICE_WORDS.test(t) && !FIELD_WORDS.test(t)) return false;
  return true; // default to field; confirmation required regardless
}

// Whitelist the only employee fields we are willing to touch. Anything else
// Gusto returns (ssn, dob, home address, etc.) is dropped here and never seen
// downstream.
export function sanitizeEmployee(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return {
    uuid: raw.uuid,
    first_name: raw.first_name,
    last_name: raw.last_name,
    email: raw.email,
    terminated: raw.terminated === true,
  };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round2(n) { return Math.round(n * 100) / 100; }

// Employer-tax and benefit burden as a % of gross, averaged across processed
// runs. Returns { payroll_tax_pct, other_burden_pct, runs, gross }.
export function computeBurdenFromRuns(payrolls) {
  let gross = 0, employerTaxes = 0, benefits = 0, runs = 0;
  for (const p of payrolls || []) {
    const t = (p && p.totals) || {};
    const g = num(t.gross_pay);
    if (g <= 0) continue;
    gross += g;
    employerTaxes += num(t.employer_taxes);
    benefits += num(t.benefits);
    runs += 1;
  }
  return {
    payroll_tax_pct: gross > 0 ? round2((employerTaxes / gross) * 100) : null,
    other_burden_pct: gross > 0 ? round2((benefits / gross) * 100) : null,
    runs, gross,
  };
}

export function matchProfileId(email, profiles) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return null;
  const hit = (profiles || []).find((p) => String(p.email || '').trim().toLowerCase() === key);
  return hit ? hit.id : null;
}

// Pick the current job + compensation from Gusto's /jobs payload.
function currentJob(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const primary = list.find((j) => j.primary) || list[0] || null;
  if (!primary) return { title: null, rate: null, unit: null };
  const comps = Array.isArray(primary.compensations) ? primary.compensations : [];
  const comp = (primary.current_compensation_uuid && comps.find((c) => c.uuid === primary.current_compensation_uuid))
    || comps[comps.length - 1] || {};
  return { title: primary.title || null, rate: comp.rate != null ? num(comp.rate) : null, unit: comp.payment_unit || null };
}

// Build the employee_pay rows (pure, testable). burden = computeBurdenFromRuns().
export function buildEmployeePayRows(employees, jobsByEmp, profiles, burden) {
  return (employees || []).map((raw) => {
    const e = sanitizeEmployee(raw);
    const job = currentJob(jobsByEmp[e.uuid]);
    const pay_type = job.unit === 'Hour' ? 'hourly' : 'salary';
    return {
      display_name: [e.first_name, e.last_name].filter(Boolean).join(' ').trim() || e.email || 'Unnamed',
      profile_id: matchProfileId(e.email, profiles),
      pay_type,
      base_rate: job.rate != null ? job.rate : 0,
      is_field: inferIsField(job.title),
      payroll_tax_pct: burden.payroll_tax_pct != null ? burden.payroll_tax_pct : undefined,
      other_burden_pct: burden.other_burden_pct != null ? burden.other_burden_pct : undefined,
      source: 'imported',
      _title: job.title, // helper for the dry-run report only; stripped before write
      _terminated: e.terminated,
    };
  });
}

function summarize(rows) {
  const by_pay_type = { hourly: 0, salary: 0 };
  const field_office = { field: 0, office: 0 };
  for (const r of rows) {
    by_pay_type[r.pay_type] = (by_pay_type[r.pay_type] || 0) + 1;
    if (r.is_field) field_office.field += 1; else field_office.office += 1;
  }
  return { by_pay_type, field_office };
}

export async function runPayrollSync({ dryRun = true, deps = {} } = {}) {
  const gustoGet = deps.gustoGet || realGustoGet;
  const getCompanyId = deps.getGustoCompanyId || realGetCompanyId;
  const connected = deps.gustoConnected || realConnected;
  const supabaseRequest = deps.supabaseRequest || realSupabaseRequest;

  if (!(await connected())) {
    return { ok: false, connected: false, dryRun, error: 'Gusto is not connected. Visit /api/gusto to authorize.' };
  }
  const companyId = await getCompanyId();
  if (!companyId) return { ok: false, connected: true, dryRun, error: 'No Gusto company id on the stored connection.' };

  // 1) employees, 2) jobs per employee, 3) last four processed payrolls
  const employees = await gustoGet(`/v1/companies/${companyId}/employees`);
  const jobsByEmp = {};
  for (const e of employees || []) {
    const uuid = e && e.uuid;
    if (!uuid) continue;
    try { jobsByEmp[uuid] = await gustoGet(`/v1/employees/${uuid}/jobs`); }
    catch { jobsByEmp[uuid] = []; }
  }
  const allPayrolls = await gustoGet(`/v1/companies/${companyId}/payrolls?processed=true`);
  const processed = (allPayrolls || []).filter((p) => p && (p.processed || p.processed_date)).slice(-4);

  const burden = computeBurdenFromRuns(processed);
  const profiles = deps.__profiles || await loadProfiles({ supabaseRequest });
  const rows = buildEmployeePayRows(employees, jobsByEmp, profiles, burden);

  // payroll_period_costs rows (one per processed run)
  const periodRows = processed.map((p) => {
    const t = p.totals || {};
    const pp = p.pay_period || {};
    return {
      period_start: pp.start_date || p.start_date, period_end: pp.end_date || p.end_date,
      gross_wages: num(t.gross_pay), employer_taxes: num(t.employer_taxes), benefits: num(t.benefits),
      total_cost: t.company_debit != null ? num(t.company_debit) : num(t.gross_pay) + num(t.employer_taxes) + num(t.benefits),
      source: 'gusto',
    };
  });

  const plan = {
    ok: true, connected: true, dryRun, companyId,
    employees: (employees || []).length,
    would_write_employee_pay: rows.length,
    ...summarize(rows),
    payroll_periods: periodRows.length,
    burden: { payroll_tax_pct: burden.payroll_tax_pct, other_burden_pct: burden.other_burden_pct, runs: burden.runs },
    // sanitized preview — no SSN/bank anywhere in here
    sample: rows.slice(0, 5).map((r) => ({ display_name: r.display_name, pay_type: r.pay_type, base_rate: r.base_rate, is_field: r.is_field, title: r._title, matched_profile: Boolean(r.profile_id) })),
  };

  if (dryRun) return plan;

  // ---- commit path: never overwrite source='confirmed' -------------------
  // Slice 6 governance: burden percentages are NOT written to employee_pay
  // directly here — they are stripped from the write and instead drafted as
  // reina_cost_proposals (below) for human approval. Reina drafts; a human
  // approves.
  const existResp = await supabaseRequest(`employee_pay?company_id=eq.${companyId}&effective_to=is.null&select=id,profile_id,display_name,source,payroll_tax_pct,other_burden_pct`);
  const existing = existResp.ok ? await existResp.json() : [];
  const keyOf = (r) => r.profile_id ? 'p:' + r.profile_id : 'n:' + String(r.display_name || '').toLowerCase();
  const existingByKey = new Map(existing.map((r) => [keyOf(r), r]));

  let inserted = 0, updated = 0, skipped_confirmed = 0;
  const rowsWithIds = []; // { id, payroll_tax_pct, other_burden_pct } current burden, for proposal diffing
  for (const r of rows) {
    const { _title, _terminated, payroll_tax_pct, other_burden_pct, ...row } = r; // burden stripped -> proposals only
    Object.keys(row).forEach((k) => row[k] === undefined && delete row[k]);
    const ex = existingByKey.get(keyOf(r));
    if (ex && ex.source === 'confirmed') { skipped_confirmed += 1; rowsWithIds.push({ id: ex.id, payroll_tax_pct: ex.payroll_tax_pct, other_burden_pct: ex.other_burden_pct }); continue; }
    if (ex) {
      const up = await supabaseRequest(`employee_pay?id=eq.${ex.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
      if (up.ok) updated += 1;
      rowsWithIds.push({ id: ex.id, payroll_tax_pct: ex.payroll_tax_pct, other_burden_pct: ex.other_burden_pct });
    } else {
      const ins = await supabaseRequest('employee_pay', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ ...row, company_id: companyId }]) });
      if (ins.ok) { inserted += 1; const created = (await ins.json())[0]; if (created) rowsWithIds.push({ id: created.id, payroll_tax_pct: created.payroll_tax_pct, other_burden_pct: created.other_burden_pct }); }
    }
  }

  // Draft burden proposals (never write burden directly). Skip any value that
  // was previously rejected for the same target.
  let proposals_created = 0;
  const evidence = periodRows.map((p) => ({ period_start: p.period_start, period_end: p.period_end, gross_wages: p.gross_wages, employer_taxes: p.employer_taxes, benefits: p.benefits }));
  const rejResp = await supabaseRequest(`reina_cost_proposals?company_id=eq.${companyId}&status=eq.rejected&proposal_type=eq.burden_rate&select=target_table,target_id,proposed_value,status`);
  const rejected = rejResp.ok ? await rejResp.json() : [];
  const proposals = buildBurdenProposals(rowsWithIds, burden, evidence, rejected);
  if (proposals.length) {
    const pr = await supabaseRequest('reina_cost_proposals', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(proposals.map((p) => ({ ...p, company_id: companyId }))) });
    if (pr.ok) proposals_created = proposals.length;
  }

  let periods_written = 0;
  if (periodRows.length) {
    const pw = await supabaseRequest('payroll_period_costs?on_conflict=period_start,period_end,source', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(periodRows),
    });
    if (pw.ok) periods_written = periodRows.length;
  }
  return { ...plan, dryRun: false, inserted, updated, skipped_confirmed, proposals_created, periods_written };
}

// Fetch profiles for email matching (tests inject via deps.__profiles instead).
export async function loadProfiles(deps = {}) {
  const supabaseRequest = deps.supabaseRequest || realSupabaseRequest;
  const r = await supabaseRequest('profiles?select=id,email');
  return r.ok ? r.json() : [];
}
