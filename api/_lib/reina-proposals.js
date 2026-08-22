// api/_lib/reina-proposals.js
// Overhead Registries + Payroll Integration — Slice 6.
//
// The standing governance contract: Reina DRAFTS cost changes as
// reina_cost_proposals rows; a human approves before anything is written.
// Reina never writes employee_pay or cost_lines directly. This module holds the
// pure, testable pieces of that flow:
//   * buildBurdenProposals — turn a computed payroll burden into proposals
//   * proposalTargetPatch  — what an APPROVAL writes to the target (nothing for
//                            a rejection)
//   * isAlreadyRejected    — so a rejected value is never re-proposed

function round2(n) { const x = Number(n); return Number.isFinite(x) ? Math.round(x * 100) / 100 : null; }

// Build one burden_rate proposal per employee whose current burden differs from
// the payroll-derived burden. `rows` are employee_pay rows that ALREADY have an
// id (existing rows or freshly-inserted). `evidence` is the period dates/amounts
// the numbers came from. confidence scales with how many processed runs backed
// the number (4+ runs -> 100). Previously-rejected identical values are skipped.
export function buildBurdenProposals(rows, burden, evidence, rejected = []) {
  const proposed = { payroll_tax_pct: round2(burden.payroll_tax_pct), other_burden_pct: round2(burden.other_burden_pct) };
  if (proposed.payroll_tax_pct == null && proposed.other_burden_pct == null) return [];
  const confidence = Math.max(10, Math.min(100, (burden.runs || 0) * 25));

  const out = [];
  for (const r of rows || []) {
    if (!r.id) continue;
    const current = { payroll_tax_pct: r.payroll_tax_pct != null ? Number(r.payroll_tax_pct) : null,
      other_burden_pct: r.other_burden_pct != null ? Number(r.other_burden_pct) : null };
    // no change -> no proposal
    if (current.payroll_tax_pct === proposed.payroll_tax_pct && current.other_burden_pct === proposed.other_burden_pct) continue;
    const candidate = {
      source: 'payroll_sync', proposal_type: 'burden_rate',
      target_table: 'employee_pay', target_id: r.id,
      current_value: current, proposed_value: proposed,
      rationale: `Employer taxes averaged ${proposed.payroll_tax_pct}% of gross and benefits ${proposed.other_burden_pct}% across the last ${burden.runs || 0} processed run(s). The record says ${current.payroll_tax_pct == null ? 'unset' : current.payroll_tax_pct + '%'}.`,
      evidence, confidence, status: 'pending',
    };
    if (isAlreadyRejected(candidate, rejected)) continue;
    out.push(candidate);
  }
  return out;
}

// A rejected proposal with the same target and the same proposed value must
// never be re-proposed.
export function isAlreadyRejected(candidate, rejected) {
  return (rejected || []).some((p) =>
    p.status === 'rejected' &&
    p.target_table === candidate.target_table &&
    p.target_id === candidate.target_id &&
    JSON.stringify(p.proposed_value) === JSON.stringify(candidate.proposed_value));
}

// What an APPROVAL writes to the target row. Returns null when there is nothing
// to write (e.g. a rejection, or a proposal type with no direct target) — the
// caller still updates the proposal's own status, but writes nothing else.
// This is the single place that turns an approved proposal into a real edit, so
// "approve writes through, reject does not" is enforced here.
export function proposalTargetPatch(proposal) {
  if (!proposal || proposal.proposal_type !== 'burden_rate') return null;
  if (proposal.target_table !== 'employee_pay' || !proposal.target_id) return null;
  const pv = proposal.proposed_value || {};
  const patch = { source: 'confirmed' };
  if (pv.payroll_tax_pct != null) patch.payroll_tax_pct = pv.payroll_tax_pct;
  if (pv.other_burden_pct != null) patch.other_burden_pct = pv.other_burden_pct;
  return { table: 'employee_pay', id: proposal.target_id, patch };
}
