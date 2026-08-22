// api/_lib/project-numbers.js — one number for the life of a project.
//
// Chris's rule (2026-08-17): a project gets ONE number when its first document
// is raised, and keeps it forever. Each document type wears its own prefix:
//
//     E-10001         estimate
//     E-10001-R2      revision of that estimate
//     J-10001         the job it converted into
//     CO-10001-1      change orders against the job
//     INV-10001-1     invoices against the job (progress billing => -1, -2, -3)
//     J-10001-EL      GH Electric's internal work order on that job
//
// The point of the shared sequence is that anyone can see at a glance that
// E-10001, J-10001 and INV-10001-2 are the same piece of work. Nothing here
// ever renumbers: a job that changes hands, changes division, or gets rebilled
// keeps its number.
//
// Division deliberately does NOT appear in the project number. Divisions
// subcontract to each other (Design|Build hiring GH Electric on a renovation),
// so the division that owns a project can change or be shared — and baking a
// mutable fact into an immutable identifier is how you end up renumbering.
// Division lives on the job as a field, and on the internal work-order suffix.
//
// The formatters below are pure and take a sequence number, so they can be
// tested without a database. Allocation is the one part that must touch
// Postgres — see allocateProjectSequence.

import { supabaseRequest as defaultSb } from './jobber.js';

export const PROJECT_SEQUENCE_START = 10000;

function assertSeq(seq) {
  const n = Number(seq);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`A project number must be a positive whole number (got ${JSON.stringify(seq)}).`);
  }
  return n;
}

function assertIndex(n, label) {
  const i = Number(n);
  if (!Number.isInteger(i) || i < 1) {
    throw new Error(`${label} must be 1 or higher (got ${JSON.stringify(n)}).`);
  }
  return i;
}

export function estimateRef(seq) { return `E-${assertSeq(seq)}`; }

// Revisions keep the project number -- a re-quote at a different price is the
// same project, so issuing a fresh number there would break the whole scheme.
// R1 is the original and is written without a suffix.
export function estimateRevisionRef(seq, revision) {
  const n = assertSeq(seq);
  const r = assertIndex(revision, 'An estimate revision');
  return r === 1 ? `E-${n}` : `E-${n}-R${r}`;
}

export function jobRef(seq) { return `J-${assertSeq(seq)}`; }

export function changeOrderRef(seq, index) {
  return `CO-${assertSeq(seq)}-${assertIndex(index, 'A change order number')}`;
}

// Progress billing means one job can carry several invoices (deposit, draw,
// final), so an invoice is always numbered within its project.
export function invoiceRef(seq, index) {
  return `INV-${assertSeq(seq)}-${assertIndex(index, 'An invoice number')}`;
}

// Internal only -- the client never sees this. When GH Design|Build hires GH
// Electric on J-10001, Electric's slice is J-10001-EL. The customer-facing
// chain (estimate, change orders, invoices) stays with the owning division.
export function workOrderRef(seq, divisionCode) {
  const n = assertSeq(seq);
  const code = String(divisionCode || '').trim().toUpperCase();
  if (!code) throw new Error('A work order needs the division it belongs to.');
  // org_units codes are company-prefixed ('GH-EL'); the suffix uses the
  // division half only, since the company is already implied by the project.
  const short = code.includes('-') ? code.slice(code.lastIndexOf('-') + 1) : code;
  if (!/^[A-Z]{2,4}$/.test(short)) {
    throw new Error(`"${divisionCode}" is not a usable division code.`);
  }
  return `J-${n}-${short}`;
}

// Everything a project's documents are called, from one sequence number.
export function projectRefs(seq) {
  const n = assertSeq(seq);
  return {
    sequence: n,
    estimate: estimateRef(n),
    job: jobRef(n),
    estimateRevision: (r) => estimateRevisionRef(n, r),
    changeOrder: (i) => changeOrderRef(n, i),
    invoice: (i) => invoiceRef(n, i),
    workOrder: (code) => workOrderRef(n, code),
  };
}

// Reads the project number back out of any document reference. Used to link an
// estimate to its job without threading the raw sequence through every call.
// Returns null rather than throwing -- callers routinely hand this Jobber
// references ('Z2lkOi8vSm9iYmVy…') that legitimately carry no project number.
export function parseProjectSequence(ref) {
  const m = /^(?:E|J|CO|INV)-(\d+)\b/.exec(String(ref || '').trim().toUpperCase());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The only part that needs Postgres. The allocation itself happens inside
// allocate_project_number() so that two people creating estimates at the same
// moment can't be handed the same number -- see the migration for why this
// can't be done by reading and writing the counter from here.
export async function allocateProjectSequence(companyId, deps = {}) {
  const sb = deps.supabaseRequest || defaultSb;
  if (!companyId) throw new Error('A company is required to allocate a project number.');
  const res = await sb('rpc/allocate_project_number', {
    method: 'POST',
    body: JSON.stringify({ p_company_id: companyId }),
  });
  if (!res.ok) {
    throw new Error(`Could not allocate a project number: ${(await res.text()).slice(0, 200)}`);
  }
  const rows = await res.json();
  const seq = Array.isArray(rows) ? rows[0]?.sequence_no : rows?.sequence_no;
  const n = Number(seq);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('The project number allocator returned nothing usable.');
  }
  return n;
}
