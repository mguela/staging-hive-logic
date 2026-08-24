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
  requiresApproval,
  sensitivityOf,
} from './_lib/reina/action-approvals.js';

const MODEL = process.env.REINA_ACTION_MODEL || 'gpt-5.6-terra';
const MAX_UTTERANCE = 4_000;
const DRAFT_TIMEOUT_MS = 20_000;

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

export function createReinaActionHandler({
  env = process.env,
  fetchImpl = fetch,
  storeImpl = null,
  mailImpl = null,
  draftImpl = draftEmail,
} = {}) {
  return async function handler(req, res) {
    secure(res);
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
    if (!enabled(env)) return fail(res, 503, 'actions_disabled');

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

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!body) return fail(res, 400, 'invalid_request');

    const store = storeImpl || createActionApprovalStore({ env, fetchImpl });
    const op = safeText(body.op, 32);

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

export const _internals = Object.freeze({ draftEmail, enabled, conversationRef });

export default createReinaActionHandler();
