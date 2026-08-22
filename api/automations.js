// api/automations.js — Vercel serverless function, cron-driven.
//
// The runners behind the Company Setup automation toggles. Each is a cron
// resource; each goes through runAutomation() in _lib/automations.js, which
// enforces both safety gates, records the tick and contains errors.
//
//   GET /api/automations?resource=missed_call_textback     every 5 minutes
//   GET /api/automations?resource=invoice_overdue_nudge    daily
//   GET /api/automations?resource=status                   auth-gated, for the UI
//
// dormant_client_reengage is NOT here. It already had a complete runner
// (api/marketing.js, process_dormant_reactivation_autosend, on a daily cron);
// wiring meant teaching THAT runner to obey the toggle, not writing a second
// one that competes with it.
//
// deposit_releases_pos is NOT here either, and this is deliberate. Its two
// halves have nothing to act on: purchase_orders is empty in production and has
// no "held" lifecycle state to release from, and the readiness gate exists only
// as design prose in api/_lib/brain/*.md — there is no readiness table, flag or
// code. A runner for it would be theatre. The toggle stays visible on Company
// Setup, disabled, saying exactly what it is waiting for.

import { supabaseRequest } from './_lib/jobber.js';
import { requireApiAuth } from './_lib/guard.js';
import { runAutomation, companyForCron, automationConfig, masterSendEnabled, isMissingTable } from './_lib/automations.js';

const MINUTE = 60 * 1000;

function esc(v) { return encodeURIComponent(String(v)); }

async function rows(path) {
  const r = await supabaseRequest(path);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    if (isMissingTable(r.status, text)) return [];
    throw new Error(`${path.split('?')[0]} read failed: ${text}`);
  }
  return await r.json();
}

// Contact details for a set of Jobber client ids, keyed by jobber_id.
async function clientsByIds(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const list = unique.map(esc).join(',');
  const cs = await rows(`clients?jobber_id=in.(${list})&select=jobber_id,name,first_name,last_name,company_name,email,phone_e164,phone`);
  const out = {};
  for (const c of cs) out[c.jobber_id] = c;
  return out;
}

function displayName(c) {
  if (!c) return null;
  return c.name || c.company_name
    || [c.first_name, c.last_name].filter(Boolean).join(' ')
    || null;
}

// ---------------------------------------------------------------------------
// 1. missed_call_textback
// ---------------------------------------------------------------------------
// A caller who did not get through hears nothing back today. This queues one
// SMS per missed inbound call, once per call.
//
// `within_seconds` on the toggle is how quickly the text should follow the call.
// A cron cannot fire 15 seconds after a call, so it is honoured as a DELAY on
// scheduled_for rather than pretended to be a trigger latency: the row is
// queued now, scheduled for call-end + within_seconds. The runner looks back far
// enough to catch calls since the previous tick.
async function computeMissedCallTextbacks(cfg, ctx) {
  const lookbackMs = 30 * MINUTE; // comfortably wider than the 5-minute cron
  const since = new Date(Date.now() - lookbackMs).toISOString();

  const calls = await rows(
    `voice_calls?direction=eq.inbound&status=eq.missed&ended_at=gte.${esc(since)}` +
    '&select=id,from_number,client_id,ended_at,started_at&order=ended_at.desc&limit=200',
  );
  if (!calls.length) return { considered: 0, rows: [] };

  // Never text a number that is on the block list.
  const blocked = new Set(
    (await rows('voice_blocked_numbers?select=number')).map((b) => b.number),
  );

  const byClient = await clientsByIds(calls.map((c) => c.client_id));
  const delayMs = Math.max(0, Number(cfg.within_seconds) || 0) * 1000;

  const out = [];
  for (const call of calls) {
    const to = call.from_number;
    if (!to || blocked.has(to)) continue;

    const client = byClient[call.client_id];
    const who = displayName(client);
    const ended = call.ended_at ? new Date(call.ended_at) : new Date();

    out.push({
      step: 'missed_call_textback',
      channel: 'sms',
      client_id: call.client_id || null,
      recipient_name: who,
      recipient_contact: to,
      subject: null,
      body: (who ? `Hi ${who.split(' ')[0]} — ` : 'Hi — ')
        + 'sorry we missed your call just now. Reply here and we\'ll pick it up right away, '
        + 'or let us know a good time to call you back.',
      // One text per call, forever. The call id is the natural key.
      dedupe_key: `missed_call_textback:${call.id}`,
      scheduled_for: new Date(ended.getTime() + delayMs).toISOString(),
    });
  }
  return { considered: calls.length, rows: out };
}

// ---------------------------------------------------------------------------
// 2. invoice_overdue_nudge
// ---------------------------------------------------------------------------
// Two stages from one toggle: a friendly nudge to the client at
// `first_nudge_days` past due, and an internal escalation at `escalate_days`.
// Each invoice can produce each stage exactly once — that is what the two
// distinct dedupe keys buy, and why a nightly cron does not become a nightly
// pestering.
async function computeInvoiceOverdueNudges(cfg) {
  const firstDays = Number.isFinite(Number(cfg.first_nudge_days)) ? Number(cfg.first_nudge_days) : 3;
  const escDays = Number.isFinite(Number(cfg.escalate_days)) ? Number(cfg.escalate_days) : 10;

  const firstCutoff = new Date(Date.now() - firstDays * 864e5).toISOString();

  // Unpaid = a positive balance. Anything already settled or void is out.
  const invoices = await rows(
    `invoices?due_date=lt.${esc(firstCutoff)}&balance=gt.0` +
    '&select=jobber_id,invoice_number,client_id,due_date,balance,total,invoice_status' +
    '&order=due_date.asc&limit=500',
  );
  if (!invoices.length) return { considered: 0, rows: [] };

  const open = invoices.filter((i) => !/paid|void|cancel/i.test(String(i.invoice_status || '')));
  if (!open.length) return { considered: invoices.length, rows: [] };

  const byClient = await clientsByIds(open.map((i) => i.client_id));
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const out = [];
  for (const inv of open) {
    const daysOver = Math.floor((Date.now() - new Date(inv.due_date).getTime()) / 864e5);
    const client = byClient[inv.client_id];
    const who = displayName(client);
    const label = inv.invoice_number ? `Invoice ${inv.invoice_number}` : 'Your invoice';

    if (daysOver >= escDays) {
      // Internal escalation — to the office, never to the client.
      out.push({
        step: 'invoice_overdue_escalation',
        channel: 'email',
        client_id: inv.client_id || null,
        recipient_name: 'Office',
        recipient_contact: null, // resolved by the processor from the office address
        subject: `Escalation: ${label} is ${daysOver} days overdue`,
        body: `${label} for ${who || 'a client'} is ${daysOver} days past due with ${money(inv.balance)} outstanding. `
          + `It passed the ${escDays}-day escalation threshold. Time for a call.`,
        dedupe_key: `invoice_overdue_escalation:${inv.jobber_id}`,
      });
      continue;
    }

    if (!client || !client.email) continue; // nothing to nudge with
    out.push({
      step: 'invoice_overdue_nudge',
      channel: 'email',
      client_id: inv.client_id || null,
      recipient_name: who,
      recipient_contact: client.email,
      subject: `A friendly reminder about ${label.toLowerCase()}`,
      body: (who ? `Hi ${who.split(' ')[0]},\n\n` : 'Hi,\n\n')
        + `Just a gentle reminder that ${label.toLowerCase()} for ${money(inv.balance)} was due on `
        + `${new Date(inv.due_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}. `
        + 'If it\'s already on its way, thank you — please ignore this note.\n\n'
        + 'If anything about the invoice needs sorting out, just reply here and we\'ll take care of it.',
      dedupe_key: `invoice_overdue_nudge:${inv.jobber_id}`,
    });
  }
  return { considered: open.length, rows: out };
}

// ---------------------------------------------------------------------------
// status — what the UI shows next to each toggle
// ---------------------------------------------------------------------------
async function handleStatus(req, res) {
  const auth = await requireApiAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Not signed in.' });

  const companyId = await companyForCron();
  const sendEnabled = await masterSendEnabled();

  const keys = ['missed_call_textback', 'invoice_overdue_nudge', 'dormant_client_reengage', 'deposit_releases_pos'];
  const status = {};
  for (const k of keys) {
    const cfg = await automationConfig(companyId, k);
    status[k] = { enabled: !!cfg.enabled };
  }
  status.deposit_releases_pos.wired = false;
  status.deposit_releases_pos.blocked_reason =
    'Needs a purchase-order hold state and a readiness gate — neither exists yet.';

  let recent = [];
  let queuedCounts = {};
  try {
    recent = await rows('automation_runs?select=automation,ran_at,outcome,considered,queued,skipped&order=ran_at.desc&limit=20');
    const q = await rows('hl_outbox?automation=not.is.null&select=automation,status');
    for (const row of q) {
      queuedCounts[row.automation] = queuedCounts[row.automation] || { preview: 0, queued: 0, sent: 0 };
      if (queuedCounts[row.automation][row.status] !== undefined) queuedCounts[row.automation][row.status] += 1;
    }
  } catch { /* storage not set up yet */ }

  return res.status(200).json({
    ok: true,
    master_send_enabled: sendEnabled,
    // The single sentence the page needs in order to be honest.
    posture: sendEnabled
      ? 'Automations are live — queued messages will be sent.'
      : 'Preview only — the master send switch is off, so nothing reaches a customer.',
    status, recent_runs: recent, outbox_counts: queuedCounts,
  });
}

// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const resource = (req.query && req.query.resource) || '';

  try {
    if (resource === 'status') return await handleStatus(req, res);

    // The cron surface. Reaching these requires the CRON_SECRET (see the
    // allowlist in _lib/guard.js) — they are not open endpoints.
    if (resource === 'missed_call_textback') {
      const out = await runAutomation('missed_call_textback', computeMissedCallTextbacks);
      return res.status(out.ok ? 200 : 500).json(out);
    }
    if (resource === 'invoice_overdue_nudge') {
      const out = await runAutomation('invoice_overdue_nudge', computeInvoiceOverdueNudges);
      return res.status(out.ok ? 200 : 500).json(out);
    }

    if (resource === 'deposit_releases_pos') {
      return res.status(501).json({
        ok: false, wired: false,
        error: 'deposit_releases_pos has no runner. Purchase orders have no hold state to release from, '
          + 'and the readiness gate is not built — see the note at the top of api/automations.js.',
      });
    }

    return res.status(400).json({ ok: false, error: `Unknown resource "${resource}".` });
  } catch (e) {
    console.error('[api/automations]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export { computeMissedCallTextbacks, computeInvoiceOverdueNudges };
