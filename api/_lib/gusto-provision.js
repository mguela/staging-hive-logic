// api/_lib/gusto-provision.js
// Overhead Registries + Payroll Integration — #2 (onboarding → Gusto).
//
// Provisions a HiveLogic new hire into Gusto: creates the employee shell with
// self_onboarding=true (so Gusto collects SSN + bank directly from the employee
// — HiveLogic never handles that PII), adds a job, and sets the compensation
// for the admin-chosen pay type (hourly or salary). Read-only from Gusto
// elsewhere; this is the one deliberate write, and it never runs payroll.
//
// Env: works against whatever the stored connection is (demo today; production
// once real creds + Gusto Pre-Approval exist). It fails cleanly (configured/
// connected flags) rather than throwing when Gusto isn't ready.

import { gustoPost, gustoGet, gustoPut, getGustoCompanyId, gustoConnected, gustoConfigured } from '../gusto/index.js';

// Map HiveLogic pay type -> Gusto compensation fields.
export function compensationFor(payType, rate, effectiveDate) {
  const hourly = payType === 'hourly';
  return {
    rate: String(rate != null ? rate : (hourly ? '30.00' : '60000')),
    payment_unit: hourly ? 'Hour' : 'Year',
    flsa_status: hourly ? 'Nonexempt' : 'Exempt',
    effective_date: effectiveDate,
  };
}

// Split a display name into first/last for Gusto.
export function splitName(displayName, first, last) {
  if (first || last) return { first_name: first || 'New', last_name: last || 'Hire' };
  const parts = String(displayName || '').trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return { first_name: 'New', last_name: 'Hire' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') || 'Hire' };
}

// Update an existing hire's Gusto compensation (pay change) — finds the job's
// current compensation and PUTs the new pay type/rate in place (no effective_date
// resend, same as provisioning). Returns { ok, status, data }.
export async function updateGustoCompensation(input = {}, deps = {}) {
  const _get = deps.gustoGet || gustoGet;
  const _put = deps.gustoPut || gustoPut;
  const today = deps.today || new Date().toISOString().slice(0, 10);
  const jobUuid = input.gusto_job_uuid;
  if (!jobUuid) return { ok: false, status: 0, data: 'no gusto_job_uuid on this hire' };

  let comps = [];
  try { const r = await _get(`/v1/jobs/${jobUuid}/compensations`); if (Array.isArray(r)) comps = r; } catch { /* try job next */ }
  if (!comps.length) {
    try { const jd = await _get(`/v1/jobs/${jobUuid}`); if (jd && Array.isArray(jd.compensations)) comps = jd.compensations; } catch { /* none */ }
  }
  const current = comps[comps.length - 1] || null;
  if (!current || !current.uuid) return { ok: false, status: 0, data: 'no compensation found for this job' };
  const c = compensationFor(input.pay_type, input.rate, today);
  return _put(`/v1/compensations/${current.uuid}`, {
    version: current.version, rate: c.rate, payment_unit: c.payment_unit, flsa_status: c.flsa_status,
  });
}

// Provision one employee. deps lets tests inject gustoPost/getGustoCompanyId etc.
export async function provisionEmployee(input = {}, deps = {}) {
  const _post = deps.gustoPost || gustoPost;
  const _get = deps.gustoGet || gustoGet;
  const _put = deps.gustoPut || gustoPut;
  const _companyId = deps.getGustoCompanyId || getGustoCompanyId;
  const _connected = deps.gustoConnected || gustoConnected;
  const _configured = deps.gustoConfigured || gustoConfigured;
  const today = deps.today || new Date().toISOString().slice(0, 10);

  if (!_configured()) return { ok: false, configured: false, error: 'Gusto is not configured for this deployment.' };
  if (!(await _connected())) return { ok: false, configured: true, connected: false, error: 'Gusto is not connected. Authorize at /api/gusto.' };
  const companyId = await _companyId();
  if (!companyId) return { ok: false, connected: true, error: 'No Gusto company id on the stored connection.' };

  const { first_name, last_name } = splitName(input.display_name, input.first_name, input.last_name);
  const email = input.email || `hire.${Date.now()}@example.com`;
  const pay_type = input.pay_type === 'salary' ? 'salary' : 'hourly';
  const title = input.title || (input.is_field === false ? 'Office' : 'Field Technician');

  // 1) Employee (self_onboarding — Gusto collects SSN/bank, not us)
  const emp = await _post(`/v1/companies/${companyId}/employees`, {
    first_name, last_name, email, self_onboarding: true,
  });
  if (!emp.ok) return { ok: false, step: 'create_employee', gusto_status: emp.status, gusto_response: emp.data };
  const gusto_employee_uuid = emp.data && emp.data.uuid;

  // 2) Job
  const job = await _post(`/v1/employees/${gusto_employee_uuid}/jobs`, { title, hire_date: today });
  if (!job.ok) return { ok: false, step: 'create_job', gusto_employee_uuid, gusto_status: job.status, gusto_response: job.data };
  const gusto_job_uuid = job.data && job.data.uuid;

  // 3) Set the compensation to the chosen pay type. Gusto auto-creates a
  //    default compensation WITH the job (embedded in the job response), so we
  //    UPDATE that one — adding a new comp at the same effective_date collides,
  //    and updating must NOT resend effective_date.
  const c = compensationFor(pay_type, input.rate, today);
  let comp = { ok: false, status: 0, data: null };
  let comp_source = 'none';
  let jobComps = (job.data && Array.isArray(job.data.compensations)) ? job.data.compensations : [];
  if (jobComps.length) { comp_source = 'embedded'; }
  else {
    try { const jd = await _get(`/v1/jobs/${gusto_job_uuid}`); if (jd && Array.isArray(jd.compensations)) { jobComps = jd.compensations; comp_source = 'fetched'; } }
    catch { /* ignore */ }
  }
  const current = jobComps[jobComps.length - 1] || null;
  if (current && current.uuid) {
    comp = await _put(`/v1/compensations/${current.uuid}`, {
      version: current.version, rate: c.rate, payment_unit: c.payment_unit, flsa_status: c.flsa_status,
    });
    comp_source += ':put';
  } else {
    comp = await _post(`/v1/jobs/${gusto_job_uuid}/compensations`, c);
    comp_source += ':post';
  }

  const out = {
    ok: true,
    gusto_employee_uuid,
    gusto_job_uuid,
    pay_type,
    comp_ok: comp.ok,
    comp_status: comp.status,
    comp_response: comp.data,
    comp_source,
    self_onboarding: true,
    note: 'Employee created via self_onboarding — Gusto collects SSN/bank directly; HiveLogic never handles it.',
  };
  // Diagnostics only when the comp step didn't take, so we can pin the shape.
  if (!comp.ok) {
    out._debug = {
      job_comp_count: jobComps.length,
      current: current ? { uuid: current.uuid, version: current.version, effective_date: current.effective_date, payment_unit: current.payment_unit } : null,
      job_keys: job.data ? Object.keys(job.data) : null,
    };
  }
  return out;
}
