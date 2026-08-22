// api/_lib/automations.js
//
// The shared harness behind the Company Setup automation toggles.
//
// Every runner in api/automations.js goes through here so the safety rules are
// written once and cannot be forgotten in one runner but not another.
//
// TWO GATES, BOTH REQUIRED before anything reaches a customer:
//   1. hl_message_settings.enabled — the MASTER switch, currently false. While
//      it is false every row is queued with status 'preview': a live picture of
//      exactly what would go out, delivered to nobody. Flipping it to true is
//      the single deliberate act that turns previews into sendable 'queued'
//      rows. Nothing here sends — a processor consumes 'queued' rows.
//   2. company_settings.automations.<key>.enabled — the per-automation toggle.
//
// IDEMPOTENCY: every queued row carries a dedupe_key with a unique index behind
// it (sql/087). A nightly runner that re-finds the same overdue invoice tries to
// queue the same key and the insert is simply ignored — which is what stops a
// client being nudged about one invoice every night for a month. Runners must
// therefore build a key that is stable for "this message, about this thing, at
// this stage" — not one containing a timestamp.

import { supabaseRequest as defaultSb } from './jobber.js';
import { resolveCompany as defaultResolve } from './tenant.js';

export const AUTOMATION_KEYS = [
  'missed_call_textback',
  'invoice_overdue_nudge',
  'dormant_client_reengage',
  // deposit_releases_pos is deliberately absent — see api/automations.js.
];

// PostgREST's "relation does not exist" signals, i.e. sql/087 not applied yet.
export function isMissingTable(status, text) {
  if (status !== 404 && status !== 400) return false;
  return /PGRST205|42P01|does not exist|Could not find the table/i.test(text || '');
}

/**
 * Resolve the tenant for a cron call. Crons carry no user, so this leans on
 * resolveCompany's sole-company fallback, which self-disables at company #2.
 */
export async function companyForCron(deps = {}) {
  const resolve = deps.resolveCompany || defaultResolve;
  const t = await resolve(null, deps);
  return t && t.company_id ? t.company_id : null;
}

/**
 * The saved config for one automation, merged over its defaults.
 * Returns { enabled, ...settings }. A missing table or row means "not
 * configured" — which is `enabled: false`, never a surprise send.
 */
export async function automationConfig(companyId, key, deps = {}) {
  const sb = deps.supabaseRequest || defaultSb;
  if (!companyId) return { enabled: false, _reason: 'no-company' };
  try {
    const r = await sb(
      `company_settings?company_id=eq.${encodeURIComponent(companyId)}` +
      '&section=eq.automations&select=value&limit=1',
    );
    if (!r.ok) return { enabled: false, _reason: 'settings-unreadable' };
    const rows = await r.json();
    const all = (rows && rows[0] && rows[0].value) || {};
    const cfg = all[key];
    if (!cfg || typeof cfg !== 'object') return { enabled: false, _reason: 'not-configured' };
    return { ...cfg, enabled: cfg.enabled === true };
  } catch {
    return { enabled: false, _reason: 'settings-error' };
  }
}

/**
 * The master switch. Defaults to CLOSED on any error or missing row — the one
 * direction it is safe to be wrong in.
 */
export async function masterSendEnabled(deps = {}) {
  const sb = deps.supabaseRequest || defaultSb;
  try {
    const r = await sb('hl_message_settings?id=eq.true&select=enabled&limit=1');
    if (!r.ok) return false;
    const rows = await r.json();
    return !!(rows && rows[0] && rows[0].enabled === true);
  } catch {
    return false;
  }
}

/**
 * Queue messages into hl_outbox.
 *
 * `rows` are partial outbox rows; this fills in status, automation and
 * company_id. Returns { queued, duplicates } — duplicates are rows the unique
 * dedupe index rejected, which is a normal, expected outcome on a repeat tick,
 * not an error.
 *
 * Rows are inserted ONE AT A TIME on purpose. A single batch insert would be
 * rejected in full by one duplicate key, so a repeat tick that finds nine known
 * invoices and one new one would queue nothing.
 */
export async function queueAutomationMessages(rows, { automation, companyId, sendEnabled }, deps = {}) {
  const sb = deps.supabaseRequest || defaultSb;
  let queued = 0;
  let duplicates = 0;
  let tableMissing = false;

  for (const row of rows) {
    const payload = {
      ...row,
      automation,
      company_id: companyId || null,
      // The master switch decides sendable vs preview-only. A processor picks
      // up 'queued'; 'preview' rows are for the human to read and nothing else.
      status: sendEnabled ? 'queued' : 'preview',
      scheduled_for: row.scheduled_for || new Date().toISOString(),
    };
    let r;
    try {
      r = await sb('hl_outbox', { method: 'POST', body: JSON.stringify(payload) });
    } catch {
      continue;
    }
    if (r.ok) { queued += 1; continue; }
    const text = await r.text().catch(() => '');
    if (isMissingTable(r.status, text)) { tableMissing = true; break; }
    // 23505 = unique_violation: this exact message is already queued.
    if (r.status === 409 || /23505|duplicate key/i.test(text)) { duplicates += 1; continue; }
    // Anything else is a real failure for this row; keep going so one bad
    // recipient cannot stop the rest of the batch.
  }

  return { queued, duplicates, tableMissing };
}

/** Record what this tick did — including the ticks that did nothing. */
export async function recordRun(entry, deps = {}) {
  const sb = deps.supabaseRequest || defaultSb;
  try {
    await sb('automation_runs', {
      method: 'POST',
      body: JSON.stringify({
        company_id: entry.companyId || null,
        automation: entry.automation,
        outcome: entry.outcome,
        considered: entry.considered || 0,
        queued: entry.queued || 0,
        skipped: entry.skipped || 0,
        detail: entry.detail || {},
        error: entry.error || null,
      }),
    });
  } catch {
    // Bookkeeping must never break the automation it is describing.
  }
}

/**
 * Wraps one runner with the gates, the run record and error containment, so
 * each runner in api/automations.js only has to answer "who should hear from us
 * right now, and what should it say?".
 *
 * `compute(cfg, ctx)` returns { considered, rows } — rows being outbox rows.
 */
export async function runAutomation(key, compute, deps = {}) {
  const companyId = await companyForCron(deps);
  const cfg = await automationConfig(companyId, key, deps);

  if (!cfg.enabled) {
    await recordRun({ companyId, automation: key, outcome: 'skipped_disabled', detail: { reason: cfg._reason || 'toggle-off' } }, deps);
    return {
      ok: true, automation: key, queued: 0, ran: false,
      message: `${key} is switched off on Company Setup${cfg._reason ? ` (${cfg._reason})` : ''} — nothing was queued.`,
    };
  }

  const sendEnabled = await masterSendEnabled(deps);

  let considered = 0;
  let rows = [];
  try {
    const out = await compute(cfg, { companyId, sendEnabled }, deps);
    considered = out.considered || 0;
    rows = out.rows || [];
  } catch (e) {
    await recordRun({ companyId, automation: key, outcome: 'error', error: e.message }, deps);
    return { ok: false, automation: key, error: e.message };
  }

  if (!rows.length) {
    await recordRun({ companyId, automation: key, outcome: 'skipped_no_candidates', considered }, deps);
    return { ok: true, automation: key, ran: true, considered, queued: 0, message: 'No one is due right now.' };
  }

  const { queued, duplicates, tableMissing } = await queueAutomationMessages(
    rows, { automation: key, companyId, sendEnabled }, deps,
  );

  if (tableMissing) {
    return {
      ok: true, automation: key, ran: false, table_missing: true, queued: 0,
      message: 'Automation storage is not set up yet (sql/087 pending) — nothing was queued.',
    };
  }

  await recordRun({
    companyId, automation: key, outcome: 'ran',
    considered, queued, skipped: duplicates,
    detail: { send_enabled: sendEnabled, duplicates },
  }, deps);

  return {
    ok: true, automation: key, ran: true, considered, queued, duplicates,
    send_enabled: sendEnabled,
    message: sendEnabled
      ? `Queued ${queued} message(s) for sending.`
      : `Queued ${queued} message(s) as PREVIEW ONLY — the master send switch is off, so nothing will reach a customer.`,
  };
}
