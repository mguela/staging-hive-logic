// api/_lib/qbo-cost-import.js
// Slice 3 — QuickBooks chart-of-accounts import for the cost model.
//
// Pulls the QBO chart of accounts + a trailing-12-month Profit & Loss through
// the EXISTING QBO integration (api/qbo/index.js — same tokens, same refresh),
// maps each account to a cost_lines section/cost_type via the cost_account_map
// rule table (sql/073), and produces `imported` cost lines normalized to
// frequency='yr'. Unmapped accounts go to an 'Unsorted' section for review.
//
// SAFETY:
//   * DRY-RUN by default. Nothing is written unless dryRun === false.
//   * Never overwrites a line whose source='confirmed'.
//   * Read-only against QuickBooks (query + report only).
// The real dry-run against the live GH QBO connection needs QBO_CLIENT_ID/
// SECRET + an authorized connection in the deployment env; where those are
// absent this returns a structured {configured/connected:false} result rather
// than throwing (see REPORT.md "Needs Chris").

import { qboConfigured, qboConnected, getFinancials, qboReport, qboFlattenReport } from '../qbo/index.js';

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Trailing-12-month window ending today, as ISO dates.
function t12mWindow() {
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 1);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start_date: iso(start), end_date: iso(end) };
}

// Choose the first matching rule (rules pre-sorted by sort_order). A rule
// matches when its type (if set) equals the account type case-insensitively
// AND its name pattern (if set) matches the account name case-insensitively.
function matchRule(account, rules) {
  const name = String(account.name || '');
  const type = String(account.type || '');
  for (const r of rules) {
    const typeOk = !r.qbo_account_type || r.qbo_account_type.toLowerCase() === type.toLowerCase();
    let nameOk = true;
    if (r.qbo_account_name_pattern) {
      try { nameOk = new RegExp(r.qbo_account_name_pattern, 'i').test(name); }
      catch { nameOk = name.toLowerCase().includes(String(r.qbo_account_name_pattern).toLowerCase()); }
    }
    if (typeOk && nameOk) {
      // Downgrade confidence when only one dimension actually constrained.
      let confidence = r.confidence;
      if (r.qbo_account_type && r.qbo_account_name_pattern) confidence = Math.max(confidence, 100);
      return { rule: r, section: r.target_section, cost_type: r.target_cost_type, confidence };
    }
  }
  return null;
}

export async function runQboImport({ companyId, dryRun = true, supabaseRequest }) {
  const base = { ok: false, dryRun, configured: qboConfigured(), connected: false,
    accounts_pulled: 0, mapped: 0, unsorted: 0, proposed: [], skipped_confirmed: [] };

  if (!qboConfigured()) {
    return { ...base, error: 'QuickBooks is not configured for this deployment (QBO_CLIENT_ID/QBO_CLIENT_SECRET unset).' };
  }
  if (!(await qboConnected())) {
    return { ...base, configured: true, error: 'QuickBooks is not connected yet. Visit /api/qbo to authorize.' };
  }

  // 1) Chart of accounts (Name, AccountType, AccountSubType, CurrentBalance).
  const acctResp = await getFinancials('accounts');
  if (acctResp && acctResp.error) {
    return { ...base, configured: true, connected: false, error: acctResp.error };
  }
  const accounts = (acctResp && acctResp.accounts) || [];

  // 2) Trailing-12-month P&L actuals, keyed by lowercased account label.
  const window = t12mWindow();
  const t12mByName = new Map();
  try {
    const rep = await qboReport('ProfitAndLoss', { ...window, accounting_method: 'Accrual' });
    for (const row of qboFlattenReport(rep)) {
      t12mByName.set(String(row.label || '').trim().toLowerCase(), num(row.amount));
    }
  } catch (e) {
    // P&L is a refinement over the balance fallback; a failure here is not fatal.
    base.pnl_warning = 'Trailing-12-month P&L pull failed; fell back to account balances. ' + (e.message || '');
  }

  // 3) Load mapping rules (pre-sorted).
  const ruleResp = await supabaseRequest('cost_account_map?order=sort_order.asc');
  if (!ruleResp.ok) throw new Error('cost_account_map read failed: ' + (await ruleResp.text()));
  const rules = await ruleResp.json();

  // 4) Existing lines — to protect confirmed rows on commit.
  const existResp = await supabaseRequest(`cost_lines?company_id=eq.${companyId}&select=id,name,source&archived=eq.false`);
  const existing = existResp.ok ? await existResp.json() : [];
  const confirmedNames = new Set(existing.filter((l) => l.source === 'confirmed').map((l) => String(l.name).toLowerCase()));

  // 5) Build proposed lines.
  const proposed = [];
  let mapped = 0, unsorted = 0;
  for (const a of accounts) {
    const m = matchRule(a, rules);
    const section = m ? m.section : 'Unsorted';
    const cost_type = m ? m.cost_type : 'fixed';
    const confidence = m ? m.confidence : 20;
    if (m) mapped++; else unsorted++;

    const t12m = t12mByName.get(String(a.name || '').trim().toLowerCase());
    const amount = t12m != null ? Math.abs(t12m) : Math.abs(num(a.balance));
    const amountSource = t12m != null ? 'T12M P&L' : 'account balance (no P&L match)';

    proposed.push({
      company_id: companyId,
      section, name: a.name, note: `Imported from QuickBooks — ${amountSource}`,
      amount, frequency: 'yr', cost_type, source: 'imported', confidence,
      qbo_account_type: a.type,
    });
  }

  const result = {
    ok: true, dryRun, configured: true, connected: true,
    window,
    accounts_pulled: accounts.length,
    mapped, unsorted,
    proposed, skipped_confirmed: [],
    pnl_warning: base.pnl_warning,
  };

  // 6) Commit path (only when explicitly asked). Never touch confirmed lines.
  if (!dryRun) {
    const toWrite = [];
    for (const p of proposed) {
      if (confirmedNames.has(String(p.name).toLowerCase())) { result.skipped_confirmed.push(p.name); continue; }
      const { qbo_account_type, ...row } = p; // strip helper field not on the table
      toWrite.push(row);
    }
    if (toWrite.length) {
      const ins = await supabaseRequest('cost_lines', {
        method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(toWrite),
      });
      if (!ins.ok) throw new Error('imported-line insert failed: ' + (await ins.text()));
      result.written = (await ins.json()).length;
    } else {
      result.written = 0;
    }
  }

  return result;
}
