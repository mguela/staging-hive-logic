// api/reina/scan-change-requests.js
//
// Reina M1a — scheduled auto-scan. Reads recent inbound email from the
// operator's connected Microsoft 365 mailbox, and for each message that comes
// from a known client on a single open job, runs the observe pipeline. Genuine
// change requests become PENDING recommendations; everything else is skipped.
// When new recommendations are created, the owner is notified to approve them.
//
// OBSERVE-ONLY, and GOVERNED BY DESIGN:
//   Every write is a pending marketing_approvals row a human must approve --
//   the "draft-then-approve" side of the Gate 2 model. This scanner executes
//   NOTHING: no change order, no email, no Jobber write, no money. The
//   reina_guard enforcement point belongs at the *act* step (M1b: turning an
//   approved recommendation into a real change order), not here.
//   A kill-switch seam is honored up front: if the company is emergency-
//   stopped, the scan aborts before reading or writing anything.
//
// SAFETY POSTURE:
//   * Off by default (REINA_M1A_SCAN_ENABLED must be 'true').
//   * Not wired to a cron schedule in vercel.json -- nothing runs unattended
//     until you add the schedule AND flip the flag.
//   * Known-client + single-open-job only; ambiguous/unknown senders are
//     skipped, never guessed, so it can't write a wrong-job recommendation.
//   * Per-message idempotency (the observe core keys on the email's
//     internetMessageId), so a re-scan never duplicates.
//
// MAILBOX SOURCE:
//   * REINA_SCAN_MAILBOX set -> reads that SHARED inbox with an APP token
//     (client-credentials, no user session). This is what makes an unattended
//     cron possible. Requires an Azure APPLICATION Mail.Read grant with admin
//     consent (ideally narrowed to just that mailbox via an Application Access
//     Policy). REINA_MS_TENANT (or MS_TENANT_ID) must be the real tenant.
//   * Otherwise -> reads the CALLER's own mailbox via a delegated token
//     (owner-scoped), so it needs an operator session; a cron with no session
//     reports that cleanly instead of guessing.

import { supabaseRequest as defaultSupabaseRequest } from '../_lib/jobber.js';
import { requireApiAuth } from '../_lib/guard.js';
import { listInboundMessages, listSharedInboxMessages } from './_m365-pull.js';
import { reinaObserveChangeRequest } from './observe-change-request.js';

const OPEN_JOB_EXCLUDED_STATUS = 'archived'; // everything else counts as an open job

// ---- helpers (injectable-friendly, all reads) ----------------------------

// Kill-switch seam. Returns true only if a company is emergency-stopped. Safe
// no-op if the companies table / column doesn't exist yet (Gate 2 not applied).
export async function killSwitchActive({ supabaseRequest }) {
  try {
    const r = await supabaseRequest('companies?select=id&emergency_stopped_at=not.is.null&limit=1');
    if (!r.ok) return false; // table/column absent or unreadable -> treat as not stopped
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

// Resolve a sender email to exactly one open job. Returns
// {jobId, jobTitle, clientId, clientName} or {skip:'reason'}.
export async function resolveClientJob(email, { supabaseRequest }) {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr) return { skip: 'no_sender' };
  const clients = await readJson(supabaseRequest,
    `clients?email=eq.${enc(addr)}&select=jobber_id,name&limit=2`);
  if (!clients.length) return { skip: 'not_a_known_client' };
  if (clients.length > 1) return { skip: 'ambiguous_client' }; // same email on >1 client record
  const client = clients[0];
  const jobs = await readJson(supabaseRequest,
    `jobs?client_id=eq.${enc(client.jobber_id)}&job_status=neq.${enc(OPEN_JOB_EXCLUDED_STATUS)}&select=jobber_id,title,jobber_updated_at&order=jobber_updated_at.desc.nullslast&limit=2`);
  if (!jobs.length) return { skip: 'no_open_job' };
  if (jobs.length > 1) return { skip: 'ambiguous_job' }; // >1 open job -> don't guess
  return { jobId: jobs[0].jobber_id, jobTitle: jobs[0].title, clientId: client.jobber_id, clientName: client.name };
}

// ---- core ----------------------------------------------------------------
export async function scanForChangeRequests(deps = {}) {
  const supabaseRequest = deps.supabaseRequest || defaultSupabaseRequest;
  const listMessages = deps.listMessages; // required; () -> { ok, messages, error?, status? }
  const observe = deps.observe;           // required; (args) -> { status, body }
  const notify = deps.notify;             // optional; (text) -> Promise
  const killSwitch = deps.killSwitch || (() => killSwitchActive({ supabaseRequest }));
  const resolveJob = deps.resolveClientJob || ((email) => resolveClientJob(email, { supabaseRequest }));

  if (await killSwitch()) {
    return { ok: true, aborted: 'kill_switch', scanned: 0, created: 0 };
  }

  const listed = await listMessages();
  if (!listed || !listed.ok) {
    return { ok: false, error: (listed && listed.error) || 'Could not list mailbox messages.', status: (listed && listed.status) || 502 };
  }
  const messages = listed.messages || [];

  const created = [];
  const skips = {}; // reason -> count
  const bump = (r) => { skips[r] = (skips[r] || 0) + 1; };

  for (const msg of messages) {
    if (!msg.text || !msg.text.trim()) { bump('empty_body'); continue; }
    const match = await resolveJob(msg.from);
    if (match.skip) { bump(match.skip); continue; }

    const result = await observe({
      jobId: match.jobId,
      requestText: msg.text,
      requestSource: 'm365_graph',
      messageId: msg.internetMessageId || `${msg.from}:${msg.receivedDateTime}`,
    });
    const body = (result && result.body) || {};
    if (result.status === 201 && body.approval) {
      created.push({ id: body.approval.id, title: body.approval.title, job: match.jobTitle, client: match.clientName });
    } else if (body.idempotent) {
      bump('already_seen');
    } else if (body.skipped && body.reason === 'not_a_change_request') {
      bump('not_a_change_request');
    } else if (result.status >= 400) {
      bump(`error_${result.status}`);
    } else {
      bump('no_write');
    }
  }

  let notified = false;
  if (created.length && typeof notify === 'function') {
    const lines = created.slice(0, 10).map((c) => `• ${c.title}${c.client ? ` (${c.client})` : ''}`).join('\n');
    const more = created.length > 10 ? `\n…and ${created.length - 10} more.` : '';
    const text = `Reina found ${created.length} new client change request${created.length === 1 ? '' : 's'} that need your approval:\n${lines}${more}\n\nReview & approve in Marketing Command Center → Change Requests.`;
    try { await notify(text); notified = true; } catch { notified = false; }
  }

  return { ok: true, scanned: messages.length, created: created.length, createdItems: created, skipped: skips, notified };
}

// ---- Vercel handler ------------------------------------------------------
export default async function handler(req, res) {
  if (process.env.REINA_M1A_SCAN_ENABLED !== 'true') {
    return res.status(200).json({ ok: true, enabled: false, note: 'Reina auto-scan is disabled (set REINA_M1A_SCAN_ENABLED=true).' });
  }
  // GET (cron) or POST (manual) both allowed.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use GET or POST.' });
  }
  const auth = await requireApiAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Authentication required.' });

  const days = Math.min(Math.max(Number((req.query && req.query.days) || 3), 1), 30);
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
  const host = req.headers && req.headers.host;
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';

  // Mailbox source. A configured SHARED inbox (app token, no user session)
  // takes precedence and is what lets a cron run unattended. Otherwise fall
  // back to the caller's OWN mailbox, which needs an operator session -- a
  // cron with no session can't do that, so report it cleanly.
  const sharedMailbox = process.env.REINA_SCAN_MAILBOX;
  let listMessages;
  if (sharedMailbox) {
    listMessages = () => listSharedInboxMessages({ mailbox: sharedMailbox, sinceIso, top: 25 }, {});
  } else if (authHeader && auth.via !== 'cron') {
    listMessages = () => listInboundMessages({ sinceIso, authHeader, host, top: 25 }, {});
  } else {
    return res.status(200).json({ ok: true, enabled: true, ranUnattended: false, note: 'Set REINA_SCAN_MAILBOX to a shared inbox (with app-level Mail.Read admin consent) to scan unattended, or trigger this with an operator session to scan your own mailbox.' });
  }

  let anthropic = null;
  if (process.env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    anthropic = new Anthropic();
  }

  const result = await scanForChangeRequests({
    listMessages,
    observe: (args) => reinaObserveChangeRequest(args, { anthropic }),
    notify: async (text) => {
      const { postBotMessage } = await import('../hiveconnect-bridge.js');
      await postBotMessage(process.env.REINA_BOT_DEFAULT_CHANNEL_ID, text);
    },
  });
  return res.status(result.ok ? 200 : (result.status || 500)).json(result);
}

// ---- small helpers -------------------------------------------------------
function enc(v) { return encodeURIComponent(String(v)); }
async function readJson(supabaseRequest, path) {
  const r = await supabaseRequest(path);
  if (!r.ok) throw new Error(`Supabase read failed for ${path.split('?')[0]}: ${await r.text().catch(() => '')}`);
  return r.json();
}
