/* api/reina-action.js
 *
 * The only route through which Reina can change anything.
 *
 * Three operations, in the only order that is safe:
 *
 *   propose  -- Reina turns "email this plan to Allan and Andy" into an actual
 *               draft, and the server records an approval REQUEST. Nothing is
 *               sent. The approval grants nothing; it is a question.
 *   execute  -- the person approved (possibly after editing the draft). The
 *               approval is SPENT first, then the send happens. Spending first
 *               is deliberate: a send that dies half-way must not leave an
 *               approval lying around that could be spent into a second send.
 *   reject   -- the person said no. Terminal.
 *
 * The approval is a row in the database, consumable exactly once, by its owner,
 * before it expires. That is what makes the popup mean something -- a
 * confirmation dialog that exists only in the browser protects nobody, because
 * anything that can reach this route would skip it. Here, there is nothing to
 * skip: without a consumable approval this route does not send.
 *
 * Feature-flagged. REINA_ACTIONS_ENABLED=false takes her hands off everything
 * without a deploy.
 */
import {
  ACTION_KINDS,
  createActionApprovalStore,
  newApprovalId,
  normalizeEmailPayload,
  normalizeSmsPayload,
  requiresApproval,
  sensitivityOf,
} from './_lib/reina/action-approvals.js';
import { requireApiAuth } from './_lib/guard.js';
import { supabaseRequest } from './_lib/jobber.js';
import { twilioRequest, normalizeToE164 } from './_lib/voice.js';

const MODEL = process.env.REINA_ACTION_MODEL || 'gpt-5.6-terra';
const MAX_UTTERANCE = 4_000;
const DRAFT_TIMEOUT_MS = 20_000;
const SMS_THREAD_HISTORY = 12;

const DRAFT_INSTRUCTIONS = [
  'You turn a request into an email draft for a home-services business owner.',
  'Return ONLY JSON: {"to":[],"cc":[],"bcc":[],"subject":"","body":""}.',
  'Every address must be a full email address. If the request names people',
  'without giving full addresses, use the address pattern the user supplied.',
  'Write the body as the owner would: plain text, direct, no marketing voice,',
  'no invented facts, no placeholders like [name] left unfilled.',
  'The person WILL read and edit this before it sends. Write a real draft, not',
  'a template.',
].join(' ');

const SMS_DRAFT_INSTRUCTIONS = [
  'You draft one text-message reply for a home-services business owner,',
  'replying to a real client inside a real SMS thread.',
  'Return ONLY JSON: {"body":""}. Do not include a phone number or "to" field',
  '-- that is resolved separately from real data, never by you.',
  'Use ONLY facts present in the thread you are given. Never invent a time,',
  'price, name, or promise that is not already in the thread -- if the client',
  'asked something you cannot answer from the thread alone, write a reply',
  'that says someone will follow up, not a guessed answer.',
  'Write the way the owner would text: short, plain, friendly, no marketing',
  'voice, no emoji unless the client used one first.',
  'The person WILL read and edit this before it sends. Write a real reply,',
  'not a template.',
].join(' ');

function secure(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}

function enabled(env) {
  if (env.REINA_ACTIONS_ENABLED !== 'true') return false;
  if (env.VERCEL_ENV === 'production') return env.REINA_PILOT_PRODUCTION_ENABLED === 'true';
  return true;
}

function fail(res, status, code, detail) {
  return res.status(status).json({ ok: false, code, ...(detail ? { detail } : {}), executed: false });
}

function safeText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > max) return '';
  return text;
}

function conversationRef(body) {
  const conversationId = safeText(body.conversationId, 128) || 'rp.action';
  const turnId = safeText(body.turnId, 128) || `t.${Date.now().toString(36)}`;
  const ok = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
  return ok.test(conversationId) && ok.test(turnId) ? { conversationId, turnId } : null;
}

// Ask the model for a draft. A draft is not an action -- nothing here can send,
// so a bad draft costs a rejected popup, not a mistake in someone's inbox.
async function draftEmail({ utterance, mailboxes, fetchImpl, apiKey, signal }) {
  const known = mailboxes.map((box) => box.address).join(', ');
  const upstream = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: MODEL,
      instructions: `${DRAFT_INSTRUCTIONS}\nThe sender's own connected addresses are: ${known || 'unknown'}.`,
      input: [{ role: 'user', content: utterance }],
      reasoning: { effort: 'low' },
      max_output_tokens: 2_000,
      store: false,
      safety_identifier: 'reina-hivelogic-action-draft',
    }),
  });
  if (!upstream?.ok || typeof upstream.json !== 'function') {
    console.error('[reina-action] draft call failed', { status: upstream?.status ?? null, model: MODEL });
    return null;
  }
  let payload;
  try { payload = await upstream.json(); } catch { return null; }
  let text = '';
  if (typeof payload?.output_text === 'string') text = payload.output_text;
  if (!text) {
    for (const output of Array.isArray(payload?.output) ? payload.output : []) {
      for (const content of Array.isArray(output?.content) ? output.content : []) {
        if (typeof content?.text === 'string' && content.text.trim()) { text = content.text; break; }
      }
      if (text) break;
    }
  }
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) {
    console.error('[reina-action] draft was not JSON', {
      model: MODEL,
      status: typeof payload?.status === 'string' ? payload.status : null,
      incompleteReason: payload?.incomplete_details?.reason ?? null,
    });
    return null;
  }
  try { return JSON.parse(match[0]); } catch { return null; }
}

function clientDisplayName(c) {
  if (!c) return null;
  return c.name || c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || null;
}

// Everything real that goes into a drafted SMS reply: the client this number
// belongs to (if any) and the real recent history of the thread, oldest
// first. Nothing here is invented -- an unmatched number just means
// `client: null`, and an empty thread just means an empty `history`.
async function loadSmsThreadContext(to) {
  const [clientRes, historyRes] = await Promise.all([
    supabaseRequest(`clients?phone_e164=eq.${encodeURIComponent(to)}&select=jobber_id,name,first_name,last_name,company_name&limit=1`),
    supabaseRequest(`voice_messages?or=(from_number.eq.${encodeURIComponent(to)},to_number.eq.${encodeURIComponent(to)})&select=direction,body,created_at&order=created_at.desc&limit=${SMS_THREAD_HISTORY}`),
  ]);
  const clientRows = clientRes.ok ? await clientRes.json() : [];
  const client = clientRows[0] || null;
  const historyRows = historyRes.ok ? await historyRes.json() : [];
  const history = historyRows.reverse().map((m) => ({ direction: m.direction, body: m.body, at: m.created_at }));
  return {
    clientId: client ? client.jobber_id : null,
    clientName: clientDisplayName(client),
    history,
  };
}

async function draftSms({ to, thread, guidance, fetchImpl, apiKey, signal }) {
  const lines = thread.history.map((m) => `${m.direction === 'inbound' ? 'CLIENT' : 'US'}: ${m.body}`);
  const utterance = [
    thread.clientName ? `Client: ${thread.clientName}` : 'Client: unknown (no matching client record)',
    lines.length ? `Thread so far, oldest first:\n${lines.join('\n')}` : 'Thread so far: (no prior messages)',
    guidance ? `Extra instruction from the office: ${guidance}` : null,
  ].filter(Boolean).join('\n\n');

  const upstream = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: MODEL,
      instructions: SMS_DRAFT_INSTRUCTIONS,
      input: [{ role: 'user', content: utterance }],
      reasoning: { effort: 'low' },
      max_output_tokens: 600,
      store: false,
      safety_identifier: 'reina-hivelogic-action-draft',
    }),
  });
  if (!upstream?.ok || typeof upstream.json !== 'function') {
    console.error('[reina-action] sms draft call failed', { status: upstream?.status ?? null, model: MODEL });
    return null;
  }
  let payload;
  try { payload = await upstream.json(); } catch { return null; }
  let text = '';
  if (typeof payload?.output_text === 'string') text = payload.output_text;
  if (!text) {
    for (const output of Array.isArray(payload?.output) ? payload.output : []) {
      for (const content of Array.isArray(output?.content) ? output.content : []) {
        if (typeof content?.text === 'string' && content.text.trim()) { text = content.text; break; }
      }
      if (text) break;
    }
  }
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

export function createReinaActionHandler({
  env = process.env,
  fetchImpl = fetch,
  storeImpl = null,
  mailImpl = null,
  draftImpl = draftEmail,
  smsDraftImpl = draftSms,
} = {}) {
  return async function handler(req, res) {
    secure(res);
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
    if (!enabled(env)) return fail(res, 503, 'actions_disabled');

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!body) return fail(res, 400, 'invalid_request');

    const store = storeImpl || createActionApprovalStore({ env, fetchImpl });
    const op = safeText(body.op, 32);

    // ---- SMS ops -------------------------------------------------------------
    // Authenticated the same way the rest of HiveLogic Phone is (a Supabase
    // session), not via a connected mailbox -- texting a client has nothing to
    // do with mail.js, and requiring a mailbox would lock out anyone who
    // hasn't connected one.
    if (op === 'propose_sms' || op === 'execute_sms' || op === 'reject_sms') {
      const auth = await requireApiAuth(req, { fetchImpl });
      if (!auth.ok || !auth.user) return fail(res, 401, 'auth_expired');
      const ownerPrincipalId = auth.user.id;

      if (op === 'propose_sms') {
        const to = normalizeToE164(body.to);
        if (!to) return fail(res, 400, 'invalid_request');
        const ref = conversationRef(body);
        if (!ref) return fail(res, 400, 'invalid_request');
        const guidance = safeText(body.guidance, 500);

        const apiKey = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
        if (!apiKey) return fail(res, 503, 'actions_unavailable');

        const thread = await loadSmsThreadContext(to);

        const controller = new AbortController();
        const timer = setTimeout(() => { try { controller.abort(); } catch { /* bounded */ } }, DRAFT_TIMEOUT_MS);
        let raw;
        try {
          raw = await smsDraftImpl({ to, thread, guidance, fetchImpl, apiKey, signal: controller.signal });
        } catch {
          raw = null;
        } finally {
          clearTimeout(timer);
        }
        if (!raw) return fail(res, 502, 'draft_failed');

        const proposal = normalizeSmsPayload({ to, body: raw.body });
        if (!proposal) return fail(res, 422, 'draft_invalid');

        const approvalId = newApprovalId();
        const issued = await store.issue({
          ownerPrincipalId,
          conversationId: ref.conversationId,
          turnId: ref.turnId,
          approvalId,
          actionKind: ACTION_KINDS.SEND_SMS,
          proposal: { ...proposal, clientId: thread.clientId, clientName: thread.clientName },
        });
        if (issued.status !== 'issued') return fail(res, 503, 'approval_unavailable', issued.status);

        return res.status(200).json({
          ok: true,
          executed: false,
          actionKind: ACTION_KINDS.SEND_SMS,
          sensitivity: sensitivityOf(ACTION_KINDS.SEND_SMS),
          needsApproval: requiresApproval(ACTION_KINDS.SEND_SMS),
          approvalId,
          expiresAt: issued.expiresAt,
          proposal,
          clientName: thread.clientName,
        });
      }

      if (op === 'execute_sms') {
        const approvalId = safeText(body.approvalId, 128);
        if (!approvalId) return fail(res, 400, 'invalid_request');
        const payload = normalizeSmsPayload(body.payload);
        if (!payload) return fail(res, 422, 'draft_invalid');

        const consumed = await store.consume({
          ownerPrincipalId,
          approvalId,
          actionKind: ACTION_KINDS.SEND_SMS,
          payload,
        });
        if (consumed.status !== 'consumed') {
          const status = consumed.status === 'expired' ? 410
            : consumed.status === 'duplicate' ? 409
              : consumed.status === 'rejected' ? 409
                : consumed.status === 'not_found' ? 404 : 503;
          return fail(res, status, `approval_${consumed.status}`);
        }
        // The row's OWN recorded kind, not whatever op the caller happened to
        // hit -- an approval issued for a different action can never be spent
        // as an SMS send just because execute_sms is the endpoint called.
        if (consumed.actionKind !== ACTION_KINDS.SEND_SMS) {
          await store.recordOutcome({ ownerPrincipalId, approvalId, outcome: 'failed' });
          return fail(res, 409, 'action_kind_mismatch');
        }

        const numRes = await supabaseRequest('voice_numbers?role=eq.main&active=eq.true&select=e164&limit=1');
        const mainNumber = numRes.ok ? (await numRes.json())[0] : null;
        if (!mainNumber) {
          await store.recordOutcome({ ownerPrincipalId, approvalId, outcome: 'failed' });
          return fail(res, 409, 'no_sms_number');
        }

        let sendOk = false;
        let sid = null;
        try {
          const send = await twilioRequest('Messages.json', {
            method: 'POST',
            body: new URLSearchParams({ From: mainNumber.e164, To: payload.to, Body: payload.body }),
          });
          const sendPayload = await send.json().catch(() => ({}));
          sendOk = send.ok;
          sid = sendPayload.sid || null;
          if (sendOk) {
            await supabaseRequest('voice_messages', {
              method: 'POST',
              body: JSON.stringify({
                direction: 'outbound', from_number: mainNumber.e164, to_number: payload.to,
                body: payload.body, provider_sid: sid, status: sendPayload.status || 'queued',
                origin: 'reina_approved',
              }),
            }).catch(() => {});
          }
        } catch {
          sendOk = false;
        }

        await store.recordOutcome({ ownerPrincipalId, approvalId, outcome: sendOk ? 'sent' : 'failed' });
        if (!sendOk) return fail(res, 502, 'send_failed');
        return res.status(200).json({ ok: true, executed: true, approvalId, to: payload.to, body: payload.body, sid });
      }

      // op === 'reject_sms'
      const approvalId = safeText(body.approvalId, 128);
      if (!approvalId) return fail(res, 400, 'invalid_request');
      const rejected = await store.reject({ ownerPrincipalId, approvalId });
      if (rejected.status !== 'rejected') return fail(res, 404, 'approval_not_found');
      return res.status(200).json({ ok: true, executed: false, approvalId, rejected: true });
    }

    // mail.js is CommonJS and drags in an IMAP client on require. Load it only
    // when this route is genuinely about to use a mailbox, so that tests (and
    // any caller injecting its own mail layer) never pay for it.
    let mailer = mailImpl;
    if (!mailer) {
      try { mailer = (await import('./mail.js')).default; } catch { mailer = null; }
      if (!mailer || typeof mailer.resolveMailUser !== 'function') return fail(res, 503, 'actions_unavailable');
    }

    const user = await mailer.resolveMailUser(req);
    if (!user?.uid) return fail(res, 401, 'auth_expired');

    // ---- propose -----------------------------------------------------------
    if (op === 'propose') {
      const utterance = safeText(body.utterance, MAX_UTTERANCE);
      if (!utterance) return fail(res, 400, 'invalid_request');
      const ref = conversationRef(body);
      if (!ref) return fail(res, 400, 'invalid_request');

      const apiKey = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
      if (!apiKey) return fail(res, 503, 'actions_unavailable');

      const mailboxes = await mailer.mailboxesForUser(user);
      if (!mailboxes.length) return fail(res, 409, 'no_mailbox_connected');

      const controller = new AbortController();
      const timer = setTimeout(() => { try { controller.abort(); } catch { /* bounded */ } }, DRAFT_TIMEOUT_MS);
      let raw;
      try {
        raw = await draftImpl({ utterance, mailboxes, fetchImpl, apiKey, signal: controller.signal });
      } catch {
        raw = null;
      } finally {
        clearTimeout(timer);
      }
      if (!raw) return fail(res, 502, 'draft_failed');

      const proposal = normalizeEmailPayload({ ...raw, from: mailboxes[0].address });
      // A draft that fails validation is a draft problem, not a send problem.
      // Say so plainly rather than issuing an approval for something that could
      // never execute.
      if (!proposal) return fail(res, 422, 'draft_invalid');

      const approvalId = newApprovalId();
      const issued = await store.issue({
        ownerPrincipalId: user.uid,
        conversationId: ref.conversationId,
        turnId: ref.turnId,
        approvalId,
        actionKind: ACTION_KINDS.SEND_EMAIL,
        proposal,
      });
      if (issued.status !== 'issued') return fail(res, 503, 'approval_unavailable', issued.status);

      return res.status(200).json({
        ok: true,
        executed: false,
        actionKind: ACTION_KINDS.SEND_EMAIL,
        sensitivity: sensitivityOf(ACTION_KINDS.SEND_EMAIL),
        needsApproval: requiresApproval(ACTION_KINDS.SEND_EMAIL),
        approvalId,
        expiresAt: issued.expiresAt,
        proposal,
        mailboxes,
      });
    }

    // ---- execute -----------------------------------------------------------
    if (op === 'execute') {
      const approvalId = safeText(body.approvalId, 128);
      if (!approvalId) return fail(res, 400, 'invalid_request');
      const payload = normalizeEmailPayload(body.payload);
      if (!payload) return fail(res, 422, 'draft_invalid');

      // Spend the approval BEFORE sending. If this returns anything other than
      // 'consumed', no send happens -- including when it was already spent,
      // which is what stops a double-click becoming two emails.
      const consumed = await store.consume({
        ownerPrincipalId: user.uid,
        approvalId,
        actionKind: ACTION_KINDS.SEND_EMAIL,
        payload,
      });
      if (consumed.status !== 'consumed') {
        const status = consumed.status === 'expired' ? 410
          : consumed.status === 'duplicate' ? 409
            : consumed.status === 'rejected' ? 409
              : consumed.status === 'not_found' ? 404 : 503;
        return fail(res, status, `approval_${consumed.status}`);
      }

      const sent = await mailer.sendMailForUser({
        uid: user.uid,
        realm: user.realm,
        from: payload.from,
        message: {
          subject: payload.subject,
          body: { contentType: 'text', content: payload.body },
          toRecipients: payload.to.map((address) => ({ emailAddress: { address } })),
          ccRecipients: payload.cc.map((address) => ({ emailAddress: { address } })),
          bccRecipients: payload.bcc.map((address) => ({ emailAddress: { address } })),
        },
      });

      await store.recordOutcome({
        ownerPrincipalId: user.uid,
        approvalId,
        outcome: sent.ok ? 'sent' : 'failed',
      });

      if (!sent.ok) return fail(res, 502, 'send_failed', sent.error);
      return res.status(200).json({
        ok: true,
        executed: true,
        approvalId,
        from: sent.from,
        to: payload.to,
        subject: payload.subject,
      });
    }

    // ---- reject ------------------------------------------------------------
    if (op === 'reject') {
      const approvalId = safeText(body.approvalId, 128);
      if (!approvalId) return fail(res, 400, 'invalid_request');
      const rejected = await store.reject({ ownerPrincipalId: user.uid, approvalId });
      if (rejected.status !== 'rejected') return fail(res, 404, 'approval_not_found');
      return res.status(200).json({ ok: true, executed: false, approvalId, rejected: true });
    }

    return fail(res, 400, 'unknown_op');
  };
}

export const _internals = Object.freeze({ draftEmail, draftSms, enabled, conversationRef, loadSmsThreadContext });

export default createReinaActionHandler();
